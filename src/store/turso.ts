import { createClient, type Client } from "@libsql/client";
import { newId } from "../util.js";
import { EMPTY_FINANCE_STATE } from "./types.js";
import type {
  AggregateGroup,
  AggregateOptions,
  Budget,
  Expense,
  ExpenseFilter,
  ExpensePatch,
  ExpenseStore,
  FinanceState,
  NewBudget,
  NewExpense,
} from "./types.js";

/**
 * SQLite/libSQL-backed store. Works identically against:
 *  - a local file (`file:./data.db`) or in-memory DB (`file::memory:`) for
 *    dependency-free local dev and tests, or
 *  - a remote Turso database (`libsql://...`, with an auth token) for durable
 *    storage across process restarts and multiple instances.
 *
 * This is the fix for MemoryStore's core limitation on serverless hosting
 * (MCPize/Cloud Run "scale to zero"): an in-process Map is wiped whenever the
 * instance is recycled. A real database survives that, because it lives
 * outside the process.
 */
export class TursoStore implements ExpenseStore {
  private readonly client: Client;

  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, authToken });
  }

  async init(): Promise<void> {
    // Run all schema statements in a single round trip. On a cold start the DB
    // may be a cross-region hop, so collapsing 3 sequential round trips into 1
    // meaningfully cuts the first-request latency after a scale-to-zero wake.
    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses (user_id, date)",
        `CREATE TABLE IF NOT EXISTS budgets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category TEXT,
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          period TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (user_id, category)
        )`,
        // SQLite treats NULL values as distinct in a normal UNIQUE constraint.
        // This expression index makes the overall (NULL-category) scope unique
        // too, so concurrent upserts cannot create duplicate overall budgets.
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_user_scope ON budgets (user_id, IFNULL(category, ''))",
        `CREATE TABLE IF NOT EXISTS finance_state (
          user_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS app_users (
          user_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL DEFAULT '',
          profile_photo_url TEXT NOT NULL DEFAULT '',
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS owner_user_controls (
          user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'active',
          reason TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS app_activity (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source TEXT NOT NULL,
          event_type TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS idx_app_activity_created ON app_activity (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_app_activity_user ON app_activity (user_id, created_at DESC)",
      ],
      "write",
    );

    // Warm the connection while we're already awaiting boot: this first round
    // trip pays the TLS/handshake + (on a remote Turso) any cross-region setup,
    // so the first *user* request after a scale-to-zero wake is already hot.
    // Runs off the request path (init() is awaited before the server listens).
    try {
      await this.client.execute("SELECT 1");
    } catch {
      // A failed warm-up is non-fatal — the real query will surface any error.
    }
  }

  async getUserAccessStatus(userId: string): Promise<"active" | "suspended"> {
    const result = await this.client.execute({
      sql: "SELECT status FROM owner_user_controls WHERE user_id = ?",
      args: [userId],
    });
    return String(result.rows[0]?.status || "active") === "suspended" ? "suspended" : "active";
  }

  /**
   * Whether the dashboard already holds a name and a contact address.
   *
   * `chosen_display_name` is the name the user typed for themselves and
   * `display_name` is whatever was resolved from MCPize; either counts. The email
   * can only have come from the user, since MCPize exposes no email column.
   *
   * Both columns are added by the dashboard's own migration, so a database that
   * predates it will error here -- and that is reported as "has details", because
   * an unreachable or older database must not put a nag on every tool result.
   */
  async hasContactDetails(userId: string): Promise<boolean> {
    try {
      const result = await this.client.execute({
        sql: `SELECT COALESCE(NULLIF(chosen_display_name,''), display_name, '') AS name, COALESCE(email,'') AS email
              FROM app_users WHERE user_id = ? LIMIT 1`,
        args: [userId],
      });
      const row = result.rows[0];
      if (!row) return false;
      return Boolean(String(row.name || "").trim()) && Boolean(String(row.email || "").trim());
    } catch {
      return true;
    }
  }

  async recordActivity(userId: string, source: string, eventType: string, detail: Record<string, unknown> = {}): Promise<void> {
    const now = new Date().toISOString();
    let encoded = "{}";
    try { encoded = JSON.stringify(detail).slice(0, 2000); } catch { encoded = "{}"; }
    await this.client.batch([
      {
        sql: `INSERT INTO app_users (user_id,display_name,profile_photo_url,first_seen_at,last_seen_at)
              VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
        args: [userId, "", "", now, now],
      },
      {
        sql: "INSERT INTO app_activity (id,user_id,source,event_type,detail,created_at) VALUES (?,?,?,?,?,?)",
        args: [newId(), userId, source.slice(0, 40), eventType.slice(0, 80), encoded, now],
      },
    ], "write");
  }

  private rowToExpense(row: Record<string, unknown>): Expense {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      amountMinor: Number(row.amount_minor),
      currency: row.currency as string,
      category: row.category as string,
      description: row.description as string,
      date: row.date as string,
      createdAt: row.created_at as string,
    };
  }

  private rowToBudget(row: Record<string, unknown>): Budget {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      category: (row.category as string | null) ?? null,
      amountMinor: Number(row.amount_minor),
      currency: row.currency as string,
      period: row.period as "monthly",
      createdAt: row.created_at as string,
    };
  }

  async addExpense(input: NewExpense): Promise<Expense> {
    const expense: Expense = {
      ...input,
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    await this.client.execute({
      sql: `INSERT INTO expenses
              (id, user_id, amount_minor, currency, category, description, date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        expense.id,
        expense.userId,
        expense.amountMinor,
        expense.currency,
        expense.category,
        expense.description,
        expense.date,
        expense.createdAt,
      ],
    });
    return expense;
  }

  async addExpenses(inputs: NewExpense[]): Promise<Expense[]> {
    const now = new Date().toISOString();
    const created: Expense[] = inputs.map((input) => ({
      ...input,
      id: newId(),
      createdAt: now,
    }));
    if (created.length === 0) return [];

    // One round trip for the whole batch (transactional) rather than N inserts.
    await this.client.batch(
      created.map((e) => ({
        sql: `INSERT INTO expenses
                (id, user_id, amount_minor, currency, category, description, date, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          e.id,
          e.userId,
          e.amountMinor,
          e.currency,
          e.category,
          e.description,
          e.date,
          e.createdAt,
        ],
      })),
      "write",
    );
    return created;
  }

  async getExpense(userId: string, id: string): Promise<Expense | null> {
    const r = await this.client.execute({
      sql: "SELECT * FROM expenses WHERE user_id = ? AND id = ?",
      args: [userId, id],
    });
    return r.rows.length ? this.rowToExpense(r.rows[0] as unknown as Record<string, unknown>) : null;
  }

  async listExpenses(userId: string, filter: ExpenseFilter = {}): Promise<Expense[]> {
    const clauses = ["user_id = ?"];
    const args: (string | number)[] = [userId];

    if (filter.category) {
      clauses.push("category = ?");
      args.push(filter.category.trim().toLowerCase());
    }
    if (filter.from) {
      clauses.push("date >= ?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("date <= ?");
      args.push(filter.to);
    }
    if (filter.search) {
      clauses.push("(lower(description) LIKE ? OR lower(category) LIKE ?)");
      const like = `%${filter.search.trim().toLowerCase()}%`;
      args.push(like, like);
    }

    // Newest first: date, then created_at, then rowid — rowid strictly
    // increases with insertion order, giving a deterministic tiebreak for
    // same-day/same-timestamp expenses (mirrors MemoryStore's ordering).
    let sql = `SELECT * FROM expenses WHERE ${clauses.join(" AND ")}
               ORDER BY date DESC, created_at DESC, rowid DESC`;
    if (filter.limit != null) {
      sql += " LIMIT ?";
      args.push(filter.limit);
      if (filter.offset != null) {
        sql += " OFFSET ?";
        args.push(filter.offset);
      }
    }

    const r = await this.client.execute({ sql, args });
    return r.rows.map((row) => this.rowToExpense(row as unknown as Record<string, unknown>));
  }

  async updateExpense(
    userId: string,
    id: string,
    patch: ExpensePatch,
  ): Promise<Expense | null> {
    // Single round trip: COALESCE keeps any field the caller omitted (passed as
    // NULL), and RETURNING hands back the updated row — so we skip the separate
    // SELECT-then-UPDATE that doubled latency on remote (cross-region) Turso.
    const r = await this.client.execute({
      sql: `UPDATE expenses SET
              amount_minor = COALESCE(?, amount_minor),
              currency     = COALESCE(?, currency),
              category     = COALESCE(?, category),
              description  = COALESCE(?, description),
              date         = COALESCE(?, date)
            WHERE user_id = ? AND id = ?
            RETURNING *`,
      args: [
        patch.amountMinor ?? null,
        patch.currency ?? null,
        patch.category ?? null,
        patch.description ?? null,
        patch.date ?? null,
        userId,
        id,
      ],
    });
    return r.rows.length
      ? this.rowToExpense(r.rows[0] as unknown as Record<string, unknown>)
      : null;
  }

  async deleteExpense(userId: string, id: string): Promise<boolean> {
    const r = await this.client.execute({
      sql: "DELETE FROM expenses WHERE user_id = ? AND id = ?",
      args: [userId, id],
    });
    return r.rowsAffected > 0;
  }

  async aggregate(
    userId: string,
    opts: AggregateOptions,
  ): Promise<AggregateGroup[]> {
    // Group + sum in the database (GROUP BY key, currency) so the payload is
    // O(groups) rather than O(rows) — no full-history fetch to aggregate in JS.
    const keyExpr = opts.groupBy === "month" ? "substr(date, 1, 7)" : "category";
    const clauses = ["user_id = ?"];
    const args: (string | number)[] = [userId];
    if (opts.from) {
      clauses.push("date >= ?");
      args.push(opts.from);
    }
    if (opts.to) {
      clauses.push("date <= ?");
      args.push(opts.to);
    }
    const r = await this.client.execute({
      sql: `SELECT ${keyExpr} AS k, currency AS cur,
                   COUNT(*) AS c, SUM(amount_minor) AS s
            FROM expenses WHERE ${clauses.join(" AND ")}
            GROUP BY k, cur`,
      args,
    });

    const map = new Map<string, AggregateGroup>();
    for (const row of r.rows as unknown as Record<string, unknown>[]) {
      const key = String(row.k);
      const cur = String(row.cur);
      const g = map.get(key) ?? { key, count: 0, totals: {} };
      g.count += Number(row.c);
      g.totals[cur] = (g.totals[cur] ?? 0) + Number(row.s);
      map.set(key, g);
    }
    return [...map.values()];
  }

  async setBudget(input: NewBudget): Promise<Budget> {
    const budget: Budget = {
      id: newId(),
      userId: input.userId,
      category: input.category,
      amountMinor: input.amountMinor,
      currency: input.currency,
      period: "monthly",
      createdAt: new Date().toISOString(),
    };
    // One atomic UPSERT protects both category and overall (NULL-category)
    // budgets across concurrent Cloud Run instances.
    const result = await this.client.execute({
      sql: `INSERT INTO budgets (id, user_id, category, amount_minor, currency, period, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO UPDATE SET amount_minor = excluded.amount_minor,
                                      currency = excluded.currency
            RETURNING *`,
      args: [
        budget.id,
        budget.userId,
        budget.category,
        budget.amountMinor,
        budget.currency,
        budget.period,
        budget.createdAt,
      ],
    });
    return this.rowToBudget(result.rows[0] as unknown as Record<string, unknown>);
  }

  async listBudgets(userId: string): Promise<Budget[]> {
    const r = await this.client.execute({
      sql: "SELECT * FROM budgets WHERE user_id = ?",
      args: [userId],
    });
    return r.rows.map((row) => this.rowToBudget(row as unknown as Record<string, unknown>));
  }

  async deleteBudget(userId: string, id: string): Promise<boolean> {
    const r = await this.client.execute({
      sql: "DELETE FROM budgets WHERE user_id = ? AND id = ?",
      args: [userId, id],
    });
    return r.rowsAffected > 0;
  }

  async getFinanceState(userId: string): Promise<FinanceState> {
    const result = await this.client.execute({
      sql: "SELECT data FROM finance_state WHERE user_id = ?",
      args: [userId],
    });
    if (!result.rows.length) return structuredClone(EMPTY_FINANCE_STATE);
    try {
      return { ...structuredClone(EMPTY_FINANCE_STATE), ...JSON.parse(String(result.rows[0].data)) } as FinanceState;
    } catch {
      return structuredClone(EMPTY_FINANCE_STATE);
    }
  }

  async setFinanceState(userId: string, state: FinanceState): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO finance_state (user_id, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      args: [userId, JSON.stringify(state), new Date().toISOString()],
    });
  }

  async deleteAllUserData(userId: string): Promise<{ expensesDeleted: number; budgetsDeleted: number }> {
    // One atomic batch so a mid-delete failure can't leave expenses gone but
    // budgets/finance_state still present (or vice versa).
    const [expensesResult, budgetsResult] = await this.client.batch(
      [
        { sql: "DELETE FROM expenses WHERE user_id = ?", args: [userId] },
        { sql: "DELETE FROM budgets WHERE user_id = ?", args: [userId] },
        { sql: "DELETE FROM finance_state WHERE user_id = ?", args: [userId] },
      ],
      "write",
    );
    return { expensesDeleted: Number(expensesResult.rowsAffected), budgetsDeleted: Number(budgetsResult.rowsAffected) };
  }

  /** Releases the underlying connection/file handle. Mainly useful for tests. */
  close(): void {
    this.client.close();
  }
}
