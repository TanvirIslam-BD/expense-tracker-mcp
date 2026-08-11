import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveUserId, gatewayIdentityTrusted, deriveApiTokenUserId } from "../src/util.js";
import { deriveOAuthUserId } from "../src/auth/oidc-provider.js";

/** Minimal Express-like request: only `header()` is used by resolveUserId. */
function request(headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()] } as any;
}

const ENV_KEYS = ["TRUST_GATEWAY_IDENTITY_HEADERS", "DEFAULT_USER_ID"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/*
 * Both of these were exploitable the moment this server answered on a public URL
 * rather than sitting behind MCPize's gateway. They are the reason the trust flag
 * exists, so they are pinned as tests rather than left to a comment.
 */
describe("identity cannot be forged by a caller", () => {
  it("ignores identity headers unless the deployment declares them trusted", () => {
    // `x-user-id: <someone>` would otherwise hand over that person's entire
    // financial history with no token at all.
    for (const name of ["x-mcpize-user-id", "x-mcpize-user", "x-user-id"]) {
      expect(resolveUserId(request({ [name]: "a8b3a6f6-1d11-4c6f-ab8b-c102c6aa15eb" })), name).toBeNull();
    }
  });

  it("defaults to not trusting them, so a new deployment is safe before it is configured", () => {
    expect(gatewayIdentityTrusted()).toBe(false);
    process.env.TRUST_GATEWAY_IDENTITY_HEADERS = "1";
    expect(gatewayIdentityTrusted()).toBe(true);
    for (const value of ["0", "", "true", "yes"]) {
      process.env.TRUST_GATEWAY_IDENTITY_HEADERS = value;
      expect(gatewayIdentityTrusted(), `"${value}" must not enable trust`).toBe(false);
    }
  });

  it("does not derive an account from an Authorization header when untrusted", () => {
    // Otherwise any bearer string mints an account on a publicly promoted server.
    expect(resolveUserId(request({ authorization: "Bearer anything" }))).toBeNull();
    expect(resolveUserId(request({ "x-api-key": "anything" }))).toBeNull();
  });

  it("never lets an API token land in the OAuth namespace", () => {
    /*
     * The bypass: both spaces were "u_" + sha256(input), and the API-token path
     * hashed the raw Authorization header — so `Authorization: victim@example.com`
     * derived that victim's OAuth id exactly. An email address was full access.
     */
    const email = "victim@example.com";
    expect(deriveApiTokenUserId(email)).not.toBe(deriveOAuthUserId(email));
    expect(deriveApiTokenUserId(email).startsWith("k_")).toBe(true);
    expect(deriveOAuthUserId(email).startsWith("u_")).toBe(true);
    // Also with the casing and whitespace variants the two functions normalise.
    for (const variant of [" victim@example.com", "VICTIM@EXAMPLE.COM", "Victim@Example.com "]) {
      expect(deriveApiTokenUserId(variant)).not.toBe(deriveOAuthUserId(email));
    }
  });
});

describe("trusted deployments keep working", () => {
  beforeEach(() => { process.env.TRUST_GATEWAY_IDENTITY_HEADERS = "1"; });

  it("honours the gateway's subscriber id, in priority order", () => {
    expect(resolveUserId(request({ "x-mcpize-user-id": "sub-1" }))).toBe("sub-1");
    expect(resolveUserId(request({ "x-mcpize-user-id": "sub-1", "x-user-id": "sub-2" }))).toBe("sub-1");
    expect(resolveUserId(request({ "x-user-id": "sub-3" }))).toBe("sub-3");
  });

  it("still derives a stable id for a fixed API token", () => {
    const first = resolveUserId(request({ authorization: "Bearer token-a" }));
    expect(first).toBe(resolveUserId(request({ authorization: "Bearer token-a" })));
    expect(first).not.toBe(resolveUserId(request({ authorization: "Bearer token-b" })));
    expect(first?.startsWith("k_")).toBe(true);
  });

  it("fails closed when there is no identity at all", () => {
    expect(resolveUserId(request({}))).toBeNull();
  });
});

describe("single-user self-hosting", () => {
  it("still works untrusted, because the operator declared the identity", () => {
    // DEFAULT_USER_ID is the operator naming the user, not a caller claiming to be one.
    process.env.DEFAULT_USER_ID = "solo";
    expect(resolveUserId(request({}))).toBe("solo");
    // And a forged header must not override it.
    expect(resolveUserId(request({ "x-user-id": "someone-else" }))).toBe("solo");
  });
});
