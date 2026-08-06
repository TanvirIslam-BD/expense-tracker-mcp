/**
 * MCPize hosts a real OAuth 2.1 authorization server (CIMD client
 * identification, PKCE, an /oauth/token endpoint) transparently at the same
 * public domain as this MCP server — see the companion "Money Copilot"
 * dashboard's `dashboard-authorize.js`, which exchanges an authorization
 * code at `https://<this-app>.mcpize.run/oauth/token`.
 *
 * Confirmed from that same dashboard's `ai-chat.js`: its MCP client sends
 * only `Authorization: Bearer <token>` to /mcp — no identity header — yet
 * this server has always resolved the caller via `x-mcpize-user-id`
 * (util.ts). The only way that works is if MCPize's gateway, sitting in
 * front of this app's public domain, already validates the bearer token
 * and injects `x-mcpize-user-id` before the request reaches this Express
 * app. That means this server does NOT need to re-validate the token
 * itself — the legacy header-based `resolveUserId()` path already is the
 * real, working end-to-end mechanism for MCPize-hosted traffic.
 *
 * What this module actually provides is just the RFC 9728 discovery
 * pointer: telling Claude (or any MCP OAuth client) which authorization
 * server issued tokens for this resource, so it knows where to start the
 * OAuth flow. `PUBLIC_BASE_URL` already exists in this repo (used for email
 * asset links) and is this app's own public origin — the correct default
 * issuer, since each MCPize-hosted app is its own OAuth issuer. Override
 * with MCPIZE_OAUTH_ISSUER only if MCPize's actual issuer differs from this
 * app's public URL (e.g. a shared platform-level issuer) — confirm with
 * MCPize before relying on that.
 */
export function mcpizeAuthorizationServerIssuers(): string[] {
  const issuer = process.env.MCPIZE_OAUTH_ISSUER || process.env.PUBLIC_BASE_URL;
  return issuer ? [issuer.replace(/\/$/, "")] : [];
}
