/**
 * End-to-end regression check over real HTTP using the SDK's Streamable HTTP
 * client — the same transport shape Claude's connector and OpenAI's scanner
 * use. Guards against the GET /mcp change breaking an existing client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE ?? "http://127.0.0.1:8801";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// --- 1. Full client handshake through the real transport -------------------
console.log("=== SDK Streamable HTTP client (what Claude does) ===");
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { "x-user-id": "regression-user" } },
});
const client = new Client({ name: "regression", version: "1.0.0" });
await client.connect(transport);
check("connect + initialize", true);

const tools = await client.listTools();
check("tools/list", tools.tools.length === 32, `${tools.tools.length} tools`);

const resources = await client.listResources();
check("resources/list", resources.resources.length === 2, `${resources.resources.length}`);

const prompts = await client.listPrompts();
check("prompts/list", prompts.prompts.length === 5, `${prompts.prompts.length}`);

const added = await client.callTool({ name: "add_expense", arguments: { amount: 12.5, category: "food", description: "regression lunch" } });
check("tools/call add_expense", JSON.stringify(added).includes("12.5"));

const listed = await client.callTool({ name: "list_expenses", arguments: {} });
check("tools/call list_expenses round-trips", JSON.stringify(listed).includes("regression lunch"));

const read = await client.readResource({ uri: "expense://recent" });
check("resources/read", typeof read.contents?.[0]?.text === "string");

const prompt = await client.getPrompt({ name: "budget_review", arguments: {} });
check("prompts/get", prompt.messages.length > 0);

await client.close();

// --- 2. Legacy SSE compatibility used by OpenAI's scanner -----------------
console.log("\n=== Legacy GET /mcp/sse client ===");
const legacyTransport = new SSEClientTransport(new URL(`${BASE}/mcp/sse`), {
  requestInit: { headers: { "x-user-id": "regression-user" } },
});
const legacyClient = new Client({ name: "legacy-regression", version: "1.0.0" });
await legacyClient.connect(legacyTransport);
check("connect + initialize through /mcp/sse", true);
const legacyTools = await legacyClient.listTools();
check("legacy tools/list", legacyTools.tools.length === 32, `${legacyTools.tools.length} tools`);
await legacyClient.close();

// --- 3. The GET /mcp stream itself ----------------------------------------
console.log("\n=== GET /mcp SSE stream ===");
const controller = new AbortController();
const sse = await fetch(`${BASE}/mcp`, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
check("status 200 (was 405)", sse.status === 200, `got ${sse.status}`);
check("content-type is text/event-stream", (sse.headers.get("content-type") ?? "").includes("text/event-stream"));
const reader = sse.body.getReader();
const first = await reader.read();
check("emits an initial SSE comment", new TextDecoder().decode(first.value).startsWith(":"));
controller.abort();
try { await reader.cancel(); } catch {}

// --- 4. Unchanged behaviours ---------------------------------------------
console.log("\n=== unchanged behaviour ===");
const del = await fetch(`${BASE}/mcp`, { method: "DELETE" });
check("DELETE /mcp still 405", del.status === 405, `got ${del.status}`);

const health = await (await fetch(`${BASE}/health`)).json();
check("/health unchanged", health.status === "ok" && health.server === "expense-tracker");

const noAuth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_expenses", arguments: {} } }),
});
check("tools/call without identity still 401 (fails closed)", noAuth.status === 401, `got ${noAuth.status}`);
check("401 carries WWW-Authenticate for OAuth discovery", Boolean(noAuth.headers.get("www-authenticate")));

const discovery = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
check("tools/list without identity still allowed (discovery)", discovery.status === 200, `got ${discovery.status}`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
