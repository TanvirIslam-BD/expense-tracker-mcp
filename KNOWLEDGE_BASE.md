# Expense Tracker MCP — Knowledge Base

The single authoritative reference for this project: what it is, how it's built,
every non-obvious decision, the incidents we hit and how they were resolved, and
what's still open. If you're an AI agent or a developer picking this up cold,
read this first. The [README](./README.md) is the user-facing overview; this
file is the deep context behind it.

> **Secrets note:** No credentials appear in this file. The Turso auth token
> lives only in the git-ignored `.env` (local) and the MCPize dashboard secret
> (production). If you ever see a token committed anywhere, rotate it.

---

## 1. What this is

A personal **expense tracker** [Model Context Protocol](https://modelcontextprotocol.io)
server in TypeScript, published to the [MCPize](https://mcpize.com) marketplace.
Users talk to it through an MCP client (Claude, ChatGPT, Cursor, VS Code, …) in
natural language — "add a $12.50 lunch", "how much did I spend this month?",
"log this receipt" — and it records expenses, tracks monthly budgets, and
produces spending summaries.

There is **no UI** in this project. MCP tool calls render however the host
client chooses. The images in `assets/` are hand-authored mockups of those
clients, not screenshots of an app we built (see §9).

---

## 2. Coordinates & links

| Thing | Value |
| --- | --- |
| GitHub repo | https://github.com/TanvirIslam-BD/expense-tracker-mcp |
| Default branch | `main` (no other branches, no PRs, no CI yet) |
| MCPize server id | `15e6303c-b2e1-4aca-a40f-244ee4fba030` |
| MCPize playground | https://mcpize.com/mcp/expense-tracker-mcp/playground |
| MCPize public domain | `expense-tracker-mcp.mcpize.run` |
| Cloud Run service | `mcp-expense-tracker-mcp` (region `us-central1`) |
| Cloud Run URLs | `https://mcp-expense-tracker-mcp-670773090679.us-central1.run.app`, `https://mcp-expense-tracker-mcp-mi57itiaeq-uc.a.run.app` |
| Turso database (host only) | `libsql://expensetracker-tanvir1ariyan.aws-ap-south-1.turso.io` (Mumbai / `aws-ap-south-1`) |

Hosting facts (from Cloud Run deploy logs): Node **22-alpine**, **512 MiB / 1
vCPU**, `containerConcurrency: 80`, `maxScale: 10–20`, request `timeoutSeconds:
300`, gen2 execution env, startup-cpu-boost on. MCPize builds a Docker image via
Cloud Build (`npm ci` → `npm run build`) and deploys to Cloud Run on every push
to `main` (auto-deploy) or via the dashboard Redeploy button.

---

## 3. Architecture

### Entry point & transport (`src/index.ts`)
Dual transport, auto-selected:
- **stdio** — local dev, MCP Inspector, Claude Desktop.
- **Streamable HTTP (stateless)** — the hosted path MCPize/Cloud Run uses.

Selection: `--http`/`--stdio` flag or `MCP_TRANSPORT` env wins; otherwise HTTP if
`PORT` is set (Cloud Run always sets it), else stdio.

The HTTP path builds a **fresh `McpServer` per request** (`buildServer(store,
userId)`), which is what "stateless" means here — required because each request
may belong to a different subscriber. The **store is a shared singleton** across
requests; that's how data persists between calls from the same user.

Health/info: `GET /health` (used by Cloud Run's probe) and `GET /`. Everything
MCP goes through `POST /mcp`; `GET`/`DELETE /mcp` return 405 (stateless — no
sessions).

### Server definition (`src/server.ts`)
`buildServer(store, userId)` registers everything. Tools return human-readable
text plus a fenced ```json block with structured data (tests parse that block).

**Tools (14):** `add_expense`, `add_expenses` (batch), `list_expenses`
(category / date-range / free-text `search`), `get_expense`,
`get_recent_expense` (resolve "my last expense"), `update_expense`,
`delete_expense`, `summarize_expenses` (by category or month), `set_budget`,
`list_budgets`, `delete_budget`, `get_budget_status`, `list_categories`,
`export_expenses` (CSV/JSON).
**Resources (2):** `expense://recent`, `expense://summary/current-month`.
**Prompts (2):** `monthly_report`, `budget_review`.

### Storage (`src/store/`)
`ExpenseStore` interface (`types.ts`) with two implementations, chosen in
`createStore()` in `index.ts`:
- **`MemoryStore`** (`memory.ts`) — in-process, dependency-free, optional JSON
  file persistence via `DATA_DIR`. The zero-config local-dev default. **Not
  safe for hosted use** (see §5).
- **`TursoStore`** (`turso.ts`) — SQLite/libSQL via `@libsql/client`. Used
  whenever `TURSO_DATABASE_URL` is set. Durable, survives restarts, shared
  across instances. Same code path for a local file (`file:./x.db`, used in
  tests) or a remote Turso DB.

The tool layer (`server.ts`) is **storage-agnostic** — swapping stores needs
zero changes there. To add Postgres/Redis/etc.: implement `ExpenseStore` in a
new file and wire it into `createStore()`.

### Money & dates (`src/util.ts`)
- Money stored as **integer minor units** (cents) to avoid float drift; convert
  to major units only at the tool-output boundary (`view()`).
- Dates are `YYYY-MM-DD`; months `YYYY-MM`. `isValidDate` rejects impossible
  calendar dates (see §6, bug #1).

---

## 4. Per-user data isolation — how it works (and the bug that hid it)

Every row is tagged with a `userId` and the store only returns matching rows —
verified in `tests/store.test.ts` (alice never sees bob's data). So the *storage
layer* isolates correctly.

`userId` is derived per request by `resolveUserId` (`src/util.ts`), in priority:
1. **`x-mcpize-user-id`** header — MCPize's stable per-subscriber id. **This is
   the one that matters in production.**
2. `x-mcpize-user` / `x-user-id` — other explicit id headers.
3. SHA-256 hash of `Authorization` / `x-api-key` — last-ditch fallback for
   non-MCPize HTTP clients that send a *stable* token.
4. fallback constant `"public"`.

### The bug (fixed) — why every read came back empty on the durable store
After TursoStore went live, reads *still* returned nothing. Diagnostic logging
of the resolved `userId` per request revealed that **every single request got a
different `userId`** — including calls within one chat. Cause:

- `resolveUserId` originally keyed on hashing the `Authorization` header, and
- **MCPize rotates the `Authorization` bearer token on every request.**

So `add_expense` wrote under one hash-bucket and `list_expenses` read under a
different one — data was being saved to Turso correctly, just never found again.

The request headers MCPize actually forwards (captured from runtime logs):
```
host, content-length, content-type, mcp-protocol-version, accept,
x-mcp-default-currency, x-mcp-turso-database-url, x-mcpize-user-id,
authorization, traceparent, ...
```
`x-mcpize-user-id` is the stable subscriber identity. **Fix: check it first**
(done). Note MCPize also forwards service variables as `x-mcp-*` headers
(`x-mcp-default-currency`, `x-mcp-turso-database-url`) — informational; the
server reads config from the process env, not these headers.

### "Data leakage" scare — it was the same account, not a cross-user leak
After the fix, testing from both the MCPize playground and ChatGPT showed the
*same* expenses in both — which looked alarmingly like one user seeing
another's data. The runtime logs settled it: both clients resolved to the
**same** `x-mcpize-user-id` (`a8b3a6f6-…`) because both authenticated as the
**same MCPize account** (the developer). That's one person seeing their own data
in two apps — expected, not a leak. Two *different* MCPize accounts get
different UUIDs and are isolated. To actually prove isolation, test with a
second MCPize account; a shared-account test can't show it either way.

### Fail-closed identity (security hardening)
`resolveUserId` returns `string | null`. If no stable identity is present
(no `x-mcpize-user-id`/`x-user-id`, no auth token, no `DEFAULT_USER_ID`), it
returns **null**, and the HTTP handler **rejects** `tools/call` and
`resources/read` with a JSON-RPC error rather than falling into a shared
`"public"` bucket. Rationale: for a finance server, letting unrelated
unidentified callers share a bucket would be a real privacy breach. Discovery
methods (`initialize`, `tools/list`, …) are still allowed so clients can
connect. Pinned by `tests/util.test.ts` ("FAILS CLOSED …").

### Lesson for any future HTTP-hosted MCP work
Never derive identity by hashing the `Authorization` token on a platform that
issues short-lived/rotating tokens — you'll silently fragment every user's data
across per-request buckets. Key on the platform's explicit stable user-id header
(`x-mcpize-user-id` here), and fail closed when no stable identity exists.

> Temporary per-request diagnostic logging lives in `src/index.ts` (the `[req] …`
> line). Remove it once isolation is confirmed working in production.

---

## 5. The storage / scale-to-zero incident (most important thing to understand)

**Symptom (hit on the live MCPize playground):** `add_expense` returned a
confirmed ID, but `list_expenses` / "how much have I spent" a moment later
reported **no expenses** — and the model then re-added them from its own
conversation memory, silently duplicating.

**Root cause:** the deployed server was on `MemoryStore`, which lives entirely
in the Node process's RAM. MCPize hosting (Cloud Run) **scales idle instances to
zero** (confirmed in MCPize's FAQ) and can route concurrent requests to
different instances. Either event wipes/fragments in-process memory, so a later
read hits an empty store. This is guaranteed after any idle gap, not a flaky
edge case.

**Fix:** `TursoStore` — a real database outside the process. Verified end-to-end
against the live remote Turso DB: added an expense, killed the process entirely,
started a fresh process, and the expense was still there.

### Deploying the fix — the gotchas that cost time
1. **Secrets bind at deploy time.** Adding `TURSO_DATABASE_URL` in the MCPize
   dashboard does nothing until a **new deploy runs after** the save. MCPize's
   own banner says "Variables are encrypted at rest · Redeploy to apply
   changes." Symptom of forgetting this: runtime log keeps saying
   `[store] using MemoryStore …` on revisions built before the save.
2. **Build logs ≠ runtime logs.** The build log shows `npm ci`/`tsc`; the
   `[store] using …` line is printed at container **startup** (runtime logs).
   They're separate streams in the MCPize dashboard.
3. **Single-secret free tier.** MCPize's hobby tier allows 1 secret. Embed the
   Turso auth token in the URL as `?authToken=…` so `TURSO_DATABASE_URL` alone
   is sufficient. `resolveTursoConfig()` in `index.ts` splits it back out; a
   separate `TURSO_AUTH_TOKEN` is also honored.

### How to confirm which store is live
Look for exactly one of these at container startup (runtime log):
- ✅ `[store] using TursoStore (libsql://expensetracker-…)`
- ❌ `[store] using MemoryStore — data will NOT survive a restart…`

### Status as of last check
Secret `TURSO_DATABASE_URL` **is set** in MCPize Service Variables, but the last
runtime log observed (revision `00009`) still showed `MemoryStore` because no
redeploy had run since the secret was saved. **Resolution: trigger one redeploy**
(Deployments tab → ⋮ → Redeploy on the active row, or push a commit) and confirm
the startup log flips to `TursoStore`. If it still says `MemoryStore` after a
confirmed-saved-secret + fresh deploy, MCPize's secret injection isn't reaching
the container — that's an MCPize-side issue.

### Latency note (non-blocking)
Cloud Run is in `us-central1`; the Turso DB is in `ap-south-1` (Mumbai). Works
fine, adds ~200 ms per query. Colocate later if latency matters.

---

## 6. Bugs found & fixed (don't reintroduce)

1. **`isValidDate` accepted impossible dates.** `Date.parse("2026-02-30")`
   silently rolls to Mar 2. Fixed in `util.ts` by round-tripping through
   `toISOString().slice(0,10)` and requiring it to equal the input. Pinned by
   `tests/util.test.ts`.
2. **Non-deterministic same-day ordering.** `listExpenses` sorted by
   `date`,`createdAt`; same-millisecond ties made the sort unstable. Fixed with
   an explicit insertion-index tiebreaker so "newest first" is deterministic.
   Pinned by the four-expense case in `tests/store.test.ts`.
3. **MemoryStore data loss on hosted playground.** See §5. Fixed by TursoStore.

---

## 7. Testing

44 tests across 4 files (`npm test`), ~94% statement coverage
(`npm run test:coverage`). `src/index.ts` (process bootstrap) and
`src/store/types.ts` (interfaces only) are excluded from coverage.

- `tests/util.test.ts` — money, dates, `resolveUserId`, `view`.
- `tests/store.test.ts` — MemoryStore CRUD, isolation, budgets, JSON persistence.
- `tests/turso-store.test.ts` — TursoStore against an in-memory/file libSQL DB
  (no network), including a "persistence across restarts" case that reopens a
  fresh store on the same file to simulate a Cloud Run recycle.
- `tests/server.test.ts` — the whole tool/resource/prompt layer via a real MCP
  `Client` connected to `buildServer()` over `InMemoryTransport` (no mocks, no
  HTTP). To add a tool, copy the `callTool` + `jsonOf`/`textOf` pattern there.

---

## 8. Configuration / environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | auto | `http`/`stdio`; auto = HTTP if `PORT` set, else stdio |
| `PORT` | `8080` | HTTP port (Cloud Run injects it) |
| `DEFAULT_CURRENCY` | `USD` | ISO-4217 fallback currency |
| `TURSO_DATABASE_URL` | — | libSQL/Turso URL; set → durable storage. **Required for hosted use.** May embed `?authToken=…` |
| `TURSO_AUTH_TOKEN` | — | Token if not embedded in the URL |
| `DATA_DIR` | — | MemoryStore JSON-persistence dir; ignored if Turso is set |
| `DEFAULT_USER_ID` | `local`(stdio)/`public`(http) | Fallback id for unauthenticated requests |

The server reads `process.env` **directly** — it does not auto-load `.env`. For
local runs: export the vars, or `node --env-file=.env dist/index.js` (Node ≥
20.6). MCPize injects Service Variables into the process env directly.

**Local NAT64 gotcha:** on IPv6-transition networks, Node's IPv4-first connect
to Turso times out (`UND_ERR_CONNECT_TIMEOUT`) even though the network is fine.
Fix: `NODE_OPTIONS=--dns-result-order=ipv6first`. Local-only; does not affect the
deploy.

---

## 9. Marketplace assets (`assets/`)

Icon (512×512) + screenshots for the MCPize listing. **Not** captured from a
live app — authored as SVG mockups of ChatGPT/Claude UIs (mobile + desktop,
light/dark, plain-prompt + receipt-photo flows), rasterized to exact-pixel PNGs
with the `sharp` npm package (prebuilt binaries → installs clean on Windows).
This was a deliberate fallback after a browser-screenshot approach gave
viewport-scaling inconsistencies. To add more: author an SVG at target
resolution, rasterize with a throwaway `sharp` install in a scratch dir, copy
the PNG into `assets/`, delete the scratch `node_modules`.

The receipt-photo mockups depict the **host model's** vision doing OCR and
calling `add_expense` with already-extracted fields — the server has no image/OCR
capability, and the mockups must not imply otherwise.

---

## 10. License

`LICENSE` is **read/study-only** — no running, deployment, or commercial use.
This literally contradicts hosting on MCPize (which runs it) and the Claude
Desktop registration (which also runs it). This was flagged to the owner, who
confirmed it's intentionally not a concern for now. **Do not silently change the
license**; if a task depends on it, ask first.

---

## 11. Open items / next steps

- **Finish the storage cutover:** redeploy so `TursoStore` is actually live on
  the hosted server, and confirm via the startup log (§5).
- **Confirm per-user isolation** in production — resolve the §4 uncertainty
  (log the resolved userId across two subscribers, or require a custom header).
- **CI:** no GitHub Actions yet; `npm ci && npm run build && npm test` on push/PR.
- **Latency:** optionally colocate Turso with Cloud Run region.
- **Monetization:** x402 pay-per-call or subscription tiers + Stripe — discussed,
  not started.
- **License:** revisit only if explicitly asked.

---

## 12. Dependency versions (installed; see `package-lock.json` for exact)

`@modelcontextprotocol/sdk@1.29.0`, `zod@3.25.76`, `express@4.22.2`,
`@libsql/client@0.14.0`, `vitest@2.1.9`. `package.json` ranges are looser
(`^…`); if you bump the SDK, re-run the full suite — its method signatures have
changed across minor versions before.
