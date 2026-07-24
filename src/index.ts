import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { TursoStore } from "./store/turso.js";
import type { ExpenseStore } from "./store/types.js";
import { resolveUserId } from "./util.js";

/**
 * TURSO_DATABASE_URL may embed its auth token as a query param
 * (`libsql://xxx.turso.io?authToken=...`), which lets a single secret cover a
 * remote Turso database on hosts (like MCPize's free tier) that cap you at
 * one secret. A separate TURSO_AUTH_TOKEN env var is also honored, so a
 * two-secret setup works too — the embedded token wins if both are present.
 */
function resolveTursoConfig(): { url: string; authToken?: string } | null {
  const raw = process.env.TURSO_DATABASE_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const embeddedToken = parsed.searchParams.get("authToken");
    if (embeddedToken) {
      parsed.searchParams.delete("authToken");
      return { url: parsed.toString(), authToken: embeddedToken };
    }
  } catch {
    // Not a parseable URL (e.g. a local `file:./data.db` path) — use as-is.
  }
  return { url: raw, authToken: process.env.TURSO_AUTH_TOKEN };
}

function createStore(): ExpenseStore {
  const turso = resolveTursoConfig();
  if (turso) {
    console.error(`[store] using TursoStore (${turso.url.replace(/\?.*/, "")})`);
    return new TursoStore(turso.url, turso.authToken);
  }
  console.error(
    "[store] using MemoryStore — data will NOT survive a restart or a second " +
      "instance. Set TURSO_DATABASE_URL for durable storage in production.",
  );
  return new MemoryStore(process.env.DATA_DIR);
}

const store = createStore();
await store.init();

// Transport selection:
//  --http / MCP_TRANSPORT=http           -> HTTP
//  --stdio / MCP_TRANSPORT=stdio         -> stdio
//  otherwise: HTTP if PORT is set (MCPize / Cloud Run), else stdio.
function useHttp(): boolean {
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") return true;
  if (process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio") return false;
  return Boolean(process.env.PORT);
}

async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Permissive CORS so browser-based and proxied MCP clients can connect.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.header("origin") || "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, mcp-session-id, x-user-id, x-mcpize-user",
    );
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check for MCPize / Cloud Run uptime monitoring.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: "expense-tracker", version: "1.0.0" });
  });
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "expense-tracker-mcp",
      transport: "streamable-http",
      endpoint: "/mcp",
    });
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, with the
  // subscriber isolated via their auth header. The store is shared, so data
  // persists across requests.
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const userId = resolveUserId(req);
      // TEMPORARY DIAGNOSTIC (remove after verifying per-user isolation on
      // MCPize): logs the resolved user id + the header NAMES the host forwards
      // per request — never header values, so no tokens leak. Lets us see
      // whether the caller identity is stable across an add/list pair (real
      // isolation) or varies/absent (everything collapses to one bucket, or
      // each call lands in a different bucket).
      {
        const method =
          req.body && typeof req.body === "object" ? (req.body as { method?: string }).method : undefined;
        const toolName =
          req.body && typeof req.body === "object"
            ? (req.body as { params?: { name?: string } }).params?.name
            : undefined;
        console.error(
          `[req] method=${method ?? "?"}${toolName ? ` tool=${toolName}` : ""} userId=${userId} headers=[${Object.keys(req.headers).join(",")}]`,
        );
      }
      const server = buildServer(store, userId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. This server is stateless — use POST /mcp.",
      },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.error(
      `[expense-tracker-mcp] HTTP transport listening on :${port} (POST /mcp)`,
    );
  });
}

async function startStdio(): Promise<void> {
  const userId = process.env.DEFAULT_USER_ID || "local";
  const server = buildServer(store, userId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for JSON-RPC; log to stderr only.
  console.error("[expense-tracker-mcp] stdio transport ready");
}

if (useHttp()) {
  await startHttp();
} else {
  await startStdio();
}
