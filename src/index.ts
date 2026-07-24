import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { resolveUserId } from "./util.js";

const store = new MemoryStore(process.env.DATA_DIR);
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
