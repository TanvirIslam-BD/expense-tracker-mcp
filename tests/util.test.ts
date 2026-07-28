import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
  toMinor,
  toMajor,
  formatMoney,
  todayISO,
  currentMonth,
  monthOf,
  isValidDate,
  isValidMonth,
  resolveUserId,
  categorize,
  resolveCategory,
  view,
} from "../src/util.js";
import type { Expense } from "../src/store/types.js";
import { createDashboardSessionToken, verifyDashboardSessionToken } from "../src/dashboard-auth.js";

/** Minimal Express-Request stand-in exposing case-insensitive header lookup. */
function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

describe("money", () => {
  it("round-trips major <-> minor without float drift", () => {
    expect(toMinor(12.5)).toBe(1250);
    expect(toMinor(0.1)).toBe(10);
    expect(toMajor(1250)).toBe(12.5);
    // The classic 0.1 + 0.2 problem stays exact in minor units.
    expect(toMajor(toMinor(0.1) + toMinor(0.2))).toBe(0.3);
  });

  it("rounds to the nearest minor unit", () => {
    expect(toMinor(9.999)).toBe(1000); // rounds up
    expect(toMinor(9.994)).toBe(999); // rounds down
  });

  it("formats known currencies and falls back for malformed ones", () => {
    expect(formatMoney(1250, "USD")).toBe("$12.50");
    // A well-formed but unknown code is used as-is by Intl (no throw).
    expect(formatMoney(1250, "ZZZ")).toContain("12.50");
    // A malformed code makes Intl throw -> plain fallback, never crashes.
    expect(formatMoney(1250, "BADCODE")).toBe("12.50 BADCODE");
  });
});

describe("dates", () => {
  it("validates YYYY-MM-DD", () => {
    expect(isValidDate("2026-07-24")).toBe(true);
    expect(isValidDate("2026-13-01")).toBe(false); // month 13
    expect(isValidDate("2026-7-1")).toBe(false); // not zero-padded
    expect(isValidDate("not-a-date")).toBe(false);
    expect(isValidDate("2026-02-30")).toBe(false); // Feb 30 doesn't exist
  });

  it("validates YYYY-MM", () => {
    expect(isValidMonth("2026-07")).toBe(true);
    expect(isValidMonth("2026-7")).toBe(false);
    expect(isValidMonth("2026-07-01")).toBe(false);
  });

  it("derives month + current values in the right shape", () => {
    expect(monthOf("2026-07-24")).toBe("2026-07");
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
    expect(currentMonth()).toBe(todayISO().slice(0, 7));
  });
});

describe("resolveUserId", () => {
  it("prioritises x-mcpize-user-id (MCPize's stable subscriber id) above all", () => {
    // Even with other id headers and a rotating auth token present, the
    // MCPize subscriber id must win — this is the fix for the isolation bug.
    expect(
      resolveUserId(
        fakeReq({
          "x-mcpize-user-id": "uuid-sub-1",
          "x-user-id": "bob",
          authorization: "Bearer rotating-token",
        }),
      ),
    ).toBe("uuid-sub-1");
  });

  it("prefers explicit user headers", () => {
    expect(resolveUserId(fakeReq({ "x-mcpize-user": "alice" }))).toBe("alice");
    expect(resolveUserId(fakeReq({ "x-user-id": "bob" }))).toBe("bob");
  });

  it("hashes a stable auth token into a stable, isolating id", () => {
    const a1 = resolveUserId(fakeReq({ authorization: "Bearer token-A" }));
    const a2 = resolveUserId(fakeReq({ authorization: "Bearer token-A" }));
    const b = resolveUserId(fakeReq({ authorization: "Bearer token-B" }));
    expect(a1).toBe(a2); // stable for the same token
    expect(a1).not.toBe(b); // different token -> different bucket (no co-mingling)
    expect(a1?.startsWith("u_")).toBe(true);
  });

  it("FAILS CLOSED (null) when unidentified and no DEFAULT_USER_ID", () => {
    const saved = process.env.DEFAULT_USER_ID;
    delete process.env.DEFAULT_USER_ID;
    // No stable bucket for anonymous callers — a finance server must not
    // co-mingle unidentified users.
    expect(resolveUserId(fakeReq({}))).toBeNull();
    if (saved !== undefined) process.env.DEFAULT_USER_ID = saved;
  });

  it("uses DEFAULT_USER_ID as an opt-in single-user fallback", () => {
    const saved = process.env.DEFAULT_USER_ID;
    process.env.DEFAULT_USER_ID = "solo";
    expect(resolveUserId(fakeReq({}))).toBe("solo");
    if (saved === undefined) delete process.env.DEFAULT_USER_ID;
    else process.env.DEFAULT_USER_ID = saved;
  });
});

describe("dashboard session links", () => {
  it("accepts a current signed token and rejects tampered or expired tokens", () => {
    const token = createDashboardSessionToken("subscriber-1", "test-dashboard-secret");
    expect(verifyDashboardSessionToken(token, "test-dashboard-secret")).toBe("subscriber-1");
    expect(verifyDashboardSessionToken(`${token}x`, "test-dashboard-secret")).toBeNull();
    const expired = createDashboardSessionToken("subscriber-1", "test-dashboard-secret", -1);
    expect(verifyDashboardSessionToken(expired, "test-dashboard-secret")).toBeNull();
  });
});

describe("categorize / resolveCategory", () => {
  it("infers a category from keywords in the note", () => {
    expect(categorize("Morning latte")).toBe("food");
    expect(categorize("Uber to the airport")).toBe("transport");
    expect(categorize("Monthly rent payment")).toBe("rent");
    expect(categorize("Netflix subscription")).toBe("entertainment");
    expect(categorize("Amazon order")).toBe("shopping");
  });

  it("falls back to 'uncategorized' when nothing matches or note is empty", () => {
    expect(categorize("")).toBe("uncategorized");
    expect(categorize(null)).toBe("uncategorized");
    expect(categorize("qwerty zxcv")).toBe("uncategorized");
  });

  it("resolveCategory prefers an explicit category, else infers", () => {
    expect(resolveCategory("Groceries", "latte")).toBe("groceries"); // explicit wins, normalised
    expect(resolveCategory("  ", "uber ride")).toBe("transport"); // blank -> infer
    expect(resolveCategory(undefined, "nothing here")).toBe("uncategorized");
  });
});

describe("view", () => {
  it("maps to major units and hides the internal userId", () => {
    const e: Expense = {
      id: "x1",
      userId: "secret-user",
      amountMinor: 4999,
      currency: "USD",
      category: "food",
      description: "dinner",
      date: "2026-07-01",
      createdAt: "2026-07-01T10:00:00.000Z",
    };
    const v = view(e);
    expect(v).toEqual({
      id: "x1",
      date: "2026-07-01",
      category: "food",
      description: "dinner",
      amount: 49.99,
      currency: "USD",
    });
    expect(v).not.toHaveProperty("userId");
    expect(v).not.toHaveProperty("amountMinor");
  });
});
