// Domain types and the storage contract. Keeping the store behind an interface
// means the default in-memory implementation can be swapped for Postgres, Turso,
// etc. without touching the MCP tool layer.

export interface Expense {
  id: string;
  userId: string;
  /** Amount in integer minor units (e.g. cents). */
  amountMinor: number;
  /** ISO-4217 currency code, uppercased. */
  currency: string;
  /** Category, normalised to lowercase. */
  category: string;
  description: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  /** ISO-8601 timestamp of when the record was created. */
  createdAt: string;
}

export interface Budget {
  id: string;
  userId: string;
  /** null = an overall (all-categories) budget. */
  category: string | null;
  amountMinor: number;
  currency: string;
  /** Only monthly budgets are supported today. */
  period: "monthly";
  createdAt: string;
}

export type NewExpense = Omit<Expense, "id" | "createdAt">;

export interface ExpensePatch {
  amountMinor?: number;
  currency?: string;
  category?: string;
  description?: string;
  date?: string;
}

export interface ExpenseFilter {
  category?: string;
  /** Inclusive start date, YYYY-MM-DD. */
  from?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  to?: string;
  /** Case-insensitive substring matched against description and category. */
  search?: string;
  limit?: number;
}

export interface NewBudget {
  userId: string;
  category: string | null;
  amountMinor: number;
  currency: string;
}

/** One aggregation bucket: a group key with its count and per-currency totals. */
export interface AggregateGroup {
  /** The category name or `YYYY-MM` month, depending on how it was grouped. */
  key: string;
  count: number;
  /** currency code -> summed amount in minor units. */
  totals: Record<string, number>;
}

export interface AggregateOptions {
  groupBy: "category" | "month";
  /** Inclusive start date, YYYY-MM-DD. */
  from?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  to?: string;
}

export interface ExpenseStore {
  init(): Promise<void>;

  addExpense(expense: NewExpense): Promise<Expense>;
  /** Insert several expenses at once (one round trip where the backend supports it). */
  addExpenses(expenses: NewExpense[]): Promise<Expense[]>;
  getExpense(userId: string, id: string): Promise<Expense | null>;
  listExpenses(userId: string, filter?: ExpenseFilter): Promise<Expense[]>;
  updateExpense(userId: string, id: string, patch: ExpensePatch): Promise<Expense | null>;
  deleteExpense(userId: string, id: string): Promise<boolean>;

  /**
   * Aggregate spending grouped by category or month, summed per currency.
   * Pushed to the storage layer (SQL GROUP BY where supported) so summaries
   * scale with the number of groups, not the number of rows.
   */
  aggregate(userId: string, opts: AggregateOptions): Promise<AggregateGroup[]>;

  /** Upserts by (userId, category) — one budget per category (or overall). */
  setBudget(budget: NewBudget): Promise<Budget>;
  listBudgets(userId: string): Promise<Budget[]>;
  deleteBudget(userId: string, id: string): Promise<boolean>;
}
