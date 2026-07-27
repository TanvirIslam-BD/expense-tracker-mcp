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

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

export interface Income {
  id: string;
  userId: string;
  /** Amount in integer minor units (e.g. cents). */
  amountMinor: number;
  /** ISO-4217 currency code, uppercased. */
  currency: string;
  /** Where the income came from, normalised to lowercase (e.g. salary, freelance). */
  source: string;
  description: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  createdAt: string;
}

export type NewIncome = Omit<Income, "id" | "createdAt">;

export interface IncomePatch {
  amountMinor?: number;
  currency?: string;
  source?: string;
  description?: string;
  date?: string;
}

export interface IncomeFilter {
  /** Inclusive start date, YYYY-MM-DD. */
  from?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  to?: string;
  /** Case-insensitive substring matched against description and source. */
  search?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Recurring expenses — a schedule that materializes into real Expense rows
// when due. There's no background cron in this stateless deployment, so
// materialization happens lazily: whenever a request touches a user's
// expenses (see ExpenseStore.processDueRecurring), any occurrences due as of
// that moment get logged and the schedule advances.
// ---------------------------------------------------------------------------

export type RecurringFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface RecurringExpense {
  id: string;
  userId: string;
  amountMinor: number;
  currency: string;
  category: string;
  description: string;
  frequency: RecurringFrequency;
  /** Calendar date, YYYY-MM-DD, of the next occurrence still to be logged. */
  nextDate: string;
  active: boolean;
  createdAt: string;
}

export type NewRecurringExpense = Omit<
  RecurringExpense,
  "id" | "createdAt" | "active"
> & { active?: boolean };

export interface RecurringExpensePatch {
  amountMinor?: number;
  currency?: string;
  category?: string;
  description?: string;
  frequency?: RecurringFrequency;
  nextDate?: string;
  active?: boolean;
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

  addIncome(income: NewIncome): Promise<Income>;
  getIncome(userId: string, id: string): Promise<Income | null>;
  listIncome(userId: string, filter?: IncomeFilter): Promise<Income[]>;
  updateIncome(userId: string, id: string, patch: IncomePatch): Promise<Income | null>;
  deleteIncome(userId: string, id: string): Promise<boolean>;

  addRecurringExpense(input: NewRecurringExpense): Promise<RecurringExpense>;
  listRecurringExpenses(userId: string): Promise<RecurringExpense[]>;
  updateRecurringExpense(
    userId: string,
    id: string,
    patch: RecurringExpensePatch,
  ): Promise<RecurringExpense | null>;
  deleteRecurringExpense(userId: string, id: string): Promise<boolean>;
  /**
   * Materialize any occurrences due on or before `today` into real Expense
   * rows, advancing each schedule's nextDate past `today`. Returns the newly
   * created expenses.
   */
  processDueRecurring(userId: string, today: string): Promise<Expense[]>;
}
