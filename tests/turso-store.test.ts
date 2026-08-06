import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TursoStore } from "../src/store/turso.js";
import type { NewExpense } from "../src/store/types.js";

// These tests run against an embedded, in-process SQLite database
// (`file::memory:`) rather than a real network Turso instance — libSQL speaks
// the same protocol either way, so this exercises the real query logic
// without needing credentials or network access.

function expense(over: Partial<NewExpense> = {}): NewExpense {
  return {
    userId: "alice",
    amountMinor: 1000,
    currency: "USD",
    category: "food",
    description: "",
    date: "2026-07-10",
    ...over,
  };
}

describe("TursoStore — expenses", () => {
  let store: TursoStore;

  beforeEach(async () => {
    store = new TursoStore("file::memory:");
    await store.init();
  });

  it("adds an expense with a generated id and createdAt", async () => {
    const e = await store.addExpense(expense());
    expect(e.id).toBeTruthy();
    expect(e.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await store.getExpense("alice", e.id)).toEqual(e);
  });

  it("returns null for a missing / wrong-user expense", async () => {
    const e = await store.addExpense(expense());
    expect(await store.getExpense("alice", "nope")).toBeNull();
    expect(await store.getExpense("bob", e.id)).toBeNull();
  });

  it("lists newest first (by date, then insertion order)", async () => {
    await store.addExpense(expense({ date: "2026-07-01", description: "first" }));
    await store.addExpense(expense({ date: "2026-07-20", description: "latest" }));
    const mid1 = await store.addExpense(expense({ date: "2026-07-10", description: "mid-a" }));
    const mid2 = await store.addExpense(expense({ date: "2026-07-10", description: "mid-b" }));

    const list = await store.listExpenses("alice");
    expect(list.map((e) => e.description)).toEqual([
      "latest",
      "mid-b", // same date -> later insertion first
      "mid-a",
      "first",
    ]);
    expect(mid2.createdAt >= mid1.createdAt).toBe(true);
  });

  it("filters by category (case-insensitive), date range, and limit", async () => {
    await store.addExpense(expense({ category: "food", date: "2026-07-01" }));
    await store.addExpense(expense({ category: "transport", date: "2026-07-15" }));
    await store.addExpense(expense({ category: "food", date: "2026-08-01" }));

    expect((await store.listExpenses("alice", { category: "FOOD" })).length).toBe(2);
    expect(
      (await store.listExpenses("alice", { from: "2026-07-01", to: "2026-07-31" })).length,
    ).toBe(2);
    expect((await store.listExpenses("alice", { limit: 1 })).length).toBe(1);
  });

  it("searches description and category via SQL LIKE (case-insensitive)", async () => {
    await store.addExpense(expense({ category: "food", description: "Morning Latte" }));
    await store.addExpense(expense({ category: "transport", description: "taxi" }));

    expect((await store.listExpenses("alice", { search: "latte" })).length).toBe(1);
    expect((await store.listExpenses("alice", { search: "TRANS" })).length).toBe(1);
    expect((await store.listExpenses("alice", { search: "coffee" })).length).toBe(0);
  });

  it("addExpenses inserts a batch in one round trip", async () => {
    const created = await store.addExpenses([
      expense({ description: "a" }),
      expense({ description: "b", category: "transport" }),
    ]);
    expect(created.length).toBe(2);
    expect((await store.listExpenses("alice")).length).toBe(2);
    expect(await store.addExpenses([])).toEqual([]);
  });

  it("updates only the provided fields", async () => {
    const e = await store.addExpense(expense({ amountMinor: 1000, category: "food" }));
    const updated = await store.updateExpense("alice", e.id, { amountMinor: 2500 });
    expect(updated?.amountMinor).toBe(2500);
    expect(updated?.category).toBe("food"); // untouched
    expect(await store.updateExpense("alice", "missing", { amountMinor: 1 })).toBeNull();
  });

  it("deletes and reports whether anything was removed", async () => {
    const e = await store.addExpense(expense());
    expect(await store.deleteExpense("alice", e.id)).toBe(true);
    expect(await store.deleteExpense("alice", e.id)).toBe(false);
    expect(await store.getExpense("alice", e.id)).toBeNull();
  });

  it("isolates data between users", async () => {
    await store.addExpense(expense({ userId: "alice" }));
    await store.addExpense(expense({ userId: "alice" }));
    await store.addExpense(expense({ userId: "bob" }));

    expect((await store.listExpenses("alice")).length).toBe(2);
    expect((await store.listExpenses("bob")).length).toBe(1);
    expect((await store.listExpenses("carol")).length).toBe(0);
  });

  it("aggregates by category and by month via SQL GROUP BY", async () => {
    await store.addExpense(expense({ category: "food", amountMinor: 1000, date: "2026-07-01" }));
    await store.addExpense(expense({ category: "food", amountMinor: 500, date: "2026-07-05" }));
    await store.addExpense(expense({ category: "transport", amountMinor: 2000, date: "2026-08-02" }));
    // A second currency in the same category must fold into its own bucket key.
    await store.addExpense(expense({ category: "food", amountMinor: 300, currency: "EUR", date: "2026-07-09" }));

    const byCat = await store.aggregate("alice", { groupBy: "category" });
    const food = byCat.find((g) => g.key === "food")!;
    expect(food.count).toBe(3);
    expect(food.totals.USD).toBe(1500);
    expect(food.totals.EUR).toBe(300);
    expect(byCat.find((g) => g.key === "transport")!.totals.USD).toBe(2000);

    const byMonth = await store.aggregate("alice", { groupBy: "month" });
    expect(byMonth.find((g) => g.key === "2026-07")!.count).toBe(3);
    expect(byMonth.find((g) => g.key === "2026-08")!.count).toBe(1);

    // Date range is honored.
    const july = await store.aggregate("alice", { groupBy: "category", from: "2026-07-01", to: "2026-07-31" });
    expect(july.some((g) => g.key === "transport")).toBe(false);
  });
});

describe("TursoStore — budgets", () => {
  let store: TursoStore;

  beforeEach(async () => {
    store = new TursoStore("file::memory:");
    await store.init();
  });

  it("upserts by (user, category) instead of duplicating", async () => {
    await store.setBudget({ userId: "alice", category: "food", amountMinor: 10000, currency: "USD" });
    await store.setBudget({ userId: "alice", category: "food", amountMinor: 15000, currency: "USD" });
    const budgets = await store.listBudgets("alice");
    expect(budgets.length).toBe(1);
    expect(budgets[0].amountMinor).toBe(15000);
  });

  it("treats overall (null category) and per-category budgets as distinct", async () => {
    await store.setBudget({ userId: "alice", category: null, amountMinor: 200000, currency: "USD" });
    await store.setBudget({ userId: "alice", category: "food", amountMinor: 10000, currency: "USD" });
    const budgets = await store.listBudgets("alice");
    expect(budgets.length).toBe(2);
    const categories = budgets.map((b) => b.category);
    expect(categories).toContain(null);
    expect(categories).toContain("food");
  });

  it("isolates budgets between users", async () => {
    await store.setBudget({ userId: "alice", category: null, amountMinor: 100, currency: "USD" });
    expect((await store.listBudgets("bob")).length).toBe(0);
  });
});

describe("TursoStore — deleteAllUserData", () => {
  let store: TursoStore;

  beforeEach(async () => {
    store = new TursoStore("file::memory:");
    await store.init();
  });

  it("wipes expenses, budgets, and finance state for one user without touching another", async () => {
    await store.addExpenses([expense({ userId: "alice" }), expense({ userId: "alice" }), expense({ userId: "bob" })]);
    await store.setBudget({ userId: "alice", category: "food", amountMinor: 10000, currency: "USD" });
    await store.setBudget({ userId: "bob", category: "food", amountMinor: 5000, currency: "USD" });
    await store.setFinanceState("alice", { ...(await store.getFinanceState("alice")), notificationEmail: "alice@example.com" });

    const result = await store.deleteAllUserData("alice");
    expect(result).toEqual({ expensesDeleted: 2, budgetsDeleted: 1 });

    expect(await store.listExpenses("alice")).toEqual([]);
    expect(await store.listBudgets("alice")).toEqual([]);
    expect((await store.getFinanceState("alice")).notificationEmail).toBeUndefined();

    // Bob's data survives untouched.
    expect((await store.listExpenses("bob")).length).toBe(1);
    expect((await store.listBudgets("bob")).length).toBe(1);
  });

  it("is a safe no-op for a user with no data", async () => {
    expect(await store.deleteAllUserData("nobody")).toEqual({ expensesDeleted: 0, budgetsDeleted: 0 });
  });
});

describe("TursoStore — persistence across restarts (the scale-to-zero fix)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "expense-turso-"));
  });

  afterEach(async () => {
    // On Windows, the native libSQL binding can hold its file handle open
    // briefly after close() returns. This cleanup is best-effort — retry a
    // few times, but don't fail the test over a leftover temp-dir; the OS
    // temp directory gets reaped on its own regardless.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it("survives a fresh store instance pointed at the same file (simulated restart)", async () => {
    const dbFile = `file:${path.join(dir, "data.db").replace(/\\/g, "/")}`;

    const first = new TursoStore(dbFile);
    await first.init();
    const e = await first.addExpense(expense({ description: "persist-me" }));
    await first.setBudget({ userId: "alice", category: "food", amountMinor: 10000, currency: "USD" });
    first.close();
    // The native binding releases its file handle asynchronously even though
    // close() itself returns synchronously — give it a tick before reopening.
    await new Promise((r) => setTimeout(r, 50));

    // A brand-new store instance against the same file simulates exactly what
    // happens when Cloud Run recycles the container: the process (and any
    // in-memory state) is gone, but the database file is not.
    const second = new TursoStore(dbFile);
    await second.init();
    const loaded = await second.getExpense("alice", e.id);
    expect(loaded?.description).toBe("persist-me");
    expect((await second.listBudgets("alice")).length).toBe(1);
    second.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
