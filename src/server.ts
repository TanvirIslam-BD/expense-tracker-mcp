import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExpenseStore } from "./store/types.js";
import {
  currentMonth,
  formatMoney,
  isValidDate,
  isValidMonth,
  monthOf,
  resolveCategory,
  toMajor,
  toMinor,
  todayISO,
  view,
} from "./util.js";

const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || "USD")
  .toUpperCase()
  .slice(0, 3);

// --- small render helpers ---------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

function fail(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

function jsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

/** Sum minor units grouped by currency (expenses may mix currencies). */
function totalsByCurrency(items: { amountMinor: number; currency: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of items) out[e.currency] = (out[e.currency] ?? 0) + e.amountMinor;
  return out;
}

function renderTotals(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "0.00";
  return entries.map(([cur, minor]) => formatMoney(minor, cur)).join(" + ");
}

/**
 * Build a fully-configured MCP server bound to one store and one user id.
 *
 * In stateless HTTP mode a fresh server is built per request (cheap), with the
 * subscriber's id captured in this closure; the store itself is a shared
 * singleton, so data persists across requests.
 */
export function buildServer(store: ExpenseStore, userId: string): McpServer {
  const server = new McpServer(
    { name: "expense-tracker", version: "1.0.0" },
    {
      instructions:
        "Personal expense tracker. Use add_expense (or add_expenses for many at " +
        "once) to record spending, list_expenses/summarize_expenses to review " +
        "it, and set_budget/get_budget_status to track monthly budgets. Amounts " +
        "are in major currency units (e.g. 12.50). Dates are YYYY-MM-DD; months " +
        "are YYYY-MM. IMPORTANT: when the user records an expense without naming " +
        "a category, choose the most appropriate category yourself (e.g. food, " +
        "transport, rent, utilities, entertainment, shopping, health) and pass " +
        "it — never leave the category blank, so spending reports stay complete.",
    },
  );

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "add_expense",
    {
      title: "Add expense",
      description:
        "Record a new expense. Amount is a positive decimal in major units " +
        "(e.g. 12.50). Date defaults to today.",
      inputSchema: {
        amount: z.number().positive().describe("Amount in major units, e.g. 12.50"),
        category: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Category, e.g. food, transport, rent, utilities, entertainment, " +
              "shopping, health. If the user didn't state a category, YOU should " +
              "infer the most fitting one from the description/context and pass " +
              "it here — don't leave it blank. (If it's still omitted, the server " +
              "falls back to keyword inference, then 'uncategorized'.)",
          ),
        description: z.string().default("").describe("Optional note"),
        date: z.string().optional().describe("Date YYYY-MM-DD; defaults to today"),
        currency: z
          .string()
          .length(3)
          .optional()
          .describe("ISO-4217 code; defaults to server currency"),
      },
    },
    async ({ amount, category, description, date, currency }) => {
      const d = date ?? todayISO();
      if (!isValidDate(d)) return fail(`Invalid date "${d}". Use YYYY-MM-DD.`);

      const note = description ?? "";
      const expense = await store.addExpense({
        userId,
        amountMinor: toMinor(amount),
        currency: (currency ?? DEFAULT_CURRENCY).toUpperCase(),
        category: resolveCategory(category, note),
        description: note,
        date: d,
      });

      return text(
        `Added ${formatMoney(expense.amountMinor, expense.currency)} for ` +
          `"${expense.category}" on ${expense.date}.\nID: ${expense.id}\n\n` +
          jsonBlock(view(expense)),
      );
    },
  );

  server.registerTool(
    "add_expenses",
    {
      title: "Add multiple expenses",
      description:
        "Record several expenses in one call — efficient for a receipt with " +
        "many line items or logging a whole day's spending at once. Each item " +
        "takes the same fields as add_expense.",
      inputSchema: {
        expenses: z
          .array(
            z.object({
              amount: z.number().positive().describe("Amount in major units"),
              category: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Category. If the user didn't state one, infer the most " +
                    "fitting category yourself rather than leaving it blank.",
                ),
              description: z.string().default("").describe("Optional note"),
              date: z.string().optional().describe("Date YYYY-MM-DD; defaults to today"),
              currency: z.string().length(3).optional().describe("ISO-4217 code"),
            }),
          )
          .min(1)
          .max(100)
          .describe("The expenses to add (1–100)"),
      },
    },
    async ({ expenses }) => {
      const today = todayISO();
      const prepared = [];
      for (let i = 0; i < expenses.length; i++) {
        const e = expenses[i];
        const d = e.date ?? today;
        if (!isValidDate(d)) {
          return fail(`Item ${i + 1}: invalid date "${d}". Use YYYY-MM-DD.`);
        }
        const note = e.description ?? "";
        prepared.push({
          userId,
          amountMinor: toMinor(e.amount),
          currency: (e.currency ?? DEFAULT_CURRENCY).toUpperCase(),
          category: resolveCategory(e.category, note),
          description: note,
          date: d,
        });
      }

      const created = await store.addExpenses(prepared);
      const totals = totalsByCurrency(created);
      return text(
        `Added ${created.length} expense(s), total ${renderTotals(totals)}.\n\n` +
          jsonBlock(created.map(view)),
      );
    },
  );

  server.registerTool(
    "list_expenses",
    {
      title: "List expenses",
      description:
        "List expenses, newest first, with optional category, date-range, and " +
        "free-text filters. Use `search` to find expenses by a word in the " +
        "note/description (e.g. \"coffee\") or category.",
      inputSchema: {
        category: z.string().optional().describe("Filter by category"),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive text match on the note/description or category"),
        from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
        to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    async ({ category, search, from, to, limit }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);

      const items = await store.listExpenses(userId, { category, search, from, to, limit });
      if (items.length === 0) return text("No expenses found for that filter.");

      const lines = items.map(
        (e) =>
          `• ${e.date}  ${formatMoney(e.amountMinor, e.currency).padStart(10)}  ` +
          `[${e.category}]  ${e.description}`.trimEnd() +
          `  (${e.id})`,
      );
      const totals = totalsByCurrency(items);

      return text(
        `${items.length} expense(s), total ${renderTotals(totals)}:\n` +
          lines.join("\n") +
          "\n\n" +
          jsonBlock(items.map(view)),
      );
    },
  );

  server.registerTool(
    "get_expense",
    {
      title: "Get expense",
      description: "Fetch a single expense by its id.",
      inputSchema: { id: z.string().min(1).describe("Expense id") },
    },
    async ({ id }) => {
      const expense = await store.getExpense(userId, id);
      if (!expense) return fail(`No expense found with id ${id}.`);
      return text(jsonBlock(view(expense)));
    },
  );

  server.registerTool(
    "update_expense",
    {
      title: "Update expense",
      description:
        "Update fields of an existing expense. Only provided fields change.",
      inputSchema: {
        id: z.string().min(1).describe("Expense id"),
        amount: z.number().positive().optional(),
        category: z.string().min(1).optional(),
        description: z.string().optional(),
        date: z.string().optional().describe("YYYY-MM-DD"),
        currency: z.string().length(3).optional(),
      },
    },
    async ({ id, amount, category, description, date, currency }) => {
      if (date && !isValidDate(date)) return fail(`Invalid date "${date}".`);
      if (
        amount == null &&
        category == null &&
        description == null &&
        date == null &&
        currency == null
      ) {
        return fail("Provide at least one field to update.");
      }

      const updated = await store.updateExpense(userId, id, {
        amountMinor: amount != null ? toMinor(amount) : undefined,
        category: category?.trim().toLowerCase(),
        description,
        date,
        currency: currency?.toUpperCase(),
      });
      if (!updated) return fail(`No expense found with id ${id}.`);

      return text(`Updated expense ${id}.\n\n` + jsonBlock(view(updated)));
    },
  );

  server.registerTool(
    "delete_expense",
    {
      title: "Delete expense",
      description: "Delete an expense by its id.",
      inputSchema: { id: z.string().min(1).describe("Expense id") },
    },
    async ({ id }) => {
      const removed = await store.deleteExpense(userId, id);
      return removed
        ? text(`Deleted expense ${id}.`)
        : fail(`No expense found with id ${id}.`);
    },
  );

  server.registerTool(
    "summarize_expenses",
    {
      title: "Summarize expenses",
      description:
        "Aggregate spending grouped by category or by month, within an " +
        "optional date range.",
      inputSchema: {
        group_by: z.enum(["category", "month"]).default("category"),
        from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
        to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
      },
    },
    async ({ group_by, from, to }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);

      const items = await store.listExpenses(userId, { from, to });
      if (items.length === 0) return text("No expenses found for that range.");

      const groups = new Map<string, { totals: Record<string, number>; count: number }>();
      for (const e of items) {
        const key = group_by === "month" ? monthOf(e.date) : e.category;
        const g = groups.get(key) ?? { totals: {}, count: 0 };
        g.totals[e.currency] = (g.totals[e.currency] ?? 0) + e.amountMinor;
        g.count += 1;
        groups.set(key, g);
      }

      const rows = [...groups.entries()]
        .map(([key, g]) => ({
          key,
          count: g.count,
          // Sort weight: sum of minor units across currencies (rough but stable).
          weight: Object.values(g.totals).reduce((a, b) => a + b, 0),
          totals: g.totals,
        }))
        .sort((a, b) =>
          group_by === "month" ? b.key.localeCompare(a.key) : b.weight - a.weight,
        );

      const overall = totalsByCurrency(items);
      const lines = rows.map(
        (r) => `• ${r.key.padEnd(16)}  ${renderTotals(r.totals)}  (${r.count})`,
      );

      const structured = {
        group_by,
        range: { from: from ?? null, to: to ?? null },
        overall_total: Object.fromEntries(
          Object.entries(overall).map(([c, m]) => [c, toMajor(m)]),
        ),
        groups: rows.map((r) => ({
          key: r.key,
          count: r.count,
          totals: Object.fromEntries(
            Object.entries(r.totals).map(([c, m]) => [c, toMajor(m)]),
          ),
        })),
      };

      return text(
        `Spending by ${group_by} (${items.length} expenses, ` +
          `total ${renderTotals(overall)}):\n` +
          lines.join("\n") +
          "\n\n" +
          jsonBlock(structured),
      );
    },
  );

  server.registerTool(
    "set_budget",
    {
      title: "Set budget",
      description:
        "Set a monthly budget. Omit category for an overall budget; provide a " +
        "category for a per-category budget. Re-setting overwrites the existing " +
        "budget for that category.",
      inputSchema: {
        amount: z.number().positive().describe("Monthly limit in major units"),
        category: z
          .string()
          .min(1)
          .optional()
          .describe("Category; omit for an overall budget"),
        currency: z.string().length(3).optional(),
      },
    },
    async ({ amount, category, currency }) => {
      const budget = await store.setBudget({
        userId,
        category: category ? category.trim().toLowerCase() : null,
        amountMinor: toMinor(amount),
        currency: (currency ?? DEFAULT_CURRENCY).toUpperCase(),
      });
      const label = budget.category ? `"${budget.category}"` : "overall";
      return text(
        `Set ${label} monthly budget to ` +
          `${formatMoney(budget.amountMinor, budget.currency)}.`,
      );
    },
  );

  server.registerTool(
    "list_budgets",
    {
      title: "List budgets",
      description:
        "List all monthly budgets you've set — the overall budget and any " +
        "per-category budgets.",
      inputSchema: {},
    },
    async () => {
      const budgets = await store.listBudgets(userId);
      if (budgets.length === 0) {
        return text("No budgets set. Use set_budget to create one.");
      }
      const lines = budgets.map(
        (b) =>
          `• ${(b.category ?? "overall").padEnd(14)} ` +
          `${formatMoney(b.amountMinor, b.currency)} / month`,
      );
      const structured = budgets.map((b) => ({
        scope: b.category ?? "overall",
        amount: toMajor(b.amountMinor),
        currency: b.currency,
        period: b.period,
      }));
      return text(lines.join("\n") + "\n\n" + jsonBlock(structured));
    },
  );

  server.registerTool(
    "delete_budget",
    {
      title: "Delete budget",
      description:
        "Remove a monthly budget. Omit category to delete the overall budget; " +
        "provide a category to delete that category's budget.",
      inputSchema: {
        category: z
          .string()
          .min(1)
          .optional()
          .describe("Category; omit for the overall budget"),
      },
    },
    async ({ category }) => {
      const target = category ? category.trim().toLowerCase() : null;
      const budgets = await store.listBudgets(userId);
      const found = budgets.find((b) => b.category === target);
      const label = target ? `"${target}"` : "overall";
      if (!found) return fail(`No ${label} budget to delete.`);
      await store.deleteBudget(userId, found.id);
      return text(`Deleted ${label} monthly budget.`);
    },
  );

  server.registerTool(
    "get_budget_status",
    {
      title: "Get budget status",
      description:
        "Compare this month's (or a given month's) spending against your " +
        "budgets. Reports spent, remaining, and over-budget flags.",
      inputSchema: {
        month: z
          .string()
          .optional()
          .describe("Month YYYY-MM; defaults to current month"),
      },
    },
    async ({ month }) => {
      const m = month ?? currentMonth();
      if (!isValidMonth(m)) return fail(`Invalid month "${m}". Use YYYY-MM.`);

      const budgets = await store.listBudgets(userId);
      if (budgets.length === 0) {
        return text("No budgets set. Use set_budget to create one.");
      }

      // Scope to the month at the store level (uses the (user_id, date) index)
      // rather than fetching every expense and filtering in memory. All valid
      // days in month `m` sort within [`${m}-01`, `${m}-31`] lexicographically.
      const monthExpenses = await store.listExpenses(userId, {
        from: `${m}-01`,
        to: `${m}-31`,
      });

      const statuses = budgets.map((b) => {
        const relevant = monthExpenses.filter(
          (e) =>
            e.currency === b.currency &&
            (b.category === null || e.category === b.category),
        );
        const spentMinor = relevant.reduce((a, e) => a + e.amountMinor, 0);
        const remainingMinor = b.amountMinor - spentMinor;
        const pct = b.amountMinor > 0 ? (spentMinor / b.amountMinor) * 100 : 0;
        return {
          scope: b.category ?? "overall",
          currency: b.currency,
          budget: toMajor(b.amountMinor),
          spent: toMajor(spentMinor),
          remaining: toMajor(remainingMinor),
          percent_used: Math.round(pct * 10) / 10,
          over_budget: spentMinor > b.amountMinor,
          _budgetMinor: b.amountMinor,
          _spentMinor: spentMinor,
          _remainingMinor: remainingMinor,
        };
      });

      const lines = statuses.map((s) => {
        const flag = s.over_budget ? "  ⚠ OVER" : "";
        return (
          `• ${s.scope.padEnd(14)} ${formatMoney(s._spentMinor, s.currency)} / ` +
          `${formatMoney(s._budgetMinor, s.currency)}  ` +
          `(${s.percent_used}% used, ${formatMoney(s._remainingMinor, s.currency)} left)${flag}`
        );
      });

      const structured = statuses.map((s) => ({
        scope: s.scope,
        currency: s.currency,
        budget: s.budget,
        spent: s.spent,
        remaining: s.remaining,
        percent_used: s.percent_used,
        over_budget: s.over_budget,
      }));

      return text(
        `Budget status for ${m}:\n` + lines.join("\n") + "\n\n" + jsonBlock(structured),
      );
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "List the categories you've used, with expense counts and totals.",
      inputSchema: {},
    },
    async () => {
      const items = await store.listExpenses(userId);
      if (items.length === 0) return text("No expenses recorded yet.");

      const byCat = new Map<string, { count: number; totals: Record<string, number> }>();
      for (const e of items) {
        const g = byCat.get(e.category) ?? { count: 0, totals: {} };
        g.count += 1;
        g.totals[e.currency] = (g.totals[e.currency] ?? 0) + e.amountMinor;
        byCat.set(e.category, g);
      }

      const rows = [...byCat.entries()].sort((a, b) => b[1].count - a[1].count);
      const lines = rows.map(
        ([cat, g]) => `• ${cat.padEnd(16)} ${g.count} expense(s), ${renderTotals(g.totals)}`,
      );
      const structured = rows.map(([cat, g]) => ({
        category: cat,
        count: g.count,
        totals: Object.fromEntries(
          Object.entries(g.totals).map(([c, m]) => [c, toMajor(m)]),
        ),
      }));

      return text(lines.join("\n") + "\n\n" + jsonBlock(structured));
    },
  );

  server.registerTool(
    "export_expenses",
    {
      title: "Export expenses",
      description: "Export expenses as CSV or JSON, with an optional date range.",
      inputSchema: {
        format: z.enum(["csv", "json"]).default("csv"),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ format, from, to }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);

      const items = (await store.listExpenses(userId, { from, to })).map(view);
      if (items.length === 0) return text("No expenses to export.");

      if (format === "json") {
        return text(jsonBlock(items));
      }

      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const header = "id,date,category,description,amount,currency";
      const rows = items.map((e) =>
        [
          e.id,
          e.date,
          e.category,
          esc(e.description),
          e.amount.toFixed(2),
          e.currency,
        ].join(","),
      );
      return text("```csv\n" + [header, ...rows].join("\n") + "\n```");
    },
  );

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  server.registerResource(
    "recent-expenses",
    "expense://recent",
    {
      title: "Recent expenses",
      description: "The 20 most recent expenses for the current user (JSON).",
      mimeType: "application/json",
    },
    async (uri) => {
      const items = await store.listExpenses(userId, { limit: 20 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(items.map(view), null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "current-month-summary",
    "expense://summary/current-month",
    {
      title: "Current month summary",
      description: "This month's spending grouped by category (JSON).",
      mimeType: "application/json",
    },
    async (uri) => {
      const m = currentMonth();
      // Month-scoped at the store level (indexed) — no full-table fetch.
      const items = await store.listExpenses(userId, {
        from: `${m}-01`,
        to: `${m}-31`,
      });
      const byCat: Record<string, Record<string, number>> = {};
      for (const e of items) {
        byCat[e.category] ??= {};
        byCat[e.category][e.currency] =
          (byCat[e.category][e.currency] ?? 0) + e.amountMinor;
      }
      const summary = {
        month: m,
        count: items.length,
        by_category: Object.fromEntries(
          Object.entries(byCat).map(([cat, totals]) => [
            cat,
            Object.fromEntries(
              Object.entries(totals).map(([c, minor]) => [c, toMajor(minor)]),
            ),
          ]),
        ),
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  server.registerPrompt(
    "monthly_report",
    {
      title: "Monthly spending report",
      description:
        "Generate a spending report for a month with category breakdown and " +
        "budget analysis.",
      argsSchema: {
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("Month YYYY-MM; defaults to current month"),
      },
    },
    ({ month }) => {
      const m = month ?? currentMonth();
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Produce a spending report for ${m}.\n` +
                `1. Call summarize_expenses with group_by="category" for that month.\n` +
                `2. Call get_budget_status for ${m}.\n` +
                `Then write a concise report: total spend, top 3 categories, any ` +
                `over-budget categories, and 2-3 concrete savings suggestions.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "budget_review",
    {
      title: "Budget review",
      description: "Review current budgets against spending and suggest adjustments.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Call get_budget_status for the current month, then assess whether " +
              "my budgets are realistic given recent spending (use " +
              "summarize_expenses and list_categories). Recommend specific budget " +
              "increases or decreases and flag categories with no budget set.",
          },
        },
      ],
    }),
  );

  return server;
}
