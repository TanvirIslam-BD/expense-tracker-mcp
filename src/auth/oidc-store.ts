import { createClient, type Client } from "@libsql/client";
import type { Adapter, AdapterPayload } from "oidc-provider";

/**
 * Durable storage for the OAuth server's own records.
 *
 * oidc-provider's default adapter keeps authorization codes, tokens, sessions,
 * interactions and dynamically registered clients in a process-local Map. That is
 * survivable on a single always-on container and fatal anywhere else: on Vercel
 * (or MCPize's scale-to-zero) the request that starts an authorization is served
 * by one instance and the callback by another, so every sign-in fails with an
 * unrecognised code. A client that registered yesterday is gone today.
 *
 * Everything therefore lives in one table, keyed by (model, id) -- oidc-provider
 * constructs a separate adapter per model, and ids are only unique within one.
 *
 * Schema ownership: the dashboard owns the tables both codebases share
 * (`app_users` and friends). It knows nothing about these, and never reads them,
 * so this file owns `oidc_records` outright.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oidc_records (
    model TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    grant_id TEXT NOT NULL DEFAULT '',
    user_code TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (model, id)
  )`,
  // revokeByGrantId fans out across models, so this one is not (model, ...).
  "CREATE INDEX IF NOT EXISTS idx_oidc_grant ON oidc_records (grant_id)",
  "CREATE INDEX IF NOT EXISTS idx_oidc_uid ON oidc_records (model, uid)",
  "CREATE INDEX IF NOT EXISTS idx_oidc_user_code ON oidc_records (model, user_code)",
  // Lets the opportunistic sweep below find expired rows without a table scan.
  "CREATE INDEX IF NOT EXISTS idx_oidc_expires ON oidc_records (expires_at)",
];

/**
 * Never-expires is stored as '' rather than a far-future date, so it reads as
 * intent rather than as a number someone has to interpret.
 *
 * Only an absent or zero TTL means never — the case for clients and initial
 * access tokens, which must outlive every token issued under them. Any other
 * number is an offset from now, including a negative one: treating that as
 * "eternal" would turn an already-expired record into a permanent credential.
 */
function expiryFrom(expiresIn: number | undefined): string {
  if (!Number.isFinite(Number(expiresIn)) || Number(expiresIn) === 0) return "";
  return new Date(Date.now() + Number(expiresIn) * 1000).toISOString();
}

function parse(payload: unknown): AdapterPayload | undefined {
  try {
    return JSON.parse(String(payload)) as AdapterPayload;
  } catch {
    // A row we cannot read is worse than no row: returning a partial payload
    // would let oidc-provider act on a token it cannot fully verify.
    return undefined;
  }
}

class TursoOidcAdapter implements Adapter {
  constructor(private readonly model: string, private readonly client: Client) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO oidc_records (model,id,payload,grant_id,user_code,uid,expires_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(model,id) DO UPDATE SET
              payload=excluded.payload,
              grant_id=excluded.grant_id,
              user_code=excluded.user_code,
              uid=excluded.uid,
              expires_at=excluded.expires_at`,
      args: [
        this.model,
        id,
        JSON.stringify(payload),
        String(payload.grantId || ""),
        String(payload.userCode || ""),
        String(payload.uid || ""),
        expiryFrom(expiresIn),
      ],
    });
  }

  /**
   * Expiry is enforced here rather than by a cleanup job, because a missed job
   * would mean honouring an expired token. Expired rows are also deleted on the
   * way past, which keeps the table from growing without a scheduler.
   */
  private async findOne(column: "id" | "user_code" | "uid", value: string): Promise<AdapterPayload | undefined> {
    if (!value) return undefined;
    const result = await this.client.execute({
      sql: `SELECT payload,expires_at FROM oidc_records WHERE model = ? AND ${column} = ? LIMIT 1`,
      args: [this.model, value],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    const expiresAt = String(row.expires_at || "");
    if (expiresAt && expiresAt <= new Date().toISOString()) {
      await this.client.execute({
        sql: `DELETE FROM oidc_records WHERE model = ? AND ${column} = ?`,
        args: [this.model, value],
      }).catch(() => {});
      return undefined;
    }
    return parse(row.payload);
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.findOne("id", id);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findOne("user_code", userCode);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findOne("uid", uid);
  }

  /**
   * Marks a record used without deleting it. oidc-provider reads `consumed` back
   * to detect replay -- an authorization code presented twice must be recognised
   * as *already used*, which a deleted row could not distinguish from one that
   * never existed.
   */
  async consume(id: string): Promise<void> {
    const existing = await this.find(id);
    if (!existing) return;
    await this.client.execute({
      sql: "UPDATE oidc_records SET payload = ? WHERE model = ? AND id = ?",
      args: [JSON.stringify({ ...existing, consumed: Math.floor(Date.now() / 1000) }), this.model, id],
    });
  }

  async destroy(id: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM oidc_records WHERE model = ? AND id = ?",
      args: [this.model, id],
    });
  }

  /**
   * Deliberately not scoped to this model. One sign-out or revocation has to take
   * the access token, refresh token and session with it, and those are separate
   * models sharing a grant id -- scoping this would leave live tokens behind.
   */
  async revokeByGrantId(grantId: string): Promise<void> {
    if (!grantId) return;
    await this.client.execute({
      sql: "DELETE FROM oidc_records WHERE grant_id = ?",
      args: [grantId],
    });
  }
}

let schemaPromise: Promise<void> | null = null;

/**
 * Creates the adapter factory oidc-provider expects, and the table it needs.
 *
 * The DDL is issued once per process and awaited by every adapter call, so the
 * first authorization after a cold start cannot race ahead of the schema. A
 * failure clears the cache so the next request retries rather than inheriting a
 * rejected promise forever.
 */
export function createOidcAdapterFactory(url: string, authToken?: string): (model: string) => Adapter {
  const client = createClient({ url, authToken });

  const ready = () => {
    if (!schemaPromise) {
      schemaPromise = client.batch(SCHEMA, "write").then(() => undefined).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  };

  return (model: string) => {
    const adapter = new TursoOidcAdapter(model, client);
    // Every method awaits the schema first. Wrapping here rather than inside each
    // method keeps that guarantee in one place, where it cannot be forgotten when
    // a method is added.
    return new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await ready();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  };
}

/** Test seam: forget the cached DDL promise between in-memory databases. */
export function resetOidcSchemaCacheForTests(): void {
  schemaPromise = null;
}
