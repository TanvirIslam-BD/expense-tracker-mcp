import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";

/*
 * The dashboard gates on a name and an email before it will load, but a user who
 * connects from ChatGPT or Claude and never opens it cannot be shown a form --
 * and without an address there is no way to answer their support request, send a
 * budget alert or deliver an email report. So tool results carry the ask instead.
 */
const NUDGE = /no name or email address on file/;

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A store that reports contact details however the test wants. */
async function connect(hasContactDetails: boolean | (() => Promise<boolean>)) {
  const store = new MemoryStore();
  await store.init();
  store.hasContactDetails = typeof hasContactDetails === "function"
    ? hasContactDetails
    : async () => hasContactDetails;
  const server = buildServer(store, "user-1");
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, store };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

describe("profile nudge", () => {
  it("asks for contact details when the dashboard has none", async () => {
    const { client } = await connect(false);
    const result = await call(client, "add_expense", { amount: 12.5, category: "food" });
    expect(textOf(result)).toMatch(NUDGE);
    expect(textOf(result)).toMatch(/copilotai\.live\/dashboard/);
  });

  it("says nothing once they are on file", async () => {
    const { client } = await connect(true);
    const result = await call(client, "add_expense", { amount: 12.5, category: "food" });
    expect(textOf(result)).not.toMatch(NUDGE);
  });

  it("reaches every tool, not a hand-picked few", async () => {
    // Wrapping each registerTool call by hand would be forty chances to miss one,
    // and a nudge on only some tools reads as a bug.
    const { client } = await connect(false);
    for (const name of ["list_expenses", "summarize_expenses", "list_budgets", "list_categories", "get_budget_status"]) {
      expect(textOf(await call(client, name)), `${name} should carry the nudge`).toMatch(NUDGE);
    }
  });

  it("keeps the tool's own answer, and puts the ask after it", async () => {
    const { client } = await connect(false);
    const result = await call(client, "add_expense", { amount: 12.5, category: "food" });
    const text = textOf(result);
    expect(text).toMatch(/12\.5|12\.50/);
    expect(text.indexOf("no name or email")).toBeGreaterThan(0);
  });

  it("leaves structuredContent alone, since callers parse it against a schema", async () => {
    const { client } = await connect(false);
    const result = await call(client, "add_expense", { amount: 12.5, category: "food" });
    expect(JSON.stringify(result.structuredContent ?? {})).not.toMatch(NUDGE);
  });

  it("does not nag on a failure, where the error is the useful message", async () => {
    const { client } = await connect(false);
    const result = await call(client, "get_expense", { id: "does-not-exist" });
    if (result.isError) expect(textOf(result)).not.toMatch(NUDGE);
  });

  it("stays quiet when it cannot tell, rather than nagging on every call", async () => {
    // An unreachable database must not put a nag on every tool result.
    const { client } = await connect(async () => { throw new Error("database down"); });
    const result = await call(client, "add_expense", { amount: 12.5, category: "food" });
    expect(textOf(result)).not.toMatch(NUDGE);
  });

  it("costs one lookup per request, not one per tool call", async () => {
    let calls = 0;
    const { client } = await connect(async () => { calls += 1; return false; });
    await call(client, "add_expense", { amount: 1, category: "food" });
    await call(client, "list_expenses");
    await call(client, "list_budgets");
    expect(calls).toBe(1);
  });
});
