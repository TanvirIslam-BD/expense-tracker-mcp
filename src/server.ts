import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExpenseStore } from "./store/types.js";
import {
  currentMonth,
  formatMoney,
  isValidDate,
  isValidMonth,
  resolveCategory,
  shiftMonth,
  toMajor,
  toMinor,
  todayISO,
  view,
  viewIncome,
  viewRecurring,
} from "./util.js";

const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || "USD")
  .toUpperCase()
  .slice(0, 3);

// --- small render helpers ---------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function text(s: string, structuredContent?: object): ToolResult {
  return structuredContent
    ? { content: [{ type: "text", text: s }], structuredContent: structuredContent as Record<string, unknown> }
    : { content: [{ type: "text", text: s }] };
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
  add_income: {
    amount: moneyAmount(),
    source: z
      .string()
      .min(1)
      .describe("Where the income came from, e.g. salary, freelance, gift, refund"),
    description: z.string().default("").describe("Optional note"),
    date: z.string().optional().describe("Date YYYY-MM-DD; defaults to today"),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe("ISO-4217 code; defaults to server currency"),
  },
  list_income: {
    search: z
      .string()
      .optional()
      .describe("Case-insensitive text match on the note/description or source"),
    from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
    to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
    limit: z.number().int().positive().max(500).default(50),
  },
  get_income: { id: z.string().min(1).describe("Income id") },
  update_income: {
    id: z.string().min(1).describe("Income id"),
    amount: moneyAmount("New amount in major units").optional(),
    source: z.string().min(1).optional(),
    description: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD"),
    currency: z.string().length(3).optional(),
  },
  delete_income: { id: z.string().min(1).describe("Income id") },
  get_cash_flow: {
    from: z
      .string()
      .optional()
      .describe("Start date YYYY-MM-DD (inclusive); defaults to the start of the current month"),
    to: z.string().optional().describe("End date YYYY-MM-DD (inclusive); defaults to today"),
  },
  add_recurring_expense: {
    amount: moneyAmount(),
    category: z
      .string()
      .min(1)
      .describe("Category, e.g. rent, subscription, insurance"),
    description: z.string().default("").describe("Optional note, e.g. \"Netflix\""),
    frequency: z
      .enum(["daily", "weekly", "monthly", "yearly"])
      .describe("How often this expense recurs"),
    start_date: z
      .string()
      .optional()
      .describe("Date of the first occurrence, YYYY-MM-DD; defaults to today"),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe("ISO-4217 code; defaults to server currency"),
  },
  list_recurring_expenses: {},
  update_recurring_expense: {
    id: z.string().min(1).describe("Recurring expense id"),
    amount: moneyAmount("New amount in major units").optional(),
    category: z.string().min(1).optional(),
    description: z.string().optional(),
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]).optional(),
    next_date: z
      .string()
      .optional()
      .describe("Reschedule the next occurrence, YYYY-MM-DD"),
    active: z.boolean().optional().describe("Set false to pause, true to resume"),
    currency: z.string().length(3).optional(),
  },
  delete_recurring_expense: {
    id: z.string().min(1).describe("Recurring expense id"),
  },
  process_recurring_expenses: {},
  get_spending_trends: {
    months: z
      .number()
      .int()
      .min(2)
      .max(12)
      .default(3)
      .describe("How many trailing months to analyze, including the current month"),
  },
};

/** Shape of the client-facing expense view (see util.ts `view()`). */
const expenseViewShape = {
  id: z.string(),
  date: z.string(),
  category: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
};

/** Money totals grouped by ISO-4217 currency code, in major units. */
const currencyTotalsShape = z.record(z.string(), z.number());

/** Shape of the client-facing income view (see util.ts `viewIncome()`). */
const incomeViewShape = {
  id: z.string(),
  date: z.string(),
  source: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
};

/** Shape of the client-facing recurring-expense view (see util.ts `viewRecurring()`). */
const recurringViewShape = {
  id: z.string(),
  category: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  next_date: z.string(),
  active: z.boolean(),
};

/**
 * Tool output schemas, hoisted for the same reason as TOOL_INPUTS. Each
 * matches the `structuredContent` a handler actually returns, so clients that
 * want structured data don't have to parse the human-readable text/JSON block.
 */
const TOOL_OUTPUTS = {
  add_expense: expenseViewShape,
  add_expenses: {
    count: z.number(),
    totals: currencyTotalsShape,
    expenses: z.array(z.object(expenseViewShape)),
  },
  list_expenses: {
    count: z.number(),
    totals: currencyTotalsShape,
    expenses: z.array(z.object(expenseViewShape)),
  },
  get_expense: expenseViewShape,
  get_recent_expense: expenseViewShape,
  update_expense: expenseViewShape,
  delete_expense: {
    deleted: z.boolean(),
    id: z.string(),
  },
  summarize_expenses: {
    group_by: z.enum(["category", "month"]),
    range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
    overall_total: currencyTotalsShape,
    groups: z.array(
      z.object({ key: z.string(), count: z.number(), totals: currencyTotalsShape }),
    ),
  },
  set_budget: {
    scope: z.string(),
    amount: z.number(),
    currency: z.string(),
  },
  list_budgets: {
    budgets: z.array(
      z.object({
        scope: z.string(),
        amount: z.number(),
        currency: z.string(),
        period: z.literal("monthly"),
      }),
    ),
  },
  delete_budget: {
    deleted: z.boolean(),
    scope: z.string(),
  },
  get_budget_status: {
    month: z.string(),
    statuses: z.array(
      z.object({
        scope: z.string(),
        currency: z.string(),
        budget: z.number(),
        spent: z.number(),
        remaining: z.number(),
        percent_used: z.number(),
        over_budget: z.boolean(),
      }),
    ),
  },
  list_categories: {
    categories: z.array(
      z.object({ category: z.string(), count: z.number(), totals: currencyTotalsShape }),
    ),
  },
  export_expenses: {
    format: z.enum(["csv", "json"]),
    count: z.number(),
    csv: z.string().optional(),
    expenses: z.array(z.object(expenseViewShape)).optional(),
  },
  add_income: incomeViewShape,
  list_income: {
    count: z.number(),
    totals: currencyTotalsShape,
    income: z.array(z.object(incomeViewShape)),
  },
  get_income: incomeViewShape,
  update_income: incomeViewShape,
  delete_income: {
    deleted: z.boolean(),
    id: z.string(),
  },
  get_cash_flow: {
    range: z.object({ from: z.string(), to: z.string() }),
    income_total: currencyTotalsShape,
    expense_total: currencyTotalsShape,
    net: currencyTotalsShape,
  },
  add_recurring_expense: recurringViewShape,
  list_recurring_expenses: {
    recurring: z.array(z.object(recurringViewShape)),
  },
  update_recurring_expense: recurringViewShape,
  delete_recurring_expense: {
    deleted: z.boolean(),
    id: z.string(),
  },
  process_recurring_expenses: {
    count: z.number(),
    expenses: z.array(z.object(expenseViewShape)),
  },
  get_spending_trends: {
    months: z.number(),
    overall: z.array(z.object({ month: z.string(), totals: currencyTotalsShape })),
    trend: z.enum(["up", "down", "flat"]),
    percent_change: z.number(),
    category_spikes: z.array(
      z.object({
        category: z.string(),
        current_totals: currencyTotalsShape,
        baseline_avg_totals: currencyTotalsShape,
        percent_change: z.number(),
      }),
    ),
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
        "it, and set_budget/get_budget_status to track monthly budgets. Use " +
        "add_income/list_income to record income and get_cash_flow to compare " +
        "it against expenses. Use add_recurring_expense for bills that repeat " +
        "on a schedule (rent, subscriptions) — due occurrences are logged " +
        "automatically, or call process_recurring_expenses to catch up now. " +
        "Use get_spending_trends to spot categories spending unusually more " +
        "than their recent average. Amounts are in major currency units (e.g. " +
        "12.50). Dates are YYYY-MM-DD; months are YYYY-MM. IMPORTANT: when the " +
        "user records an expense without naming a category, choose the most " +
        "appropriate category yourself (e.g. food, transport, rent, utilities, " +
        "entertainment, shopping, health) and pass it — never leave the " +
        "category blank, so spending reports stay complete.",
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
      outputSchema: TOOL_OUTPUTS.add_expense,
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
      const viewed = view(expense);

      return text(
        `Added ${formatMoney(expense.amountMinor, expense.currency)} for ` +
          `"${expense.category}" on ${expense.date}.\nID: ${expense.id}\n\n` +
          jsonBlock(viewed),
        viewed,
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
      outputSchema: TOOL_OUTPUTS.add_expenses,
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
      const structured = {
        count: created.length,
        totals: Object.fromEntries(
          Object.entries(totals).map(([c, m]) => [c, toMajor(m)]),
        ),
        expenses: created.map(view),
      };
      return text(
        `Added ${created.length} expense(s), total ${renderTotals(totals)}.\n\n` +
          jsonBlock(created.map(view)),
        structured,
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
      outputSchema: TOOL_OUTPUTS.list_expenses,
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

      // Catch up any recurring expenses due by today before reporting, so
      // scheduled items (rent, subscriptions) show up without a separate step.
      await store.processDueRecurring(userId, todayISO());

      const items = await store.listExpenses(userId, { category, search, from, to, limit });
      if (items.length === 0) {
        return text("No expenses found for that filter.", {
          count: 0,
          totals: {},
          expenses: [],
        });
      }

      const lines = items.map((e) => {
        const note = e.description ? `  ${e.description}` : "";
        return (
          `• ${e.date}  ${formatMoney(e.amountMinor, e.currency).padStart(10)}  ` +
          `[${e.category}]${note}  (${e.id})`
        );
      });
      const totals = totalsByCurrency(items);
      const structured = {
        count: items.length,
        totals: Object.fromEntries(
          Object.entries(totals).map(([c, m]) => [c, toMajor(m)]),
        ),
        expenses: items.map(view),
      };

      return text(
        `${items.length} expense(s), total ${renderTotals(totals)}:\n` +
          lines.join("\n") +
          "\n\n" +
          jsonBlock(items.map(view)),
        structured,
      );
    },
  );

  server.registerTool(
    "get_expense",
    {
      title: "Get expense",
      description: "Fetch a single expense by its id.",
      inputSchema: TOOL_INPUTS.get_expense,
      outputSchema: TOOL_OUTPUTS.get_expense,
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
      const viewed = view(expense);
      return text(jsonBlock(viewed), viewed);
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
      outputSchema: TOOL_OUTPUTS.get_recent_expense,
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
      const viewed = view(expense);
      return text(
        `Most recent${category ? ` "${category}"` : ""} expense: ` +
          `${formatMoney(expense.amountMinor, expense.currency)} on ${expense.date}.\n` +
          `ID: ${expense.id}\n\n` +
          jsonBlock(viewed),
        viewed,
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
      outputSchema: TOOL_OUTPUTS.update_expense,
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

      const viewed = view(updated);
      return text(`Updated expense ${id}.\n\n` + jsonBlock(viewed), viewed);
    },
  );

  server.registerTool(
    "delete_expense",
    {
      title: "Delete expense",
      description: "Delete an expense by its id.",
      inputSchema: TOOL_INPUTS.delete_expense,
      outputSchema: TOOL_OUTPUTS.delete_expense,
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
        ? text(`Deleted expense ${id}.`, { deleted: true, id })
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
      outputSchema: TOOL_OUTPUTS.summarize_expenses,
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
      if (groups.length === 0) {
        return text("No expenses found for that range.", {
          group_by,
          range: { from: from ?? null, to: to ?? null },
          overall_total: {},
          groups: [],
        });
      }

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
        structured,
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
      outputSchema: TOOL_OUTPUTS.set_budget,
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
        {
          scope: budget.category ?? "overall",
          amount: toMajor(budget.amountMinor),
          currency: budget.currency,
        },
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
      outputSchema: TOOL_OUTPUTS.list_budgets,
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
        return text("No budgets set. Use set_budget to create one.", { budgets: [] });
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
      return text(lines.join("\n") + "\n\n" + jsonBlock(structured), { budgets: structured });
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
      outputSchema: TOOL_OUTPUTS.delete_budget,
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
      return text(`Deleted ${label} monthly budget.`, {
        deleted: true,
        scope: target ?? "overall",
      });
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
      outputSchema: TOOL_OUTPUTS.get_budget_status,
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

      // Catch up any recurring expenses due by today before computing status.
      await store.processDueRecurring(userId, todayISO());

      const budgets = await store.listBudgets(userId);
      if (budgets.length === 0) {
        return text("No budgets set. Use set_budget to create one.", {
          month: m,
          statuses: [],
        });
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
        { month: m, statuses: structured },
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
      outputSchema: TOOL_OUTPUTS.list_categories,
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
      if (groups.length === 0) {
        return text("No expenses recorded yet.", { categories: [] });
      }

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

      return text(lines.join("\n") + "\n\n" + jsonBlock(structured), {
        categories: structured,
      });
    },
  );

  server.registerTool(
    "export_expenses",
    {
      title: "Export expenses",
      description: "Export expenses as CSV or JSON, with an optional date range.",
      inputSchema: TOOL_INPUTS.export_expenses,
      outputSchema: TOOL_OUTPUTS.export_expenses,
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
      if (items.length === 0) {
        return text("No expenses to export.", { format, count: 0 });
      }

      if (format === "json") {
        return text(jsonBlock(items), { format, count: items.length, expenses: items });
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
      const csv = [header, ...rows].join("\n");
      return text("```csv\n" + csv + "\n```", { format, count: items.length, csv });
    },
  );

  // -------------------------------------------------------------------------
  // Income
  // -------------------------------------------------------------------------

  server.registerTool(
    "add_income",
    {
      title: "Add income",
      description:
        "Record a new income entry. Amount is a positive decimal in major " +
        "units (e.g. 2500.00). Date defaults to today.",
      inputSchema: TOOL_INPUTS.add_income,
      outputSchema: TOOL_OUTPUTS.add_income,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ amount, source, description, date, currency }) => {
      const d = date ?? todayISO();
      if (!isValidDate(d)) return fail(`Invalid date "${d}". Use YYYY-MM-DD.`);

      const income = await store.addIncome({
        userId,
        amountMinor: toMinor(amount),
        currency: (currency ?? DEFAULT_CURRENCY).toUpperCase(),
        source: source.trim().toLowerCase(),
        description: description ?? "",
        date: d,
      });
      const viewed = viewIncome(income);

      return text(
        `Added ${formatMoney(income.amountMinor, income.currency)} income from ` +
          `"${income.source}" on ${income.date}.\nID: ${income.id}\n\n` +
          jsonBlock(viewed),
        viewed,
      );
    },
  );

  server.registerTool(
    "list_income",
    {
      title: "List income",
      description:
        "List income entries, newest first, with optional date-range and " +
        "free-text filters.",
      inputSchema: TOOL_INPUTS.list_income,
      outputSchema: TOOL_OUTPUTS.list_income,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ search, from, to, limit }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);

      const items = await store.listIncome(userId, { search, from, to, limit });
      if (items.length === 0) {
        return text("No income found for that filter.", {
          count: 0,
          totals: {},
          income: [],
        });
      }

      const lines = items.map((i) => {
        const note = i.description ? `  ${i.description}` : "";
        return (
          `• ${i.date}  ${formatMoney(i.amountMinor, i.currency).padStart(10)}  ` +
          `[${i.source}]${note}  (${i.id})`
        );
      });
      const totals = totalsByCurrency(items);
      const structured = {
        count: items.length,
        totals: Object.fromEntries(
          Object.entries(totals).map(([c, m]) => [c, toMajor(m)]),
        ),
        income: items.map(viewIncome),
      };

      return text(
        `${items.length} income entrie(s), total ${renderTotals(totals)}:\n` +
          lines.join("\n") +
          "\n\n" +
          jsonBlock(items.map(viewIncome)),
        structured,
      );
    },
  );

  server.registerTool(
    "get_income",
    {
      title: "Get income",
      description: "Fetch a single income entry by its id.",
      inputSchema: TOOL_INPUTS.get_income,
      outputSchema: TOOL_OUTPUTS.get_income,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const income = await store.getIncome(userId, id);
      if (!income) return fail(`No income found with id ${id}.`);
      const viewed = viewIncome(income);
      return text(jsonBlock(viewed), viewed);
    },
  );

  server.registerTool(
    "update_income",
    {
      title: "Update income",
      description:
        "Update fields of an existing income entry. Only provided fields change.",
      inputSchema: TOOL_INPUTS.update_income,
      outputSchema: TOOL_OUTPUTS.update_income,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, amount, source, description, date, currency }) => {
      if (date && !isValidDate(date)) return fail(`Invalid date "${date}".`);
      if (
        amount == null &&
        source == null &&
        description == null &&
        date == null &&
        currency == null
      ) {
        return fail("Provide at least one field to update.");
      }

      const updated = await store.updateIncome(userId, id, {
        amountMinor: amount != null ? toMinor(amount) : undefined,
        source: source?.trim().toLowerCase(),
        description,
        date,
        currency: currency?.toUpperCase(),
      });
      if (!updated) return fail(`No income found with id ${id}.`);

      const viewed = viewIncome(updated);
      return text(`Updated income ${id}.\n\n` + jsonBlock(viewed), viewed);
    },
  );

  server.registerTool(
    "delete_income",
    {
      title: "Delete income",
      description: "Delete an income entry by its id.",
      inputSchema: TOOL_INPUTS.delete_income,
      outputSchema: TOOL_OUTPUTS.delete_income,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const removed = await store.deleteIncome(userId, id);
      return removed
        ? text(`Deleted income ${id}.`, { deleted: true, id })
        : fail(`No income found with id ${id}.`);
    },
  );

  server.registerTool(
    "get_cash_flow",
    {
      title: "Get cash flow",
      description:
        "Compare income against expenses over a date range (defaults to the " +
        "current month) and report the net.",
      inputSchema: TOOL_INPUTS.get_cash_flow,
      outputSchema: TOOL_OUTPUTS.get_cash_flow,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ from, to }) => {
      const rangeFrom = from ?? `${currentMonth()}-01`;
      const rangeTo = to ?? todayISO();
      if (!isValidDate(rangeFrom)) return fail(`Invalid "from" date: ${rangeFrom}`);
      if (!isValidDate(rangeTo)) return fail(`Invalid "to" date: ${rangeTo}`);

      await store.processDueRecurring(userId, todayISO());

      const [incomeItems, expenseItems] = await Promise.all([
        store.listIncome(userId, { from: rangeFrom, to: rangeTo }),
        store.listExpenses(userId, { from: rangeFrom, to: rangeTo }),
      ]);
      const incomeTotals = totalsByCurrency(incomeItems);
      const expenseTotals = totalsByCurrency(expenseItems);
      const currencies = new Set([
        ...Object.keys(incomeTotals),
        ...Object.keys(expenseTotals),
      ]);
      const net: Record<string, number> = {};
      for (const c of currencies) net[c] = (incomeTotals[c] ?? 0) - (expenseTotals[c] ?? 0);

      const toMajorMap = (m: Record<string, number>) =>
        Object.fromEntries(Object.entries(m).map(([c, v]) => [c, toMajor(v)]));
      const structured = {
        range: { from: rangeFrom, to: rangeTo },
        income_total: toMajorMap(incomeTotals),
        expense_total: toMajorMap(expenseTotals),
        net: toMajorMap(net),
      };

      return text(
        `Cash flow ${rangeFrom} to ${rangeTo}:\n` +
          `  Income:   ${renderTotals(incomeTotals)}\n` +
          `  Expenses: ${renderTotals(expenseTotals)}\n` +
          `  Net:      ${renderTotals(net)}\n\n` +
          jsonBlock(structured),
        structured,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Recurring expenses
  // -------------------------------------------------------------------------

  server.registerTool(
    "add_recurring_expense",
    {
      title: "Add recurring expense",
      description:
        "Set up an expense that repeats on a schedule (e.g. rent, subscriptions, " +
        "insurance). Due occurrences are automatically logged as real expenses " +
        "whenever you list expenses or check budget status. Use " +
        "process_recurring_expenses to catch up immediately.",
      inputSchema: TOOL_INPUTS.add_recurring_expense,
      outputSchema: TOOL_OUTPUTS.add_recurring_expense,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ amount, category, description, frequency, start_date, currency }) => {
      const d = start_date ?? todayISO();
      if (!isValidDate(d)) return fail(`Invalid date "${d}". Use YYYY-MM-DD.`);

      const recurring = await store.addRecurringExpense({
        userId,
        amountMinor: toMinor(amount),
        currency: (currency ?? DEFAULT_CURRENCY).toUpperCase(),
        category: category.trim().toLowerCase(),
        description: description ?? "",
        frequency,
        nextDate: d,
      });
      const viewed = viewRecurring(recurring);

      return text(
        `Scheduled a ${recurring.frequency} expense of ` +
          `${formatMoney(recurring.amountMinor, recurring.currency)} for ` +
          `"${recurring.category}", next on ${recurring.nextDate}.\nID: ${recurring.id}\n\n` +
          jsonBlock(viewed),
        viewed,
      );
    },
  );

  server.registerTool(
    "list_recurring_expenses",
    {
      title: "List recurring expenses",
      description:
        "List all recurring expenses (active and paused) with their schedule " +
        "and next occurrence.",
      inputSchema: TOOL_INPUTS.list_recurring_expenses,
      outputSchema: TOOL_OUTPUTS.list_recurring_expenses,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const items = await store.listRecurringExpenses(userId);
      if (items.length === 0) {
        return text(
          "No recurring expenses set up. Use add_recurring_expense to create one.",
          { recurring: [] },
        );
      }

      const lines = items.map((r) => {
        const flag = r.active ? "" : "  (paused)";
        return (
          `• ${formatMoney(r.amountMinor, r.currency).padStart(10)}  [${r.category}]  ` +
          `${r.frequency}, next ${r.nextDate}${flag}  (${r.id})`
        );
      });
      const structured = { recurring: items.map(viewRecurring) };
      return text(lines.join("\n") + "\n\n" + jsonBlock(structured.recurring), structured);
    },
  );

  server.registerTool(
    "update_recurring_expense",
    {
      title: "Update recurring expense",
      description:
        "Update a recurring expense's amount, category, schedule, or " +
        "pause/resume it. Only provided fields change.",
      inputSchema: TOOL_INPUTS.update_recurring_expense,
      outputSchema: TOOL_OUTPUTS.update_recurring_expense,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, amount, category, description, frequency, next_date, active, currency }) => {
      if (next_date && !isValidDate(next_date)) return fail(`Invalid date "${next_date}".`);
      if (
        amount == null &&
        category == null &&
        description == null &&
        frequency == null &&
        next_date == null &&
        active == null &&
        currency == null
      ) {
        return fail("Provide at least one field to update.");
      }

      const updated = await store.updateRecurringExpense(userId, id, {
        amountMinor: amount != null ? toMinor(amount) : undefined,
        category: category?.trim().toLowerCase(),
        description,
        frequency,
        nextDate: next_date,
        active,
        currency: currency?.toUpperCase(),
      });
      if (!updated) return fail(`No recurring expense found with id ${id}.`);

      const viewed = viewRecurring(updated);
      return text(`Updated recurring expense ${id}.\n\n` + jsonBlock(viewed), viewed);
    },
  );

  server.registerTool(
    "delete_recurring_expense",
    {
      title: "Delete recurring expense",
      description:
        "Delete a recurring expense by its id. Already-logged occurrences are " +
        "not affected.",
      inputSchema: TOOL_INPUTS.delete_recurring_expense,
      outputSchema: TOOL_OUTPUTS.delete_recurring_expense,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const removed = await store.deleteRecurringExpense(userId, id);
      return removed
        ? text(`Deleted recurring expense ${id}.`, { deleted: true, id })
        : fail(`No recurring expense found with id ${id}.`);
    },
  );

  server.registerTool(
    "process_recurring_expenses",
    {
      title: "Process due recurring expenses",
      description:
        "Immediately log any recurring expense occurrences due today or " +
        "earlier, instead of waiting for the next automatic check.",
      inputSchema: TOOL_INPUTS.process_recurring_expenses,
      outputSchema: TOOL_OUTPUTS.process_recurring_expenses,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const created = await store.processDueRecurring(userId, todayISO());
      const structured = { count: created.length, expenses: created.map(view) };
      if (created.length === 0) {
        return text("No recurring expenses were due.", structured);
      }
      const totals = totalsByCurrency(created);
      return text(
        `Logged ${created.length} due recurring expense(s), total ` +
          `${renderTotals(totals)}.\n\n` +
          jsonBlock(created.map(view)),
        structured,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Spending trends
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_spending_trends",
    {
      title: "Get spending trends",
      description:
        "Compare this month's spending to your recent trailing average, " +
        "overall and by category. Flags categories spending noticeably more " +
        "than usual — useful for spotting unusual spikes.",
      inputSchema: TOOL_INPUTS.get_spending_trends,
      outputSchema: TOOL_OUTPUTS.get_spending_trends,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ months }) => {
      const nowMonth = currentMonth();
      const monthKeys: string[] = [];
      for (let i = months - 1; i >= 0; i--) monthKeys.push(shiftMonth(nowMonth, -i));
      const priorMonths = monthKeys.slice(0, -1);

      await store.processDueRecurring(userId, todayISO());

      const byMonth = await store.aggregate(userId, {
        groupBy: "month",
        from: `${monthKeys[0]}-01`,
        to: todayISO(),
      });
      const monthTotals = new Map(byMonth.map((g) => [g.key, g.totals]));
      const overall = monthKeys.map((m) => ({
        month: m,
        totals: Object.fromEntries(
          Object.entries(monthTotals.get(m) ?? {}).map(([c, v]) => [c, toMajor(v)]),
        ),
      }));

      const weightOf = (totals: Record<string, number>) =>
        Object.values(totals).reduce((a, b) => a + b, 0);
      const currentWeight = weightOf(monthTotals.get(nowMonth) ?? {});
      const priorWeight =
        priorMonths.length > 0
          ? priorMonths.reduce((a, m) => a + weightOf(monthTotals.get(m) ?? {}), 0) /
            priorMonths.length
          : 0;
      const pctChange =
        priorWeight > 0
          ? ((currentWeight - priorWeight) / priorWeight) * 100
          : currentWeight > 0
            ? 100
            : 0;
      const trend: "up" | "down" | "flat" =
        Math.abs(pctChange) < 5 ? "flat" : pctChange > 0 ? "up" : "down";

      // Per-category: this month vs the trailing average of the prior months.
      const categorySpikes: {
        category: string;
        current_totals: Record<string, number>;
        baseline_avg_totals: Record<string, number>;
        percent_change: number;
      }[] = [];

      if (priorMonths.length > 0) {
        const currentByCat = await store.aggregate(userId, {
          groupBy: "category",
          from: `${nowMonth}-01`,
          to: todayISO(),
        });
        const baselineByCat = await store.aggregate(userId, {
          groupBy: "category",
          from: `${priorMonths[0]}-01`,
          to: `${priorMonths[priorMonths.length - 1]}-31`,
        });
        const baselineMap = new Map(baselineByCat.map((g) => [g.key, g.totals]));

        for (const g of currentByCat) {
          const baselineTotals = baselineMap.get(g.key) ?? {};
          const baselineAvg = Object.fromEntries(
            Object.entries(baselineTotals).map(([c, v]) => [c, v / priorMonths.length]),
          );
          const curW = weightOf(g.totals);
          const baseW = weightOf(baselineAvg);

          // Flag a real spike: at least 50% above the trailing average, and
          // not just noise on a tiny amount (skip anything under ~20 major
          // currency units, i.e. 2000 minor units).
          const isSpike = baseW > 0 ? curW > baseW * 1.5 && curW - baseW > 2000 : curW > 2000;
          if (isSpike) {
            categorySpikes.push({
              category: g.key,
              current_totals: Object.fromEntries(
                Object.entries(g.totals).map(([c, v]) => [c, toMajor(v)]),
              ),
              baseline_avg_totals: Object.fromEntries(
                Object.entries(baselineAvg).map(([c, v]) => [c, toMajor(v)]),
              ),
              percent_change: baseW > 0 ? Math.round(((curW - baseW) / baseW) * 1000) / 10 : 100,
            });
          }
        }
        categorySpikes.sort((a, b) => b.percent_change - a.percent_change);
      }

      const structured = {
        months,
        overall,
        trend,
        percent_change: Math.round(pctChange * 10) / 10,
        category_spikes: categorySpikes,
      };

      const lines = overall.map(
        (o) => `• ${o.month}  ${renderTotals(monthTotals.get(o.month) ?? {})}`,
      );
      const spikeLines = categorySpikes.length
        ? categorySpikes.map(
            (s) =>
              `  ⚠ ${s.category}: ${s.percent_change > 0 ? "+" : ""}${s.percent_change}% ` +
              `vs trailing avg`,
          )
        : ["  none"];

      return text(
        `Spending trend: ${trend} (${structured.percent_change > 0 ? "+" : ""}` +
          `${structured.percent_change}% vs trailing avg)\n` +
          lines.join("\n") +
          "\nCategory spikes:\n" +
          spikeLines.join("\n") +
          "\n\n" +
          jsonBlock(structured),
        structured,
      );
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
