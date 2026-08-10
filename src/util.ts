import { randomUUID, createHash } from "node:crypto";
import type { Request } from "express";
import type { Expense } from "./store/types.js";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Money — stored internally as integer minor units (e.g. cents) to avoid the
// floating-point drift you get from summing decimals.
// ---------------------------------------------------------------------------

export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function toMajor(minor: number): number {
  return Math.round(minor) / 100;
}

export function formatMoney(minor: number, currency: string): string {
  const major = toMajor(minor);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(major);
  } catch {
    // Unknown/invalid currency code — fall back to a plain rendering.
    return `${major.toFixed(2)} ${currency}`;
  }
}

// ---------------------------------------------------------------------------
// Dates — expenses use plain calendar dates (YYYY-MM-DD); months are YYYY-MM.
// ---------------------------------------------------------------------------

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentMonth(): string {
  return todayISO().slice(0, 7);
}

export function monthOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Reject calendar rollovers like 2026-02-30 (which Date silently turns into
  // Mar 2): the round-tripped date must equal the input.
  return d.toISOString().slice(0, 10) === s;
}

export function isValidMonth(s: string): boolean {
  if (!MONTH_RE.test(s)) return false;
  const month = Number(s.slice(5, 7));
  return month >= 1 && month <= 12;
}

export function isValidCurrency(s: string): boolean {
  return /^[A-Z]{3}$/.test(s);
}

/** Values are stored in SQLite INTEGER minor units; stay safely below 2^53. */
export function isSafeMoneyAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(Math.round(amount * 100));
}

export function hasValidDateRange(from?: string, to?: string): boolean {
  return (!from || !to || from <= to);
}

export function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Budget periods — a budget rule applies to a repeating window of dates. These
// resolve which window contains a given day so spending can be compared against
// the right slice of history, and walk earlier windows for "carry" rollover.
// ---------------------------------------------------------------------------

export type BudgetPeriod = "weekly" | "monthly" | "yearly" | "custom";

/** Inclusive date window, YYYY-MM-DD. */
export interface DateWindow {
  from: string;
  to: string;
}

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromISO: string, toISO: string): number {
  const ms = new Date(`${toISO}T00:00:00Z`).getTime() - new Date(`${fromISO}T00:00:00Z`).getTime();
  return Math.floor(ms / 86_400_000);
}

/** Monday of the ISO week containing `dateISO`. */
function startOfWeek(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  // getUTCDay(): 0=Sunday. Shift so Monday is the first day of the week.
  return addDaysISO(dateISO, -((d.getUTCDay() + 6) % 7));
}

/**
 * The window a rule applies to on `onDate`, or null when the rule does not
 * cover that day at all (a custom period outside its own start/end, or a rule
 * whose anchor start date is still in the future).
 *
 * Weekly windows are anchored to `startDate` when one is given, so a rule that
 * starts on a Thursday keeps Thursday-to-Wednesday weeks rather than silently
 * jumping to ISO weeks. Monthly and yearly follow the calendar, which is what
 * "my March budget" means to a user.
 */
export function budgetWindowFor(
  rule: { period: BudgetPeriod; startDate?: string; endDate?: string },
  onDate: string,
): DateWindow | null {
  if (rule.period === "custom") {
    if (!rule.startDate || !rule.endDate) return null;
    return onDate >= rule.startDate && onDate <= rule.endDate
      ? { from: rule.startDate, to: rule.endDate }
      : null;
  }
  if (rule.startDate && onDate < rule.startDate) return null;

  if (rule.period === "weekly") {
    const anchor = rule.startDate ?? startOfWeek(onDate);
    const from = addDaysISO(anchor, Math.floor(daysBetween(anchor, onDate) / 7) * 7);
    return { from, to: addDaysISO(from, 6) };
  }
  if (rule.period === "monthly") {
    const month = onDate.slice(0, 7);
    return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
  }
  const year = onDate.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * The next due date for a recurring transaction.
 *
 * Month and year steps clamp to the target month's length, so a rule due on
 * the 31st lands on the 28th/29th in February rather than rolling into March.
 * Note the clamp is not remembered: once clamped, later occurrences follow the
 * clamped day.
 */
export function advanceRecurringDate(
  dateISO: string,
  frequency: "weekly" | "monthly" | "yearly",
): string {
  if (frequency === "weekly") {
    const d = new Date(`${dateISO}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const [year, month, day] = dateISO.split("-").map(Number);
  const targetYear = frequency === "yearly" ? year + 1 : month === 12 ? year + 1 : year;
  const targetMonth = frequency === "yearly" ? month : month === 12 ? 1 : month + 1;
  const monthKey = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
  return `${monthKey}-${String(Math.min(day, daysInMonth(monthKey))).padStart(2, "0")}`;
}

/** Guards the carry walk below; a rule anchored years back must not spin. */
const MAX_CARRY_WINDOWS = 60;

/**
 * Completed windows before the one containing `onDate`, oldest first, starting
 * from the rule's anchor. Used to roll unspent budget forward — only meaningful
 * for `rollover: "carry"`.
 */
export function priorBudgetWindows(
  rule: { period: BudgetPeriod; startDate?: string; endDate?: string; createdAt?: string },
  onDate: string,
): DateWindow[] {
  if (rule.period === "custom") return [];
  const current = budgetWindowFor(rule, onDate);
  if (!current) return [];
  const anchor = (rule.startDate ?? rule.createdAt?.slice(0, 10) ?? onDate).slice(0, 10);
  if (anchor >= current.from) return [];

  const windows: DateWindow[] = [];
  let cursor = budgetWindowFor(rule, anchor);
  while (cursor && cursor.from < current.from && windows.length < MAX_CARRY_WINDOWS) {
    windows.push(cursor);
    cursor = budgetWindowFor(rule, addDaysISO(cursor.to, 1));
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Per-user isolation
// ---------------------------------------------------------------------------

/**
 * Resolve a stable, per-subscriber user id from an HTTP request. MCPize routes
 * each subscriber's traffic with their own credential; we key data off it so
 * subscribers can never see each other's expenses. Explicit id headers win;
 * otherwise the auth token is hashed into a stable opaque id.
 */
export function resolveUserId(req: Request): string | null {
  // 1. Stable per-subscriber id from the host. MCPize sends `x-mcpize-user-id`;
  //    this MUST be checked first. (MCPize rotates the `authorization` bearer
  //    token per request, so hashing it would fragment a user's data across
  //    buckets — see step 2.)
  const explicit = (
    req.header("x-mcpize-user-id") ||
    req.header("x-mcpize-user") ||
    req.header("x-user-id") ||
    ""
  ).trim();
  if (explicit) return explicit;

  // 2. A *stable* API token identifies a non-MCPize client. Different clients
  //    have different tokens → different hashes, so this never co-mingles
  //    users; at worst it fragments one client whose token rotates.
  const auth = (req.header("authorization") || req.header("x-api-key") || "").trim();
  if (auth) {
    return "u_" + createHash("sha256").update(auth).digest("hex").slice(0, 16);
  }

  // 3. Opt-in single-user mode for self-hosting.
  if (process.env.DEFAULT_USER_ID) return process.env.DEFAULT_USER_ID;

  // 4. Fail closed. No identity → no data access. We deliberately do NOT fall
  //    into a shared bucket: for a finance server, letting unrelated
  //    unidentified callers share data would be a real privacy breach.
  return null;
}

// ---------------------------------------------------------------------------
// Category inference — a best-effort keyword classifier used only when the
// caller doesn't supply a category, so no expense ever ends up category-less
// (which would silently drop rows from category reports). The client model is
// usually a better classifier and will pass an explicit category; this is the
// server-side safety net. Rules are checked in order; first match wins.
// ---------------------------------------------------------------------------

const CATEGORY_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["rent", ["rent", "landlord", "lease"]],
  ["utilities", ["electricity", "electric bill", "water bill", "utility", "utilities", "internet", "wifi", "broadband", "gas bill"]],
  ["transport", ["uber", "lyft", "taxi", "cab", "bus", "train", "metro", "subway", "fuel", "petrol", "parking", "toll", "flight", "fare", "ride"]],
  ["food", ["coffee", "latte", "cafe", "restaurant", "lunch", "dinner", "breakfast", "grocery", "groceries", "snack", "pizza", "burger", "meal", "dining", "brunch", "bakery", "starbucks", "mcdonald"]],
  ["entertainment", ["netflix", "spotify", "movie", "cinema", "concert", "gaming", "hulu", "disney", "subscription"]],
  ["shopping", ["amazon", "walmart", "target", "clothes", "clothing", "shirt", "shoes", "mall", "electronics"]],
  ["health", ["pharmacy", "medicine", "doctor", "hospital", "clinic", "dental", "dentist", "gym", "fitness", "medical"]],
  ["travel", ["hotel", "airbnb", "vacation", "resort", "booking"]],
  ["bills", ["bill", "insurance", "premium"]],
];

/**
 * Infer a category from free text (usually the expense note). Returns
 * "uncategorized" when nothing matches, so the result is always a usable,
 * non-empty category.
 */
export function categorize(text: string | undefined | null): string {
  const t = (text ?? "").toLowerCase();
  if (t.trim()) {
    for (const [category, keywords] of CATEGORY_RULES) {
      if (keywords.some((k) => t.includes(k))) return category;
    }
  }
  return "uncategorized";
}

/**
 * Resolve the category to store: an explicit category (normalised) wins;
 * otherwise infer from the note; otherwise "uncategorized".
 */
export function resolveCategory(
  provided: string | undefined | null,
  note: string | undefined | null,
): string {
  if (provided && provided.trim()) return provided.trim().toLowerCase();
  return categorize(note);
}

// ---------------------------------------------------------------------------
// Presentation — the client-facing shape of an expense (major units, no
// internal userId leak).
// ---------------------------------------------------------------------------

export interface ExpenseView {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
}

export function view(e: Expense): ExpenseView {
  return {
    id: e.id,
    date: e.date,
    category: e.category,
    description: e.description,
    amount: toMajor(e.amountMinor),
    currency: e.currency,
  };
}
