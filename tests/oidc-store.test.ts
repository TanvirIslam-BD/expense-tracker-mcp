import { describe, it, expect, beforeEach } from "vitest";
import { createOidcAdapterFactory, resetOidcSchemaCacheForTests } from "../src/auth/oidc-store.js";
import type { Adapter } from "oidc-provider";

/*
 * Exercised against a real libSQL database rather than a stub, because what this
 * adapter has to get right is SQL: the composite key, the per-model scoping, the
 * expiry comparison, and the cross-model grant revoke. A hand-written fake would
 * agree with whatever the implementation did.
 */
let factory: (model: string) => Adapter;

beforeEach(() => {
  resetOidcSchemaCacheForTests();
  // A fresh in-memory database per test, so nothing leaks between them.
  factory = createOidcAdapterFactory("file::memory:");
});

describe("OIDC records survive where a Map would not", () => {
  it("stores and returns a payload", async () => {
    const codes = factory("AuthorizationCode");
    await codes.upsert("code-1", { accountId: "u_abc", redirectUri: "https://claude.ai/cb" }, 600);
    expect(await codes.find("code-1")).toMatchObject({ accountId: "u_abc" });
  });

  it("creates its schema on first use, without a migration step", async () => {
    // The first authorization after a cold start must not race the DDL.
    const sessions = factory("Session");
    await expect(sessions.find("nothing-yet")).resolves.toBeUndefined();
  });

  it("keeps ids from different models apart", async () => {
    // oidc-provider only guarantees id uniqueness within a model, so a shared
    // table keyed on id alone would let a Session shadow an AccessToken.
    const a = factory("AccessToken");
    const b = factory("RefreshToken");
    await a.upsert("same-id", { accountId: "access" }, 600);
    await b.upsert("same-id", { accountId: "refresh" }, 600);
    expect(await a.find("same-id")).toMatchObject({ accountId: "access" });
    expect(await b.find("same-id")).toMatchObject({ accountId: "refresh" });
  });

  it("updates an existing record rather than duplicating it", async () => {
    const sessions = factory("Session");
    await sessions.upsert("s1", { accountId: "first" }, 600);
    await sessions.upsert("s1", { accountId: "second" }, 600);
    expect(await sessions.find("s1")).toMatchObject({ accountId: "second" });
  });
});

describe("lookups oidc-provider relies on", () => {
  it("finds a session by uid", async () => {
    const sessions = factory("Session");
    await sessions.upsert("s1", { uid: "uid-1", accountId: "u_abc" }, 600);
    expect(await sessions.findByUid("uid-1")).toMatchObject({ accountId: "u_abc" });
    expect(await sessions.findByUid("uid-missing")).toBeUndefined();
  });

  it("finds a device code by user code", async () => {
    const codes = factory("DeviceCode");
    await codes.upsert("d1", { userCode: "WDJB-MJHT", accountId: "u_abc" }, 600);
    expect(await codes.findByUserCode("WDJB-MJHT")).toMatchObject({ accountId: "u_abc" });
  });

  it("does not match an empty uid or user code against blank rows", async () => {
    // Most records store '' for these, so a blank lookup must not match them all.
    const sessions = factory("Session");
    await sessions.upsert("s1", { accountId: "u_abc" }, 600);
    expect(await sessions.findByUid("")).toBeUndefined();
    expect(await sessions.findByUserCode("")).toBeUndefined();
  });
});

describe("expiry", () => {
  it("refuses an expired record instead of honouring it", async () => {
    const codes = factory("AuthorizationCode");
    await codes.upsert("stale", { accountId: "u_abc" }, -1);
    expect(await codes.find("stale")).toBeUndefined();
  });

  it("keeps a record with no expiry, which is how clients persist", async () => {
    // A dynamically registered client must outlive every token issued under it.
    const clients = factory("Client");
    await clients.upsert("client-1", { client_id: "client-1" }, 0);
    expect(await clients.find("client-1")).toMatchObject({ client_id: "client-1" });
  });
});

describe("consume and revoke", () => {
  it("marks a code consumed rather than deleting it", async () => {
    /*
     * Replay detection needs to tell "already used" from "never existed". A
     * deleted row cannot, so a second presentation of a spent code would look
     * like an unknown code and produce the wrong error.
     */
    const codes = factory("AuthorizationCode");
    await codes.upsert("code-1", { accountId: "u_abc" }, 600);
    await codes.consume("code-1");
    const found = await codes.find("code-1");
    expect(found).toBeDefined();
    expect(typeof found!.consumed).toBe("number");
  });

  it("destroys a single record", async () => {
    const tokens = factory("AccessToken");
    await tokens.upsert("t1", { accountId: "u_abc" }, 600);
    await tokens.destroy("t1");
    expect(await tokens.find("t1")).toBeUndefined();
  });

  it("revokes every model sharing a grant, not just its own", async () => {
    /*
     * One revocation has to take the access token, refresh token and session with
     * it. Scoping this to the calling model would leave live tokens behind after
     * a sign-out that reported success.
     */
    const access = factory("AccessToken");
    const refresh = factory("RefreshToken");
    const other = factory("AccessToken");
    await access.upsert("a1", { grantId: "g1" }, 600);
    await refresh.upsert("r1", { grantId: "g1" }, 600);
    await other.upsert("a2", { grantId: "g2" }, 600);

    await access.revokeByGrantId("g1");

    expect(await access.find("a1")).toBeUndefined();
    expect(await refresh.find("r1")).toBeUndefined();
    expect(await other.find("a2")).toMatchObject({ grantId: "g2" });
  });

  it("ignores a blank grant id rather than deleting every blank row", async () => {
    const tokens = factory("AccessToken");
    await tokens.upsert("t1", { accountId: "u_abc" }, 600);
    await tokens.revokeByGrantId("");
    expect(await tokens.find("t1")).toBeDefined();
  });

  it("consuming something already gone is a no-op, not a crash", async () => {
    const codes = factory("AuthorizationCode");
    await expect(codes.consume("never-existed")).resolves.toBeUndefined();
  });
});
