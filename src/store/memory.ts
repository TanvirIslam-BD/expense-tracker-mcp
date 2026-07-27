import { promises as fs } from "node:fs";
import path from "node:path";
import { newId, nextOccurrence } from "../util.js";
import type {
  AggregateGroup,
  AggregateOptions,
  Budget,
  Expense,
  ExpenseFilter,
  ExpensePatch,
  ExpenseStore,
  Income,
  IncomeFilter,
  IncomePatch,
  NewBudget,
  NewExpense,
  NewIncome,
  NewRecurringExpense,
  RecurringExpense,
  RecurringExpensePatch,
} from "./types.js";

interface Db {
  expenses: Expense[];
  budgets: Budget[];
  income: Income[];
  recurring: RecurringExpense[];
}

/** Cap how many missed occurrences one recurring item backfills in a single pass. */
const MAX_RECURRING_CATCHUP = 36;

/**
 * In-memory store with optional JSON-file persistence.
 *
 * This is a dependency-free default that builds and runs anywhere. It is fine
 * for local development and low-volume single-instance hosting. For durable,
 * multi-instance production storage, implement `ExpenseStore` against a real
 * database (see README).
 */
export class MemoryStore implements ExpenseStore {
  private db: Db = { expenses: [], budgets: [], income: [], recurring: [] };
  private readonly file: string | null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    this.file = dataDir ? path.join(dataDir, "expenses.json") : null;
  }

  async init(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Db>;
      this.db = {
        expenses: parsed.expenses ?? [],
        budgets: parsed.budgets ?? [],
        income: parsed.income ?? [],
        recurring: parsed.recurring ?? [],
      };
      console.error(
        `[store] loaded ${this.db.expenses.length} expenses, ${this.db.budgets.length} budgets, ` +
          `${this.db.income.length} income, ${this.db.recurring.length} recurring from ${this.file}`,
      );
    } catch {
      // No file yet (or unreadable) — start empty.
    }
  }

  /** Serialise writes so concurrent mutations can't corrupt the JSON file. */
  private persist(): void {
    if (!this.file) return;
    const snapshot = JSON.stringify(this.db, null, 2);
    const file = this.file;
    this.writeChain = this.writeChain
      .then(() => fs.mkdir(path.dirname(file), { recursive: true }))
      .then(() => fs.writeFile(file, snapshot, "utf8"))
      .catch((e: unknown) => {
        console.error("[store] persist failed:", (e as Error).message);
      });
  }

  async addExpense(input: NewExpense): Promise<Expense> {
    const expense: Expense = {
      ...input,
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    this.db.expenses.push(expense);
    this.persist();
    return expense;
  }

  async addExpenses(inputs: NewExpense[]): Promise<Expense[]> {
    const now = new Date().toISOString();
    const created = inputs.map((input) => ({
      ...input,
      id: newId(),
      createdAt: now,
    }));
    this.db.expenses.push(...created);
    if (created.length > 0) this.persist();
    return created;
  }

  async getExpense(userId: string, id: string): Promise<Expense | null> {
    return (
      this.db.expenses.find((e) => e.userId === userId && e.id === id) ?? null
    );
  }

  async listExpenses(userId: string, filter: ExpenseFilter = {}): Promise<Expense[]> {
    let items = this.db.expenses.filter((e) => e.userId === userId);

    if (filter.category) {
      const c = filter.category.trim().toLowerCase();
      items = items.filter((e) => e.category === c);
    }
    if (filter.from) items = items.filter((e) => e.date >= filter.from!);
    if (filter.to) items = items.filter((e) => e.date <= filter.to!);
    if (filter.search) {
      const q = filter.search.trim().toLowerCase();
      items = items.filter(
        (e) =>
          e.description.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q),
      );
    }

    // Newest first: by date, then createdAt, then insertion order. The index
    // tiebreaker keeps ordering deterministic even when two expenses share a
    // millisecond timestamp (later-inserted wins).
    const ordered = items
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        if (a.e.date !== b.e.date) return b.e.date.localeCompare(a.e.date);
        if (a.e.createdAt !== b.e.createdAt)
          return b.e.createdAt.localeCompare(a.e.createdAt);
        return b.i - a.i;
      })
      .map((x) => x.e);

    return filter.limit != null ? ordered.slice(0, filter.limit) : ordered;
  }

  async updateExpense(
    userId: string,
    id: string,
    patch: ExpensePatch,
  ): Promise<Expense | null> {
    const expense = this.db.expenses.find(
      (e) => e.userId === userId && e.id === id,
    );
    if (!expense) return null;

    if (patch.amountMinor != null) expense.amountMinor = patch.amountMinor;
    if (patch.currency != null) expense.currency = patch.currency;
    if (patch.category != null) expense.category = patch.category;
    if (patch.description != null) expense.description = patch.description;
    if (patch.date != null) expense.date = patch.date;

    this.persist();
    return expense;
  }

  async deleteExpense(userId: string, id: string): Promise<boolean> {
    const before = this.db.expenses.length;
    this.db.expenses = this.db.expenses.filter(
      (e) => !(e.userId === userId && e.id === id),
    );
    const removed = this.db.expenses.length < before;
    if (removed) this.persist();
    return removed;
  }

  async aggregate(
    userId: string,
    opts: AggregateOptions,
  ): Promise<AggregateGroup[]> {
    let items = this.db.expenses.filter((e) => e.userId === userId);
    if (opts.from) items = items.filter((e) => e.date >= opts.from!);
    if (opts.to) items = items.filter((e) => e.date <= opts.to!);

    const map = new Map<string, AggregateGroup>();
    for (const e of items) {
      const key = opts.groupBy === "month" ? e.date.slice(0, 7) : e.category;
      const g = map.get(key) ?? { key, count: 0, totals: {} };
      g.count += 1;
      g.totals[e.currency] = (g.totals[e.currency] ?? 0) + e.amountMinor;
      map.set(key, g);
    }
    return [...map.values()];
  }

  async setBudget(input: NewBudget): Promise<Budget> {
    const existing = this.db.budgets.find(
      (b) => b.userId === input.userId && b.category === input.category,
    );
    if (existing) {
      existing.amountMinor = input.amountMinor;
      existing.currency = input.currency;
      this.persist();
      return existing;
    }
    const budget: Budget = {
      id: newId(),
      userId: input.userId,
      category: input.category,
      amountMinor: input.amountMinor,
      currency: input.currency,
      period: "monthly",
      createdAt: new Date().toISOString(),
    };
    this.db.budgets.push(budget);
    this.persist();
    return budget;
  }

  async listBudgets(userId: string): Promise<Budget[]> {
    return this.db.budgets.filter((b) => b.userId === userId);
  }

  async deleteBudget(userId: string, id: string): Promise<boolean> {
    const before = this.db.budgets.length;
    this.db.budgets = this.db.budgets.filter(
      (b) => !(b.userId === userId && b.id === id),
    );
    const removed = this.db.budgets.length < before;
    if (removed) this.persist();
    return removed;
  }

  async addIncome(input: NewIncome): Promise<Income> {
    const income: Income = {
      ...input,
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    this.db.income.push(income);
    this.persist();
    return income;
  }

  async getIncome(userId: string, id: string): Promise<Income | null> {
    return this.db.income.find((i) => i.userId === userId && i.id === id) ?? null;
  }

  async listIncome(userId: string, filter: IncomeFilter = {}): Promise<Income[]> {
    let items = this.db.income.filter((i) => i.userId === userId);

    if (filter.from) items = items.filter((i) => i.date >= filter.from!);
    if (filter.to) items = items.filter((i) => i.date <= filter.to!);
    if (filter.search) {
      const q = filter.search.trim().toLowerCase();
      items = items.filter(
        (i) =>
          i.description.toLowerCase().includes(q) ||
          i.source.toLowerCase().includes(q),
      );
    }

    const ordered = items
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        if (a.e.date !== b.e.date) return b.e.date.localeCompare(a.e.date);
        if (a.e.createdAt !== b.e.createdAt)
          return b.e.createdAt.localeCompare(a.e.createdAt);
        return b.i - a.i;
      })
      .map((x) => x.e);

    return filter.limit != null ? ordered.slice(0, filter.limit) : ordered;
  }

  async updateIncome(
    userId: string,
    id: string,
    patch: IncomePatch,
  ): Promise<Income | null> {
    const income = this.db.income.find((i) => i.userId === userId && i.id === id);
    if (!income) return null;

    if (patch.amountMinor != null) income.amountMinor = patch.amountMinor;
    if (patch.currency != null) income.currency = patch.currency;
    if (patch.source != null) income.source = patch.source;
    if (patch.description != null) income.description = patch.description;
    if (patch.date != null) income.date = patch.date;

    this.persist();
    return income;
  }

  async deleteIncome(userId: string, id: string): Promise<boolean> {
    const before = this.db.income.length;
    this.db.income = this.db.income.filter(
      (i) => !(i.userId === userId && i.id === id),
    );
    const removed = this.db.income.length < before;
    if (removed) this.persist();
    return removed;
  }

  async addRecurringExpense(input: NewRecurringExpense): Promise<RecurringExpense> {
    const recurring: RecurringExpense = {
      ...input,
      active: input.active ?? true,
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    this.db.recurring.push(recurring);
    this.persist();
    return recurring;
  }

  async listRecurringExpenses(userId: string): Promise<RecurringExpense[]> {
    return this.db.recurring.filter((r) => r.userId === userId);
  }

  async updateRecurringExpense(
    userId: string,
    id: string,
    patch: RecurringExpensePatch,
  ): Promise<RecurringExpense | null> {
    const r = this.db.recurring.find((x) => x.userId === userId && x.id === id);
    if (!r) return null;

    if (patch.amountMinor != null) r.amountMinor = patch.amountMinor;
    if (patch.currency != null) r.currency = patch.currency;
    if (patch.category != null) r.category = patch.category;
    if (patch.description != null) r.description = patch.description;
    if (patch.frequency != null) r.frequency = patch.frequency;
    if (patch.nextDate != null) r.nextDate = patch.nextDate;
    if (patch.active != null) r.active = patch.active;

    this.persist();
    return r;
  }

  async deleteRecurringExpense(userId: string, id: string): Promise<boolean> {
    const before = this.db.recurring.length;
    this.db.recurring = this.db.recurring.filter(
      (r) => !(r.userId === userId && r.id === id),
    );
    const removed = this.db.recurring.length < before;
    if (removed) this.persist();
    return removed;
  }

  async processDueRecurring(userId: string, today: string): Promise<Expense[]> {
    const created: Expense[] = [];
    const now = new Date().toISOString();

    for (const r of this.db.recurring) {
      if (r.userId !== userId || !r.active) continue;
      let guard = 0;
      while (r.nextDate <= today && guard < MAX_RECURRING_CATCHUP) {
        const expense: Expense = {
          id: newId(),
          userId,
          amountMinor: r.amountMinor,
          currency: r.currency,
          category: r.category,
          description: r.description,
          date: r.nextDate,
          createdAt: now,
        };
        this.db.expenses.push(expense);
        created.push(expense);
        r.nextDate = nextOccurrence(r.nextDate, r.frequency);
        guard++;
      }
    }

    if (created.length > 0) this.persist();
    return created;
  }
}
