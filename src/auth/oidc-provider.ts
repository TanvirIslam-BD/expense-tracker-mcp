import Provider from "oidc-provider";
import { createHash } from "node:crypto";
import { createOidcAdapterFactory } from "./oidc-store.js";
import { resolveTursoConfig } from "../util.js";

/**
 * Stable per-email account id for an OAuth-authenticated user.
 *
 * This deliberately no longer shares a derivation with the API-token fallback in
 * util.ts. Both were `"u_" + sha256(input)`, and the intent was that an
 * API-key client and an OAuth user with the same underlying identity would land
 * in one bucket. The effect was an authentication bypass: the API-token path
 * hashed the raw `Authorization` header, so sending `Authorization:
 * victim@example.com` derived that victim's OAuth id exactly, and knowing an
 * email address was enough to read and write their finances.
 *
 * The two spaces are now separated by prefix and by hash domain. Nothing else
 * may be keyed into the "u_" space from caller-controlled input.
 */
export function deriveOAuthUserId(email: string): string {
  return "u_" + createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** Shared with index.ts so the Express mount path always matches the issuer's path segment. */
export const OIDC_MOUNT_PATH = "/oidc";

let provider: Provider | null = null;

/**
 * Minimal OAuth 2.1 / OIDC authorization server for the `oauth_anthropic_creds`
 * connector flow: a single static client (Anthropic's own), email
 * magic-link login (see oidc-routes.ts), and auto-granted consent — the
 * user-facing consent screen is Claude's own, shown before it ever reaches
 * this server.
 *
 * Records are persisted to the same libSQL/Turso database as the expense data
 * whenever TURSO_DATABASE_URL is set — see oidc-store.ts. Without it, this falls
 * back to oidc-provider's in-memory adapter, which is usable for local
 * development and nothing else: codes, tokens, sessions and registered clients
 * do not survive a restart or reach a second instance.
 */
export function getOidcProvider(): Provider {
  if (provider) return provider;

  // oidc-provider's callback() is a self-contained Koa app that 404s any
  // request outside its own routes — mounting it at the Express root would
  // swallow /mcp, /health, etc. Giving the issuer a /oidc path segment and
  // mounting the callback at that same prefix (see index.ts) keeps its
  // routes (and the well-known discovery documents) scoped there instead.
  const issuer = `${(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, "")}${OIDC_MOUNT_PATH}`;
  const redirectUris = (process.env.OAUTH_REDIRECT_URIS || "https://claude.ai/api/mcp/auth_callback")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!process.env.OAUTH_CLIENT_ID) {
    console.error(
      "[oidc] OAUTH_CLIENT_ID is not set — no OAuth client is registered, so every " +
        "authorization request will be rejected. Set OAUTH_CLIENT_ID (and " +
        "OAUTH_CLIENT_SECRET if using a confidential client) before enabling this flow.",
    );
  }

  /*
   * Durable storage wherever a database is configured.
   *
   * Without this, oidc-provider keeps codes, tokens, sessions and dynamically
   * registered clients in a process-local Map -- so on any host that runs more
   * than one instance, or recycles them, the request that starts an
   * authorization and the one that completes it do not share state and every
   * sign-in fails. The in-memory default is left in place only for local dev,
   * where a single process serves the whole flow, and it says so loudly.
   */
  const turso = resolveTursoConfig();
  if (!turso) {
    console.error(
      "[oidc] no TURSO_DATABASE_URL — authorization codes, tokens, sessions and " +
        "registered clients will be kept in memory and lost on restart. Fine for " +
        "local development; sign-in will fail on any multi-instance or " +
        "scale-to-zero host.",
    );
  }

  provider = new Provider(issuer, {
    ...(turso ? { adapter: createOidcAdapterFactory(turso.url, turso.authToken) } : {}),
    clients: process.env.OAUTH_CLIENT_ID
      ? [
          {
            client_id: process.env.OAUTH_CLIENT_ID,
            client_secret: process.env.OAUTH_CLIENT_SECRET,
            token_endpoint_auth_method: process.env.OAUTH_CLIENT_SECRET ? "client_secret_basic" : "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            redirect_uris: redirectUris,
          },
        ]
      : [],
    pkce: { required: () => true },
    scopes: ["openid", "offline_access", "expenses"],
    claims: { openid: ["sub"] },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      rpInitiatedLogout: { enabled: false },
    },
    ttl: {
      AccessToken: 60 * 60,
      AuthorizationCode: 10 * 60,
      RefreshToken: 30 * 24 * 60 * 60,
    },
    interactions: {
      url(_ctx, interaction) {
        return `/oauth/interaction/${interaction.uid}`;
      },
    },
    async findAccount(_ctx, sub) {
      return { accountId: sub, claims: () => ({ sub }) };
    },
  });

  // Behind MCPize / Cloud Run's reverse proxy, the raw request is HTTP even
  // when the client connected over HTTPS — oidc-provider needs the real
  // scheme (from x-forwarded-proto) to build correct issuer-relative URLs.
  provider.proxy = true;

  return provider;
}

/**
 * Validates a bearer token against this server's own authorization server
 * and returns the account id it was issued to, or null if the token is
 * missing, malformed, expired, or was never issued by this AS. Unlike the
 * legacy `resolveUserId` header/hash fallback, this never invents an
 * identity for an unrecognized value — an OAuth-issued token is either
 * valid or it isn't.
 */
export async function resolveOAuthUserId(authorizationHeader: string | undefined): Promise<string | null> {
  const token = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  try {
    const accessToken = await getOidcProvider().AccessToken.find(token);
    return accessToken?.accountId ?? null;
  } catch (error) {
    console.error("[oidc] access token validation failed:", error);
    return null;
  }
}
