import { createClient, type Client } from "@libsql/client";
import { newId } from "../util.js";
import type {
  Budget,
  Expense,
  ExpenseFilter,
  ExpensePatch,
  ExpenseStore,
  NewBudget,
  NewExpense,
} from "./types.js";

/**
 * SQLite/libSQL-backed store. Works identically against:
 *  - a local file (`file:./data.db`) or in-memory DB (`file::memory:`) for
 *    dependency-free local dev and tests, or
 *  - a remote Turso database (`libsql://...`, with an auth token) for durable
 *    storage across process restarts and multiple instances.
 *
 * This is the fix for MemoryStore's core limitation on serverless hosting
 * (MCPize/Cloud Run "scale to zero"): an in-process Map is wiped whenever the
 * instance is recycled. A real database survives that, because it lives
 * outside the process.
 */
export class TursoStore implements ExpenseStore {
  private readonly client: Client;

  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, authToken });
  }

  async init(): Promise<void> {
    // Run all schema statements in a single round trip. On a cold start the DB
    // may be a cross-region hop, so collapsing 3 sequential round trips into 1
    // meaningfully cuts the first-request latency after a scale-to-zero wake.
    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses (user_id, date)",
        `CREATE TABLE IF NOT EXISTS budgets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category TEXT,
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          period TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (user_id, category)
        )`,
      ],
      "write",
    );
  }

  private rowToExpense(row: Record<string, unknown>): Expense {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      amountMinor: Number(row.amount_minor),
      currency: row.currency as string,
      category: row.category as string,
      description: row.description as string,
      date: row.date as string,
      createdAt: row.created_at as string,
    };
  }

  private rowToBudget(row: Record<string, unknown>): Budget {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      category: (row.category as string | null) ?? null,
      amountMinor: Number(row.amount_minor),
      currency: row.currency as string,
      period: row.period as "monthly",
      createdAt: row.created_at as string,
    };
  }

  async addExpense(input: NewExpense): Promise<Expense> {
    const expense: Expense = {
      ...input,
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    await this.client.execute({
      sql: `INSERT INTO expenses
              (id, user_id, amount_minor, currency, category, description, date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        expense.id,
        expense.userId,
        expense.amountMinor,
        expense.currency,
        expense.category,
        expense.description,
        expense.date,
        expense.createdAt,
      ],
    });
    return expense;
  }

  async addExpenses(inputs: NewExpense[]): Promise<Expense[]> {
    const now = new Date().toISOString();
    const created: Expense[] = inputs.map((input) => ({
      ...input,
      id: newId(),
      createdAt: now,
    }));
    if (created.length === 0) return [];

    // One round trip for the whole batch (transactional) rather than N inserts.
    await this.client.batch(
      created.map((e) => ({
        sql: `INSERT INTO expenses
                (id, user_id, amount_minor, currency, category, description, date, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          e.id,
          e.userId,
          e.amountMinor,
          e.currency,
          e.category,
          e.description,
          e.date,
          e.createdAt,
        ],
      })),
      "write",
    );
    return created;
  }

  async getExpense(userId: string, id: string): Promise<Expense | null> {
    const r = await this.client.execute({
      sql: "SELECT * FROM expenses WHERE user_id = ? AND id = ?",
      args: [userId, id],
    });
    return r.rows.length ? this.rowToExpense(r.rows[0] as unknown as Record<string, unknown>) : null;
  }

  async listExpenses(userId: string, filter: ExpenseFilter = {}): Promise<Expense[]> {
    const clauses = ["user_id = ?"];
    const args: (string | number)[] = [userId];

    if (filter.category) {
      clauses.push("category = ?");
      args.push(filter.category.trim().toLowerCase());
    }
    if (filter.from) {
      clauses.push("date >= ?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("date <= ?");
      args.push(filter.to);
    }
    if (filter.search) {
      clauses.push("(lower(description) LIKE ? OR lower(category) LIKE ?)");
      const like = `%${filter.search.trim().toLowerCase()}%`;
      args.push(like, like);
    }

    // Newest first: date, then created_at, then rowid — rowid strictly
    // increases with insertion order, giving a deterministic tiebreak for
    // same-day/same-timestamp expenses (mirrors MemoryStore's ordering).
    let sql = `SELECT * FROM expenses WHERE ${clauses.join(" AND ")}
               ORDER BY date DESC, created_at DESC, rowid DESC`;
    if (filter.limit != null) {
      sql += " LIMIT ?";
      args.push(filter.limit);
    }

    const r = await this.client.execute({ sql, args });
    return r.rows.map((row) => this.rowToExpense(row as unknown as Record<string, unknown>));
  }

  async updateExpense(
    userId: string,
    id: string,
    patch: ExpensePatch,
  ): Promise<Expense | null> {
    const existing = await this.getExpense(userId, id);
    if (!existing) return null;

    const updated: Expense = {
      ...existing,
      amountMinor: patch.amountMinor ?? existing.amountMinor,
      currency: patch.currency ?? existing.currency,
      category: patch.category ?? existing.category,
      description: patch.description ?? existing.description,
      date: patch.date ?? existing.date,
    };

    await this.client.execute({
      sql: `UPDATE expenses
            SET amount_minor = ?, currency = ?, category = ?, description = ?, date = ?
            WHERE user_id = ? AND id = ?`,
      args: [
        updated.amountMinor,
        updated.currency,
        updated.category,
        updated.description,
        updated.date,
        userId,
        id,
      ],
    });
    return updated;
  }

  async deleteExpense(userId: string, id: string): Promise<boolean> {
    const r = await this.client.execute({
      sql: "DELETE FROM expenses WHERE user_id = ? AND id = ?",
      args: [userId, id],
    });
    return r.rowsAffected > 0;
  }

  async setBudget(input: NewBudget): Promise<Budget> {
    const existing = await this.client.execute({
      sql: input.category === null
        ? "SELECT * FROM budgets WHERE user_id = ? AND category IS NULL"
        : "SELECT * FROM budgets WHERE user_id = ? AND category = ?",
      args: input.category === null ? [input.userId] : [input.userId, input.category],
    });

    if (existing.rows.length) {
      const row = existing.rows[0] as unknown as Record<string, unknown>;
      await this.client.execute({
        sql: "UPDATE budgets SET amount_minor = ?, currency = ? WHERE id = ?",
        args: [input.amountMinor, input.currency, row.id as string],
      });
      return { ...this.rowToBudget(row), amountMinor: input.amountMinor, currency: input.currency };
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
    await this.client.execute({
      sql: `INSERT INTO budgets (id, user_id, category, amount_minor, currency, period, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        budget.id,
        budget.userId,
        budget.category,
        budget.amountMinor,
        budget.currency,
        budget.period,
        budget.createdAt,
      ],
    });
    return budget;
  }

  async listBudgets(userId: string): Promise<Budget[]> {
    const r = await this.client.execute({
      sql: "SELECT * FROM budgets WHERE user_id = ?",
      args: [userId],
    });
    return r.rows.map((row) => this.rowToBudget(row as unknown as Record<string, unknown>));
  }

  async deleteBudget(userId: string, id: string): Promise<boolean> {
    const r = await this.client.execute({
      sql: "DELETE FROM budgets WHERE user_id = ? AND id = ?",
      args: [userId, id],
    });
    return r.rowsAffected > 0;
  }

  /** Releases the underlying connection/file handle. Mainly useful for tests. */
  close(): void {
    this.client.close();
  }
}
