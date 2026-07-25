import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExpenseStore } from "./store/types.js";
import {
  currentMonth,
  formatMoney,
  isValidDate,
  isValidMonth,
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

/**
 * A monetary amount in major units. Liberal in what it accepts: a real number,
 * or a string like "12.50" or "1,234.56" (commas, whitespace, and a leading
 * currency symbol are stripped before parsing). A well-behaved LLM client sends
 * a number, but scripts — or the occasional model slip on comma-grouped values —
 * send strings, so we coerce rather than reject. Bad input gets a friendly,
 * human-readable message instead of a raw type error.
 */
function moneyAmount(describe = "Amount in major units, e.g. 12.50") {
  return z
    .preprocess((v) => {
      if (typeof v === "string") {
        const cleaned = v.replace(/[,\s$£€]/g, "");
        if (cleaned === "") return undefined; // empty → trigger "required"
        const n = Number(cleaned);
        return Number.isNaN(n) ? v : n; // keep original so invalid_type fires
      }
      return v;
    }, z
      .number({
        required_error:
          "Amount is required — give a positive number in major units, e.g. 12.50.",
        invalid_type_error:
          "Amount must be a number in major units, e.g. 12.50.",
      })
      .positive("Amount must be greater than 0."))
    .describe(describe);
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
 * Tool input schemas, built ONCE at module load and shared across every
 * per-request server. In stateless HTTP mode a fresh McpServer is built per
 * request; the zod validators here are pure/static (no per-request state), so
 * reconstructing ~40 of them on every request is wasted CPU. Hoisting them out
 * lets each request reuse the same validated schema objects. (Handlers still
 * close over the per-request userId, so they stay inside buildServer.)
 */
const TOOL_INPUTS = {
  add_expense: {
    amount: moneyAmount(),
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
  add_expenses: {
    expenses: z
      .array(
        z.object({
          amount: moneyAmount("Amount in major units"),
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
  list_expenses: {
    category: z.string().optional().describe("Filter by category"),
    search: z
      .string()
      .optional()
      .describe("Case-insensitive text match on the note/description or category"),
    from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
    to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
    limit: z.number().int().positive().max(500).default(50),
  },
  get_expense: { id: z.string().min(1).describe("Expense id") },
  get_recent_expense: {
    category: z
      .string()
      .min(1)
      .optional()
      .describe("Optional: only consider expenses in this category"),
  },
  update_expense: {
    id: z.string().min(1).describe("Expense id"),
    amount: moneyAmount("New amount in major units").optional(),
    category: z.string().min(1).optional(),
    description: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD"),
    currency: z.string().length(3).optional(),
  },
  delete_expense: { id: z.string().min(1).describe("Expense id") },
  summarize_expenses: {
    group_by: z.enum(["category", "month"]).default("category"),
    from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
    to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
  },
  set_budget: {
    amount: moneyAmount("Monthly limit in major units"),
    category: z
      .string()
      .min(1)
      .optional()
      .describe("Category; omit for an overall budget"),
    currency: z.string().length(3).optional(),
  },
  delete_budget: {
    category: z
      .string()
      .min(1)
      .optional()
      .describe("Category; omit for the overall budget"),
  },
  get_budget_status: {
    month: z
      .string()
      .optional()
      .describe("Month YYYY-MM; defaults to current month"),
  },
  export_expenses: {
    format: z.enum(["csv", "json"]).default("csv"),
    from: z.string().optional(),
    to: z.string().optional(),
  },
};

/**
 * Build a fully-configured MCP server bound to one store and one user id.
 *
 * In stateless HTTP mode a fresh server is built per request, with the
 * subscriber's id captured in this closure; the store itself is a shared
 * singleton, so data persists across requests. Tool input schemas are reused
 * from the module-level TOOL_INPUTS (built once) rather than rebuilt here.
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
      inputSchema: TOOL_INPUTS.add_expense,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
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
      inputSchema: TOOL_INPUTS.add_expenses,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
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
      inputSchema: TOOL_INPUTS.list_expenses,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category, search, from, to, limit }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);

      const items = await store.listExpenses(userId, { category, search, from, to, limit });
      if (items.length === 0) return text("No expenses found for that filter.");

      const lines = items.map((e) => {
        const note = e.description ? `  ${e.description}` : "";
        return (
          `• ${e.date}  ${formatMoney(e.amountMinor, e.currency).padStart(10)}  ` +
          `[${e.category}]${note}  (${e.id})`
        );
      });
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
      inputSchema: TOOL_INPUTS.get_expense,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const expense = await store.getExpense(userId, id);
      if (!expense) return fail(`No expense found with id ${id}.`);
      return text(jsonBlock(view(expense)));
    },
  );

  server.registerTool(
    "get_recent_expense",
    {
      title: "Get most recent expense",
      description:
        "Fetch the single most recently dated expense (optionally within a " +
        "category). Use this to resolve references like \"my last expense\" or " +
        "\"that coffee I just added\" into a concrete id you can then pass to " +
        "update_expense or delete_expense.",
      inputSchema: TOOL_INPUTS.get_recent_expense,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category }) => {
      const [expense] = await store.listExpenses(userId, { category, limit: 1 });
      if (!expense) {
        return category
          ? fail(`No expenses found in category "${category}".`)
          : fail("No expenses recorded yet.");
      }
      return text(
        `Most recent${category ? ` "${category}"` : ""} expense: ` +
          `${formatMoney(expense.amountMinor, expense.currency)} on ${expense.date}.\n` +
          `ID: ${expense.id}\n\n` +
          jsonBlock(view(expense)),
      );
    },
  );

  server.registerTool(
    "update_expense",
    {
      title: "Update expense",
      description:
        "Update fields of an existing expense. Only provided fields change.",
      inputSchema: TOOL_INPUTS.update_expense,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      inputSchema: TOOL_INPUTS.delete_expense,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      inputSchema: TOOL_INPUTS.summarize_expenses,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ group_by, from, to }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);

      // Grouping + summing happens in the store (SQL GROUP BY on Turso), so we
      // never pull the full row set back just to fold it in memory here.
      const groups = await store.aggregate(userId, { groupBy: group_by, from, to });
      if (groups.length === 0) return text("No expenses found for that range.");

      const rows = groups
        .map((g) => ({
          key: g.key,
          count: g.count,
          // Sort weight: sum of minor units across currencies (rough but stable).
          weight: Object.values(g.totals).reduce((a, b) => a + b, 0),
          totals: g.totals,
        }))
        .sort((a, b) =>
          group_by === "month" ? b.key.localeCompare(a.key) : b.weight - a.weight,
        );

      // Fold overall totals + count from the grouped buckets.
      const overall: Record<string, number> = {};
      let totalCount = 0;
      for (const r of rows) {
        totalCount += r.count;
        for (const [c, m] of Object.entries(r.totals)) {
          overall[c] = (overall[c] ?? 0) + m;
        }
      }
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
        `Spending by ${group_by} (${totalCount} expenses, ` +
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
      inputSchema: TOOL_INPUTS.set_budget,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      inputSchema: TOOL_INPUTS.delete_budget,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
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
      inputSchema: TOOL_INPUTS.get_budget_status,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      // Category counts + totals computed in the store (SQL GROUP BY), not by
      // fetching every expense and folding it here.
      const groups = await store.aggregate(userId, { groupBy: "category" });
      if (groups.length === 0) return text("No expenses recorded yet.");

      const rows = groups.sort((a, b) => b.count - a.count);
      const lines = rows.map(
        (g) => `• ${g.key.padEnd(16)} ${g.count} expense(s), ${renderTotals(g.totals)}`,
      );
      const structured = rows.map((g) => ({
        category: g.key,
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
      inputSchema: TOOL_INPUTS.export_expenses,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
