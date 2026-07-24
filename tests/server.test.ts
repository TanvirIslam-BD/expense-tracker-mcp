import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";

const TOOL_NAMES = [
  "add_expense",
  "list_expenses",
  "get_expense",
  "update_expense",
  "delete_expense",
  "summarize_expenses",
  "set_budget",
  "get_budget_status",
  "list_categories",
  "export_expenses",
];

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Parse the last ```json ... ``` fenced block out of a tool's text result. */
function jsonOf(result: CallToolResult): any {
  const text = textOf(result);
  const matches = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
  if (matches.length === 0) throw new Error("no json block in result:\n" + text);
  return JSON.parse(matches[matches.length - 1][1]);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** True if a tool call rejects or resolves with isError — used for validation cases. */
async function isToolError(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return r.isError === true;
  } catch {
    return true;
  }
}

describe("MCP server (in-memory transport)", () => {
  let client: Client;
  let server: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    const store = new MemoryStore();
    await store.init();
    server = buildServer(store, "tester");
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("advertises the expected tools, resources, and prompts", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri).sort()).toEqual([
      "expense://recent",
      "expense://summary/current-month",
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      "budget_review",
      "monthly_report",
    ]);
  });

  it("add_expense records an expense and echoes it back", async () => {
    const r = await call(client, "add_expense", {
      amount: 12.5,
      category: "Food",
      description: "Lunch",
      date: "2026-07-10",
    });
    expect(r.isError).toBeFalsy();
    const data = jsonOf(r);
    expect(data.amount).toBe(12.5);
    expect(data.category).toBe("food"); // normalised to lowercase
    expect(textOf(r)).toContain("$12.50");
  });

  it("rejects invalid input", async () => {
    expect(await isToolError(client, "add_expense", { amount: -5, category: "x" })).toBe(true);
    expect(
      await isToolError(client, "add_expense", { amount: 5, category: "x", date: "07/24/2026" }),
    ).toBe(true);
    expect(await isToolError(client, "get_expense", { id: "does-not-exist" })).toBe(true);
  });

  it("lists and filters expenses", async () => {
    await call(client, "add_expense", { amount: 10, category: "food", date: "2026-07-01" });
    await call(client, "add_expense", { amount: 20, category: "transport", date: "2026-07-02" });
    await call(client, "add_expense", { amount: 30, category: "food", date: "2026-07-03" });

    const all = await call(client, "list_expenses", {});
    expect(jsonOf(all).length).toBe(3);

    const food = await call(client, "list_expenses", { category: "food" });
    expect(jsonOf(food).length).toBe(2);

    const ranged = await call(client, "list_expenses", { from: "2026-07-02", to: "2026-07-31" });
    expect(jsonOf(ranged).length).toBe(2);
  });

  it("summarizes spending grouped by category", async () => {
    await call(client, "add_expense", { amount: 10, category: "food", date: "2026-07-01" });
    await call(client, "add_expense", { amount: 15, category: "food", date: "2026-07-02" });
    await call(client, "add_expense", { amount: 100, category: "rent", date: "2026-07-01" });

    const r = await call(client, "summarize_expenses", { group_by: "category" });
    const data = jsonOf(r);
    expect(data.overall_total.USD).toBe(125);
    const rent = data.groups.find((g: any) => g.key === "rent");
    const food = data.groups.find((g: any) => g.key === "food");
    expect(rent.totals.USD).toBe(100);
    expect(food.totals.USD).toBe(25);
    expect(food.count).toBe(2);
    // Sorted by weight desc -> rent first.
    expect(data.groups[0].key).toBe("rent");
  });

  it("tracks budget status with correct math and over-budget flag", async () => {
    await call(client, "set_budget", { amount: 100, category: "food" });
    await call(client, "set_budget", { amount: 50, category: "transport" });
    await call(client, "add_expense", { amount: 30, category: "food", date: "2026-07-05" });
    await call(client, "add_expense", { amount: 70, category: "transport", date: "2026-07-06" });

    const r = await call(client, "get_budget_status", { month: "2026-07" });
    const statuses = jsonOf(r) as any[];

    const food = statuses.find((s) => s.scope === "food");
    expect(food.spent).toBe(30);
    expect(food.remaining).toBe(70);
    expect(food.over_budget).toBe(false);

    const transport = statuses.find((s) => s.scope === "transport");
    expect(transport.spent).toBe(70);
    expect(transport.over_budget).toBe(true);
  });

  it("ignores expenses from other months in budget status", async () => {
    await call(client, "set_budget", { amount: 100, category: "food" });
    await call(client, "add_expense", { amount: 40, category: "food", date: "2026-07-05" });
    await call(client, "add_expense", { amount: 90, category: "food", date: "2026-08-05" });

    const july = jsonOf(await call(client, "get_budget_status", { month: "2026-07" })) as any[];
    expect(july.find((s) => s.scope === "food").spent).toBe(40);

    const august = jsonOf(await call(client, "get_budget_status", { month: "2026-08" })) as any[];
    expect(august.find((s) => s.scope === "food").over_budget).toBe(false); // 90 <= 100
    expect(august.find((s) => s.scope === "food").spent).toBe(90);
  });

  it("updates and deletes an expense", async () => {
    const added = jsonOf(await call(client, "add_expense", { amount: 10, category: "food" }));
    const id = added.id;

    await call(client, "update_expense", { id, amount: 25, category: "dining" });
    const fetched = jsonOf(await call(client, "get_expense", { id }));
    expect(fetched.amount).toBe(25);
    expect(fetched.category).toBe("dining");

    const del = await call(client, "delete_expense", { id });
    expect(textOf(del)).toContain("Deleted");
    expect(await isToolError(client, "get_expense", { id })).toBe(true);
  });

  it("update_expense with no fields is an error", async () => {
    const added = jsonOf(await call(client, "add_expense", { amount: 10, category: "food" }));
    expect(await isToolError(client, "update_expense", { id: added.id })).toBe(true);
  });

  it("exports CSV and JSON", async () => {
    await call(client, "add_expense", { amount: 12.5, category: "food", description: 'a "quoted" note', date: "2026-07-01" });

    const csv = textOf(await call(client, "export_expenses", { format: "csv" }));
    expect(csv).toContain("id,date,category,description,amount,currency");
    expect(csv).toContain("12.50");
    expect(csv).toContain('""quoted""'); // CSV-escaped quotes

    const json = jsonOf(await call(client, "export_expenses", { format: "json" }));
    expect(json[0].amount).toBe(12.5);
  });

  it("returns prompt messages", async () => {
    const p = await client.getPrompt({ name: "monthly_report", arguments: { month: "2026-07" } });
    expect(p.messages.length).toBeGreaterThan(0);
    const joined = p.messages
      .map((m) => (m.content.type === "text" ? m.content.text : ""))
      .join("\n");
    expect(joined).toContain("2026-07");

    const review = await client.getPrompt({ name: "budget_review", arguments: {} });
    expect(review.messages.length).toBeGreaterThan(0);
  });

  it("reads the current-month summary resource", async () => {
    await call(client, "add_expense", { amount: 42, category: "food" }); // dated today
    const res = await client.readResource({ uri: "expense://summary/current-month" });
    const body = JSON.parse(res.contents[0].text as string);
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(body.count).toBeGreaterThanOrEqual(1);
  });
});
