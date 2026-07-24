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
  return MONTH_RE.test(s);
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
