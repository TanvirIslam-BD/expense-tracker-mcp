import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/store/memory.js";
import type { NewExpense } from "../src/store/types.js";

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

describe("MemoryStore — expenses", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
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

  it("searches description and category case-insensitively", async () => {
    await store.addExpense(expense({ category: "food", description: "Morning Latte" }));
    await store.addExpense(expense({ category: "transport", description: "taxi" }));

    expect((await store.listExpenses("alice", { search: "latte" })).length).toBe(1);
    expect((await store.listExpenses("alice", { search: "TRANS" })).length).toBe(1); // by category
    expect((await store.listExpenses("alice", { search: "coffee" })).length).toBe(0);
  });

  it("addExpenses inserts a batch and returns them", async () => {
    const created = await store.addExpenses([
      expense({ description: "a" }),
      expense({ description: "b", category: "transport" }),
    ]);
    expect(created.length).toBe(2);
    expect(created.every((e) => e.id && e.createdAt)).toBe(true);
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
});

describe("MemoryStore — budgets", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
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

describe("MemoryStore — JSON persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "expense-store-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists across store instances sharing a DATA_DIR", async () => {
    const first = new MemoryStore(dir);
    await first.init();
    const e = await first.addExpense(expense({ description: "persist-me" }));
    await first.setBudget({ userId: "alice", category: "food", amountMinor: 10000, currency: "USD" });

    // Give the serialised write chain a chance to flush.
    await new Promise((r) => setTimeout(r, 50));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "expenses.json"), "utf8"));
    expect(onDisk.expenses.length).toBe(1);

    const second = new MemoryStore(dir);
    await second.init();
    const loaded = await second.getExpense("alice", e.id);
    expect(loaded?.description).toBe("persist-me");
    expect((await second.listBudgets("alice")).length).toBe(1);
  });
});
