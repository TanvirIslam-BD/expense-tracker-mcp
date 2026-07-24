# Expense Tracker MCP Server

A personal **expense tracker** [Model Context Protocol](https://modelcontextprotocol.io) server,
written in TypeScript and packaged for the [MCPize](https://mcpize.com) marketplace.

Record expenses, set monthly budgets, and generate spending summaries — from Claude,
Cursor, VS Code, or any MCP client. Each subscriber's data is isolated automatically.

- **SDK:** official `@modelcontextprotocol/sdk` (v1.29+), schemas validated with `zod`
- **Transport:** dual — **stdio** for local dev / MCP Inspector, **Streamable HTTP** (stateless) for hosted deployment
- **Storage:** pluggable `ExpenseStore` interface; ships with a dependency-free in-memory store (optional JSON persistence)
- **Money:** stored as integer minor units (no floating-point drift), ISO-4217 currency per record

---

## Tools

| Tool | Description |
| --- | --- |
| `add_expense` | Record an expense (`amount`, `category`, `description?`, `date?`, `currency?`) |
| `list_expenses` | List expenses, newest first, with category / date-range filters |
| `get_expense` | Fetch one expense by id |
| `update_expense` | Update fields of an existing expense |
| `delete_expense` | Delete an expense by id |
| `summarize_expenses` | Totals grouped by `category` or `month`, over an optional range |
| `set_budget` | Set a monthly budget (per-category or overall) |
| `get_budget_status` | Spend vs. budget for a month, with over-budget flags |
| `list_categories` | Categories used, with counts and totals |
| `export_expenses` | Export as CSV or JSON |

**Resources:** `expense://recent` (last 20), `expense://summary/current-month`
**Prompts:** `monthly_report`, `budget_review`

---

## Local development

Requires Node.js 18+ (20 recommended).

```bash
npm install
npm run build
```

### Run over stdio (for Claude Desktop, Cursor, or the MCP Inspector)

```bash
npm run start:stdio
```

Test interactively with the MCP Inspector:

```bash
npm run inspect
```

### Run over HTTP (Streamable HTTP, the transport MCPize uses)

```bash
npm run start:http
# -> POST http://localhost:8080/mcp   (GET /health for a health check)
```

Point an MCP client at `http://localhost:8080/mcp`.

### Tests

The suite ([`vitest`](https://vitest.dev)) covers the utilities, the store, and
the full MCP tool/resource/prompt layer — the latter by connecting a real MCP
`Client` to `buildServer()` over the SDK's in-memory transport, so the actual
handlers run without HTTP.

```bash
npm test              # run once
npm run test:watch    # watch mode
npm run test:coverage # with a coverage report
```

### Configuration

Copy `.env.example` to `.env`. All variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | auto | `http` or `stdio`. If unset, HTTP when `PORT` is present, else stdio. |
| `PORT` | `8080` | HTTP port (set automatically by MCPize / Cloud Run). |
| `DEFAULT_CURRENCY` | `USD` | ISO-4217 code used when an expense omits a currency. |
| `DATA_DIR` | — | If set, expenses persist to `DATA_DIR/expenses.json`. Otherwise in-memory. |
| `DEFAULT_USER_ID` | `local` (stdio) / `public` (http) | Fallback id for unauthenticated requests. |

---

## Per-subscriber isolation

In HTTP mode, every request is scoped to a user id derived from its auth header
(`x-mcpize-user` / `x-user-id`, or a hash of `Authorization` / `x-api-key`). MCPize
routes each subscriber's traffic with their own credential, so subscribers can never
see each other's expenses. In stdio mode there is a single local user.

---

## Storage & persistence

The default `MemoryStore` is dependency-free and builds anywhere. With `DATA_DIR`
set it persists to a JSON file; otherwise data lives in memory.

> **Production note:** MCPize hosts servers on Cloud Run, whose filesystem is
> ephemeral and per-instance. For durable, multi-instance storage, implement the
> `ExpenseStore` interface (`src/store/types.ts`) against a real database
> (Postgres, Turso, etc.) and construct it in `src/index.ts` instead of
> `MemoryStore`. The MCP tool layer is storage-agnostic and needs no changes —
> add the connection string as a publisher secret (`DATABASE_URL`) in `mcpize.yaml`.

---

## Deploy to MCPize

Configuration lives in [`mcpize.yaml`](./mcpize.yaml) (`runtime: typescript`,
HTTP transport, `npm run build`). The server auto-detects HTTP mode from the
`PORT` that MCPize injects.

```bash
npm install -g mcpize
mcpize login
mcpize deploy
```

Then set the server's visibility to **public** in the MCPize dashboard to list it
on the marketplace. Pricing tiers are configured in the dashboard, not in
`mcpize.yaml`. See the [publishing guide](https://mcpize.com/developers/publish-mcp-server).

Before publishing: add an icon (512×512 PNG) and screenshots, and connect Stripe
if you plan to charge.

---

## Project layout

```
src/
  index.ts          # transport bootstrap (stdio | Streamable HTTP)
  server.ts         # buildServer(): registers tools, resources, prompts
  util.ts           # money / date / id helpers, per-user id resolution
  store/
    types.ts        # Expense, Budget, ExpenseStore interface
    memory.ts       # in-memory store with optional JSON persistence
tests/
  util.test.ts      # money / date / id helpers
  store.test.ts     # store CRUD, isolation, budgets, persistence
  server.test.ts    # tools/resources/prompts via in-memory MCP client
mcpize.yaml         # MCPize deployment config
vitest.config.ts    # test + coverage config
```

## License

This repository is provided for **reading and study purposes only** — see
[LICENSE](./LICENSE). Running, deploying, or commercial use of the Software
is not permitted under this license.
