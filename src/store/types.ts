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
  offset?: number;
}

export interface NewBudget {
  userId: string;
  category: string | null;
  amountMinor: number;
  currency: string;
}

/** Extended finance entities are stored as one durable, per-user document.
 * Keeping them together lets the MCP layer evolve without breaking the small,
 * highly-optimised expense and budget tables used by existing installations. */
export interface IncomeRecord {
  id: string;
  amountMinor: number;
  currency: string;
  source: string;
  date: string;
  notes: string;
  createdAt: string;
}

export interface RecurringTransaction {
  id: string;
  kind: "expense" | "income";
  amountMinor: number;
  currency: string;
  category: string;
  description: string;
  merchant: string;
  frequency: "weekly" | "monthly" | "yearly";
  nextDate: string;
  active: boolean;
  createdAt: string;
}

export interface BudgetRule {
  id: string;
  category: string | null;
  amountMinor: number;
  currency: string;
  period: "weekly" | "monthly" | "yearly" | "custom";
  startDate?: string;
  endDate?: string;
  rollover: "reset" | "carry";
  createdAt: string;
}

export interface CategorySettings {
  category: string;
  limitMinor?: number;
  currency?: string;
  color?: string;
}

export interface BudgetTemplate {
  name: string;
  rules: Omit<BudgetRule, "id" | "createdAt">[];
}

export interface FinanceState {
  incomes: IncomeRecord[];
  recurring: RecurringTransaction[];
  budgetRules: BudgetRule[];
  categories: CategorySettings[];
  templates: BudgetTemplate[];
  alertThresholds: number[];
  expenseMetadata?: Record<string, { merchant?: string; paymentMethod?: string; tags?: string[] }>;
  notificationEmail?: string;
  emailAlertsEnabled?: boolean;
  /** Alert deduplication keys, e.g. 2026-07:overall:USD:100. */
  sentAlertKeys?: string[];
}

export const EMPTY_FINANCE_STATE: FinanceState = {
  incomes: [],
  recurring: [],
  budgetRules: [],
  categories: [],
  templates: [],
  alertThresholds: [50, 80, 100],
  expenseMetadata: {},
  emailAlertsEnabled: false,
  sentAlertKeys: [],
};

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

  getUserAccessStatus(userId: string): Promise<"active" | "suspended">;
  recordActivity(userId: string, source: string, eventType: string, detail?: Record<string, unknown>): Promise<void>;
  /**
   * Whether the dashboard holds a name and a contact address for this user.
   *
   * Used only to decide whether to append the profile nudge to a tool result.
   * Returns `true` when it cannot tell -- an unreachable database must not put a
   * nag on every response.
   */
  hasContactDetails(userId: string): Promise<boolean>;

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

  getFinanceState(userId: string): Promise<FinanceState>;
  setFinanceState(userId: string, state: FinanceState): Promise<void>;

  /**
   * Permanently erases every expense, budget, and finance-state record for
   * this user — the full data-deletion path the privacy policy promises.
   * Does not touch account/activity history (app_users, app_activity in
   * TursoStore), which is operational/audit data outside this interface.
   */
  deleteAllUserData(userId: string): Promise<{ expensesDeleted: number; budgetsDeleted: number }>;
}
