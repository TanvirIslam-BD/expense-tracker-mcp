import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";

const TOOL_NAMES = [
  "add_expense",
  "add_expenses",
  "list_expenses",
  "get_expense",
  "get_recent_expense",
  "update_expense",
  "delete_expense",
  "summarize_expenses",
  "set_budget",
  "list_budgets",
  "delete_budget",
  "delete_account",
  "get_budget_status",
  "list_categories",
  "full_budget_report",
  "export_expenses",
  "add_income",
  "set_recurring_expense",
  "split_expense",
  "import_expenses",
  "manage_categories",
  "set_alert_thresholds",
  "get_cash_flow_report",
  "get_spending_forecast",
  "compare_months",
  "get_budget_alerts",
  "manage_budget_templates",
  "find_duplicate_expenses",
  "set_budget_email_alert",
  "get_dashboard_link",
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

/** The error text of a failing call — whether it throws (schema validation) or
 *  resolves with isError (handler-level). Used to assert friendly messages. */
async function isToolErrorWithMessage(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) return textOf(r);
    throw new Error(`expected ${name} to fail, but it succeeded`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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
      "budget_review", "monthly_financial_review", "monthly_report", "savings_plan", "subscription_audit",
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

  it("coerces string amounts, including comma-grouped and symbol-prefixed", async () => {
    const plain = await call(client, "add_expense", {
      amount: "12.50",
      category: "food",
      date: "2026-07-10",
    });
    expect(plain.isError).toBeFalsy();
    expect(jsonOf(plain).amount).toBe(12.5);

    const grouped = await call(client, "add_expense", {
      amount: "1,234.56",
      category: "rent",
      date: "2026-07-11",
    });
    expect(grouped.isError).toBeFalsy();
    expect(jsonOf(grouped).amount).toBe(1234.56);

    const symbol = await call(client, "add_expense", {
      amount: "$45",
      category: "food",
      date: "2026-07-12",
    });
    expect(symbol.isError).toBeFalsy();
    expect(jsonOf(symbol).amount).toBe(45);

    // Coercion also applies inside batch and budget tools.
    const batch = await call(client, "add_expenses", {
      expenses: [{ amount: "1,000", category: "shopping", date: "2026-07-13" }],
    });
    expect(jsonOf(batch)[0].amount).toBe(1000);

    const budget = await call(client, "set_budget", { amount: "2,500", category: "food" });
    expect(budget.isError).toBeFalsy();
    expect(textOf(budget)).toContain("$2,500.00");
  });

  it("gives friendly messages for missing and non-numeric amounts", async () => {
    const nonNumeric = await isToolErrorWithMessage(client, "add_expense", {
      amount: "abc",
      category: "food",
    });
    expect(nonNumeric).toContain("Amount must be a number");

    const missing = await isToolErrorWithMessage(client, "add_expense", { category: "food" });
    expect(missing).toContain("Amount is required");

    const negative = await isToolErrorWithMessage(client, "add_expense", {
      amount: -5,
      category: "food",
    });
    expect(negative).toContain("greater than 0");
  });

  it("renders empty-description rows without a dangling gap", async () => {
    const created = await call(client, "add_expense", { amount: 30, category: "food", date: "2026-07-10" });
    const id = jsonOf(created).id;
    const listed = textOf(await call(client, "list_expenses", {}));
    const line = listed.split("\n").find((l) => l.includes(id))!;
    expect(line).toContain(`[food]  (${id})`); // single separator, no empty note slot
    expect(line).not.toMatch(/\[food]\s{3,}/);
  });

  it("resolves the most recent expense, overall and by category", async () => {
    await call(client, "add_expense", { amount: 10, category: "food", date: "2026-07-01" });
    await call(client, "add_expense", { amount: 20, category: "transport", date: "2026-07-05" });
    await call(client, "add_expense", { amount: 30, category: "food", date: "2026-07-03" });

    const overall = await call(client, "get_recent_expense", {});
    expect(overall.isError).toBeFalsy();
    expect(jsonOf(overall).amount).toBe(20); // 2026-07-05 is newest

    const recentFood = await call(client, "get_recent_expense", { category: "food" });
    expect(jsonOf(recentFood).amount).toBe(30); // newest food is 2026-07-03

    // The resolved id round-trips into update_expense.
    const id = jsonOf(recentFood).id;
    const updated = await call(client, "update_expense", { id, amount: 99 });
    expect(jsonOf(updated).amount).toBe(99);

    const empty = await call(client, "get_recent_expense", { category: "rent" });
    expect(empty.isError).toBe(true);
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

  it("add_expenses records a batch in one call", async () => {
    const r = await call(client, "add_expenses", {
      expenses: [
        { amount: 10, category: "food", date: "2026-07-01" },
        { amount: 20, category: "transport", date: "2026-07-02" },
        { amount: 30, category: "food", description: "dinner", date: "2026-07-03" },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r).length).toBe(3);
    expect(jsonOf(await call(client, "list_expenses", {})).length).toBe(3);
  });

  it("add_expenses rejects the whole batch if any item is invalid", async () => {
    expect(
      await isToolError(client, "add_expenses", {
        expenses: [
          { amount: 10, category: "food" },
          { amount: 5, category: "food", date: "2026-13-40" }, // invalid
        ],
      }),
    ).toBe(true);
    // Nothing partially written — validation happens before any insert.
    expect(textOf(await call(client, "list_expenses", {}))).toContain("No expenses found");
  });

  it("searches by note/description or category (case-insensitive)", async () => {
    await call(client, "add_expense", { amount: 4, category: "food", description: "Morning Latte", date: "2026-07-01" });
    await call(client, "add_expense", { amount: 40, category: "transport", description: "taxi", date: "2026-07-02" });

    const byNote = await call(client, "list_expenses", { search: "coffee" });
    expect(textOf(byNote)).toContain("No expenses found"); // no 'coffee' note

    const latte = await call(client, "list_expenses", { search: "latte" });
    expect(jsonOf(latte).length).toBe(1);
    expect(jsonOf(latte)[0].description).toBe("Morning Latte");

    const byCat = await call(client, "list_expenses", { search: "TRANS" });
    expect(jsonOf(byCat).length).toBe(1);
  });

  it("lists and deletes budgets", async () => {
    await call(client, "set_budget", { amount: 300, category: "food" });
    await call(client, "set_budget", { amount: 2000 }); // overall

    const listed = jsonOf(await call(client, "list_budgets", {})) as any[];
    expect(listed.length).toBe(2);
    expect(listed.map((b) => b.scope).sort()).toEqual(["food", "overall"]);

    const del = await call(client, "delete_budget", { category: "food" });
    expect(textOf(del)).toContain("Deleted");
    const after = jsonOf(await call(client, "list_budgets", {})) as any[];
    expect(after.map((b) => b.scope)).toEqual(["overall"]);

    // Deleting a non-existent budget errors.
    expect(await isToolError(client, "delete_budget", { category: "nope" })).toBe(true);
  });

  it("delete_account wipes all expenses, budgets, and finance state for the user", async () => {
    await call(client, "add_expense", { amount: 10, category: "food" });
    await call(client, "add_expense", { amount: 20, category: "rent" });
    await call(client, "set_budget", { amount: 500, category: "food" });
    await call(client, "add_income", { amount: 1000, source: "Salary" });

    const result = await call(client, "delete_account", { confirm: true });
    const structured = result.structuredContent as any;
    expect(structured.deleted).toBe(true);
    expect(structured.expenses_deleted).toBe(2);
    expect(structured.budgets_deleted).toBe(1);

    expect((await call(client, "list_expenses", {})).structuredContent).toMatchObject({ count: 0, expenses: [] });
    expect((await call(client, "list_budgets", {})).structuredContent).toMatchObject({ budgets: [] });
    const cashFlow = jsonOf(await call(client, "get_cash_flow_report", {}));
    expect(cashFlow.currencies).toEqual([]);

    // Missing/false confirmation is rejected rather than silently no-op'd.
    expect(await isToolError(client, "delete_account", {})).toBe(true);
    expect(await isToolError(client, "delete_account", { confirm: false })).toBe(true);
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

  it("creates a full monthly report with pie and budget chart images", async () => {
    await call(client, "set_budget", { amount: 100, category: "food" });
    await call(client, "set_budget", { amount: 80, category: "transport" });
    await call(client, "add_expense", { amount: 35, category: "food", date: "2026-07-05" });
    await call(client, "add_expense", { amount: 95, category: "transport", date: "2026-07-06" });
    await call(client, "add_expense", { amount: 60, category: "rent", date: "2026-07-07" });

    const result = await call(client, "full_budget_report", { month: "2026-07" });
    const report = jsonOf(result);
    expect(report.expense_count).toBe(3);
    expect(report.totals.USD).toBe(190);
    expect(report.budgets.find((b: any) => b.scope === "transport").over_budget).toBe(true);
    expect(report.charts.map((chart: any) => chart.type).sort()).toEqual(["budget_bar", "pie"]);

    const images = (result.content ?? []).filter((content: any) => content.type === "image") as any[];
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.mimeType === "image/svg+xml")).toBe(true);
    expect(Buffer.from(images[0].data, "base64").toString("utf8")).toContain("<svg");
  });

  it("supports advanced income, recurring, importing, forecasting, alerts, and template workflows", async () => {
    await call(client, "add_income", { amount: 1000, source: "salary", date: "2026-07-01" });
    await call(client, "set_recurring_expense", { amount: 25, category: "utilities", frequency: "monthly", next_date: "2026-08-01" });
    await call(client, "split_expense", { total_amount: 30, date: "2026-07-03", splits: [{ category: "food", amount: 10 }, { category: "shopping", amount: 20 }] });
    await call(client, "import_expenses", { csv: "amount,category,date,description,currency\n12,food,2026-07-04,lunch,USD" });
    await call(client, "manage_categories", { action: "upsert", category: "food", limit: 200, color: "#00aa00" });
    await call(client, "set_alert_thresholds", { thresholds: [50, 90] });
    await call(client, "set_budget", { amount: 20, category: "food" });
    expect(jsonOf(await call(client, "get_cash_flow_report", { month: "2026-07" })).currencies[0].income).toBe(1000);
    expect(jsonOf(await call(client, "get_spending_forecast", { month: "2026-07" })).forecasts[0].forecast).toBeGreaterThan(0);
    expect(jsonOf(await call(client, "get_budget_alerts", { month: "2026-07" })).alerts.length).toBeGreaterThan(0);
    await call(client, "manage_budget_templates", { action: "save", name: "student", template: [{ category: "food", amount: 150 }] });
    expect(textOf(await call(client, "manage_budget_templates", { action: "apply", name: "student" }))).toContain("Applied");
    expect(jsonOf(await call(client, "compare_months", { months: 2 })).months).toHaveLength(2);
  });

  it("sends one configured email after a monthly budget limit is crossed", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.RESEND_API_KEY;
    const originalFrom = process.env.BUDGET_ALERT_EMAIL_FROM;
    let calls = 0;
    process.env.RESEND_API_KEY = "test-key";
    process.env.BUDGET_ALERT_EMAIL_FROM = "Alerts <alerts@example.com>";
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await call(client, "set_budget_email_alert", { email: "user@example.com" });
      await call(client, "set_budget", { amount: 10, category: "food" });
      await call(client, "add_expense", { amount: 10, category: "food", date: "2026-07-08" });
      await call(client, "add_expense", { amount: 2, category: "food", date: "2026-07-09" });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalKey;
      if (originalFrom === undefined) delete process.env.BUDGET_ALERT_EMAIL_FROM; else process.env.BUDGET_ALERT_EMAIL_FROM = originalFrom;
    }
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

    const pdf = jsonOf(await call(client, "export_expenses", { format: "pdf" }));
    expect(Buffer.from(pdf.pdf_base64, "base64").toString("utf8")).toContain("%PDF-1.4");
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
