import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { verifyDashboardSessionToken } from "./dashboard-auth.js";
import { MemoryStore } from "./store/memory.js";
import { TursoStore } from "./store/turso.js";
import type { ExpenseStore } from "./store/types.js";
import { currentMonth, formatMoney, isValidMonth, resolveUserId } from "./util.js";

/**
 * TURSO_DATABASE_URL may embed its auth token as a query param
 * (`libsql://xxx.turso.io?authToken=...`), which lets a single secret cover a
 * remote Turso database on hosts (like MCPize's free tier) that cap you at
 * one secret. A separate TURSO_AUTH_TOKEN env var is also honored, so a
 * two-secret setup works too — the embedded token wins if both are present.
 */
function resolveTursoConfig(): { url: string; authToken?: string } | null {
  const raw = process.env.TURSO_DATABASE_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const embeddedToken = parsed.searchParams.get("authToken");
    if (embeddedToken) {
      parsed.searchParams.delete("authToken");
      return { url: parsed.toString(), authToken: embeddedToken };
    }
  } catch {
    // Not a parseable URL (e.g. a local `file:./data.db` path) — use as-is.
  }
  return { url: raw, authToken: process.env.TURSO_AUTH_TOKEN };
}

function createStore(): ExpenseStore {
  const turso = resolveTursoConfig();
  if (turso) {
    console.error(`[store] using TursoStore (${turso.url.replace(/\?.*/, "")})`);
    return new TursoStore(turso.url, turso.authToken);
  }
  console.error(
    "[store] using MemoryStore — data will NOT survive a restart or a second " +
      "instance. Set TURSO_DATABASE_URL for durable storage in production.",
  );
  return new MemoryStore(process.env.DATA_DIR);
}

const store = createStore();
await store.init();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function dashboardPage(input: {
  month: string;
  currency: string;
  spentMinor: number;
  incomeMinor: number;
  budgetMinor: number | null;
  categoryRows: { category: string; amountMinor: number }[];
  recentExpenses: { date: string; category: string; description: string; amountMinor: number }[];
}): string {
  const { month, currency, spentMinor, incomeMinor, budgetMinor, categoryRows, recentExpenses } = input;
  const remaining = budgetMinor === null ? null : budgetMinor - spentMinor;
  const budgetPercent = budgetMinor && budgetMinor > 0 ? Math.round((spentMinor / budgetMinor) * 100) : 0;
  const maxCategory = Math.max(1, ...categoryRows.map((row) => row.amountMinor));
  const categories = categoryRows.length
    ? categoryRows.map((row) => `<div class="category"><div class="category-label"><span>${escapeHtml(row.category)}</span><b>${escapeHtml(formatMoney(row.amountMinor, currency))}</b></div><div class="track"><div class="fill" style="width:${Math.min(100, Math.round(row.amountMinor / maxCategory * 100))}%"></div></div></div>`).join("")
    : '<p class="empty">No expenses recorded for this month yet.</p>';
  const expenses = recentExpenses.length
    ? recentExpenses.map((expense) => `<tr><td>${escapeHtml(expense.date)}</td><td><span class="category-chip">${escapeHtml(expense.category)}</span></td><td>${escapeHtml(expense.description || "Expense")}</td><td class="amount">${escapeHtml(formatMoney(expense.amountMinor, currency))}</td></tr>`).join("")
    : '<tr><td colspan="4" class="empty">No expenses recorded for this month yet.</td></tr>';
  const budgetText = budgetMinor === null ? "No overall budget" : formatMoney(budgetMinor, currency);
  const remainingText = remaining === null ? "Set a budget in MCP" : formatMoney(Math.abs(remaining), currency);
  const remainingLabel = remaining === null ? "Budget status" : remaining >= 0 ? "Remaining" : "Over budget";
  const remainingClass = remaining !== null && remaining < 0 ? "danger" : "success";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Expense Tracker AI</title><style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#07132d;color:#eff6ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#11347f 0,transparent 32rem),#07132d;min-height:100vh}.shell{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:30px 0 46px}.nav{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:750}.brand img{width:38px;height:38px;border-radius:11px}.month{display:flex;gap:10px;align-items:center}.month input{font:inherit;color:#eff6ff;background:#0c1d43;border:1px solid #2d4a86;border-radius:10px;padding:10px 12px}.month button{font:inherit;font-weight:700;color:#06132d;background:#4be0ce;border:0;border-radius:10px;padding:10px 15px;cursor:pointer}.hero{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:30px;border:1px solid #2b4d94;border-radius:22px;background:linear-gradient(115deg,#091d49,#0d43a5);overflow:hidden}.hero h1{font-size:clamp(28px,5vw,44px);margin:0}.hero p{margin:10px 0 0;color:#bfdbfe;font-size:16px}.hero img{width:160px;height:160px;object-fit:cover;object-position:right;border-radius:18px;mix-blend-mode:screen}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:20px 0}.card{background:#0c1c3e;border:1px solid #203e77;border-radius:16px;padding:20px}.metric-label,.muted{color:#9db4dd;font-size:13px}.metric-value{font-size:26px;font-weight:750;margin-top:8px;letter-spacing:-.03em}.success{color:#61e8b7}.danger{color:#ff8a8a}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}.section-title{font-size:18px;font-weight:750;margin:0 0 18px}.budget-row{display:flex;align-items:end;justify-content:space-between;gap:10px}.budget-row strong{font-size:24px}.progress{height:12px;border-radius:999px;background:#1a315e;overflow:hidden;margin:18px 0 10px}.progress>span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#40d5a1,#f4bd3d,#ff6565)}.category{padding:13px 0;border-bottom:1px solid #1d3768}.category:last-child{border-bottom:0}.category-label{display:flex;justify-content:space-between;gap:14px;text-transform:capitalize;font-size:14px}.track{height:8px;background:#1a315e;border-radius:99px;margin-top:9px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,#39c6ff,#5b72ff);border-radius:inherit}.table-wrap{overflow-x:auto;margin-top:18px}.table{width:100%;border-collapse:collapse;font-size:14px}.table th{color:#9db4dd;text-align:left;font-weight:600;padding:0 12px 12px}.table td{padding:13px 12px;border-top:1px solid #1d3768}.table .amount{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}.category-chip{display:inline-block;border-radius:99px;padding:4px 8px;color:#c5d8ff;background:#172f5e;text-transform:capitalize;font-size:12px}.empty{color:#9db4dd;margin:0;padding:10px 0}.footer{margin-top:20px;text-align:center;color:#7793c4;font-size:12px}@media(max-width:760px){.shell{width:min(100% - 22px,620px);padding-top:16px}.hero{padding:24px}.hero img{display:none}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}.nav{align-items:flex-start;flex-direction:column}.month{width:100%}.month input{flex:1;min-width:0}}@media(max-width:420px){.metrics{grid-template-columns:1fr}.hero h1{font-size:30px}}
  </style></head><body><main class="shell"><header class="nav"><div class="brand"><img src="/assets/email/expense-tracker-logo-dark.png" alt=""><span>Expense Tracker AI</span></div><form class="month" method="get" action="/dashboard"><input aria-label="Report month" type="month" name="month" value="${escapeHtml(month)}"><button type="submit">View month</button></form></header><section class="hero"><div><h1>Your money, clearly.</h1><p>Private financial dashboard for ${escapeHtml(month)}.</p></div><img src="/assets/email/budget-alert-robot-v2.png" alt=""></section><section class="metrics"><article class="card"><div class="metric-label">Spent</div><div class="metric-value">${escapeHtml(formatMoney(spentMinor, currency))}</div></article><article class="card"><div class="metric-label">Income</div><div class="metric-value success">${escapeHtml(formatMoney(incomeMinor, currency))}</div></article><article class="card"><div class="metric-label">Overall budget</div><div class="metric-value">${escapeHtml(budgetText)}</div></article><article class="card"><div class="metric-label">${remainingLabel}</div><div class="metric-value ${remainingClass}">${escapeHtml(remainingText)}</div></article></section><section class="grid"><article class="card"><h2 class="section-title">Budget usage</h2><div class="budget-row"><span class="muted">${budgetMinor === null ? "Create an overall budget to track progress." : `${budgetPercent}% used`}</span><strong>${budgetMinor === null ? "—" : escapeHtml(formatMoney(spentMinor, currency))}</strong></div><div class="progress"><span style="width:${Math.min(100, budgetPercent)}%"></span></div><div class="muted">${budgetMinor === null ? "" : `${escapeHtml(formatMoney(budgetMinor, currency))} monthly limit`}</div></article><article class="card"><h2 class="section-title">Where your money went</h2>${categories}</article></section><section class="card" style="margin-top:18px"><h2 class="section-title">Recent expenses</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="amount">Amount</th></tr></thead><tbody>${expenses}</tbody></table></div></section><footer class="footer">Expense Tracker AI · Your dashboard is private to your authenticated MCPize account.</footer></main></body></html>`;
}

// Transport selection:
//  --http / MCP_TRANSPORT=http           -> HTTP
//  --stdio / MCP_TRANSPORT=stdio         -> stdio
//  otherwise: HTTP if PORT is set (MCPize / Cloud Run), else stdio.
type DashboardViewInput = {
  month: string;
  currency: string;
  spentMinor: number;
  incomeMinor: number;
  budgetMinor: number | null;
  categoryRows: { category: string; amountMinor: number }[];
  recentExpenses: { date: string; category: string; description: string; amountMinor: number }[];
  dailySpend: number[];
  activeDays: number;
};

/** Browser-first dashboard: charts are server-rendered so no user finance data
 * is exposed to a client-side API or third-party analytics script. */
function properDashboardPage(input: DashboardViewInput): string {
  const { month, currency, spentMinor, incomeMinor, budgetMinor, categoryRows, recentExpenses, dailySpend, activeDays } = input;
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(`${month}-01T00:00:00Z`));
  const remainingMinor = budgetMinor === null ? null : budgetMinor - spentMinor;
  const usedPercent = budgetMinor && budgetMinor > 0 ? Math.round(spentMinor / budgetMinor * 100) : 0;
  const safePercent = Math.min(100, usedPercent);
  const netMinor = incomeMinor - spentMinor;
  const categoryTotal = Math.max(1, categoryRows.reduce((sum, row) => sum + row.amountMinor, 0));
  const maxCategory = Math.max(1, ...categoryRows.map((row) => row.amountMinor));
  const graphValues = dailySpend.length ? dailySpend : [0];
  const graphMax = Math.max(1, ...graphValues);
  const graphPoints = graphValues.map((amount, index) => `${(index / Math.max(1, graphValues.length - 1) * 620 + 20).toFixed(1)},${(176 - amount / graphMax * 126).toFixed(1)}`).join(" ");
  const graphArea = `20,176 ${graphPoints} 640,176`;
  const topCategory = categoryRows[0];
  const categoryCards = categoryRows.length ? categoryRows.slice(0, 6).map((row) => {
    const share = Math.round(row.amountMinor / categoryTotal * 100);
    return `<li><div class="category-top"><span class="category-name">${escapeHtml(row.category)}</span><span>${escapeHtml(formatMoney(row.amountMinor, currency))}</span></div><div class="bar"><span style="width:${Math.round(row.amountMinor / maxCategory * 100)}%"></span></div><small>${share}% of ${escapeHtml(formatMoney(spentMinor, currency))}</small></li>`;
  }).join("") : '<li class="empty">Add an expense through MCP to see category insights.</li>';
  const expenseRows = recentExpenses.length ? recentExpenses.map((expense) => `<tr><td><time datetime="${escapeHtml(expense.date)}">${escapeHtml(expense.date)}</time></td><td><span class="category-tag">${escapeHtml(expense.category)}</span></td><td>${escapeHtml(expense.description || "Expense")}</td><td class="number">${escapeHtml(formatMoney(expense.amountMinor, currency))}</td></tr>`).join("") : '<tr><td colspan="4" class="empty">No expenses in this period.</td></tr>';
  const budgetMessage = budgetMinor === null ? "Set an overall budget in MCP to unlock budget health." : remainingMinor! >= 0 ? `${escapeHtml(formatMoney(remainingMinor!, currency))} remains for the month.` : `${escapeHtml(formatMoney(Math.abs(remainingMinor!), currency))} over your monthly limit.`;
  const budgetTone = remainingMinor !== null && remainingMinor < 0 ? "over" : "on-track";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard · Expense Tracker AI</title><style>
    :root{--ink:#122247;--muted:#70809e;--line:#e7ecf4;--canvas:#f5f8fc;--card:#fff;--blue:#2867f2;--blue-soft:#eef4ff;--green:#0a9b63;--red:#d9384b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--canvas)}*{box-sizing:border-box}body{margin:0;background:var(--canvas)}.page{max-width:1180px;margin:0 auto;padding:28px 24px 52px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:26px}.brand{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:800;letter-spacing:-.025em}.brand img{width:38px;height:38px;border-radius:11px}.brand small{display:block;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:0}.tools{display:flex;align-items:center;gap:10px}.month-picker{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:5px}.month-picker input{color:var(--ink);font:inherit;border:0;padding:7px 9px;background:transparent}.month-picker button{background:var(--blue);border:0;border-radius:8px;color:#fff;padding:8px 12px;font:700 13px inherit;cursor:pointer}.intro{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:22px}.eyebrow{margin:0 0 5px;color:var(--blue);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.intro h1{margin:0;font-size:32px;letter-spacing:-.045em}.intro p{margin:7px 0 0;color:var(--muted);font-size:15px}.period{color:var(--muted);font-size:14px;font-weight:700}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metric{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}.metric-label{color:var(--muted);font-size:13px;font-weight:650}.metric-value{font-size:25px;font-weight:800;letter-spacing:-.045em;margin-top:8px}.metric-note{font-size:12px;margin-top:6px;color:var(--muted)}.positive{color:var(--green)}.negative{color:var(--red)}.layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(290px,.9fr);gap:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}.card h2{font-size:17px;letter-spacing:-.025em;margin:0}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.card-head p{margin:5px 0 0;color:var(--muted);font-size:13px}.badge{padding:6px 9px;border-radius:99px;background:var(--blue-soft);color:var(--blue);font-size:12px;font-weight:750;white-space:nowrap}.chart{width:100%;height:auto;display:block;margin:18px 0 0}.chart-grid{stroke:#e7ecf4;stroke-width:1}.chart-area{fill:#e9f1ff}.chart-line{fill:none;stroke:#2867f2;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.chart-label{fill:#8592aa;font-size:11px;font-family:inherit}.budget-card{margin-top:18px}.budget-summary{display:flex;align-items:center;gap:18px;margin-top:18px}.ring{width:112px;height:112px;border-radius:50%;background:conic-gradient(var(--blue) ${safePercent}%,#e8edf5 0);padding:11px;flex:0 0 auto}.ring-inner{width:100%;height:100%;display:grid;place-content:center;text-align:center;border-radius:50%;background:var(--card);font-size:24px;font-weight:850;letter-spacing:-.06em}.ring-inner small{display:block;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:0}.budget-copy{min-width:0}.budget-copy strong{display:block;font-size:20px;letter-spacing:-.035em}.budget-copy p{margin:7px 0 0;color:var(--muted);font-size:13px;line-height:1.45}.budget-copy .state{display:inline-block;margin-top:11px;padding:6px 9px;border-radius:7px;font-size:12px;font-weight:750}.on-track{background:#e8f8f1;color:var(--green)}.over{background:#fff0f1;color:var(--red)}.categories{padding:0;margin:17px 0 0;list-style:none}.categories li{padding:13px 0;border-bottom:1px solid var(--line)}.categories li:last-child{border-bottom:0}.category-top{display:flex;justify-content:space-between;gap:14px;font-size:13px;font-weight:700}.category-name{text-transform:capitalize}.bar{height:7px;border-radius:99px;background:#edf1f6;overflow:hidden;margin:8px 0}.bar span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#3478ff,#61a0ff)}.categories small{color:var(--muted);font-size:11px}.insight{margin-top:18px;padding:15px;border-radius:12px;background:#f6f9ff;border:1px solid #e3edff}.insight b{font-size:13px}.insight p{margin:5px 0 0;color:#4b5f84;font-size:13px;line-height:1.45}.table-card{margin-top:18px;padding:0;overflow:hidden}.table-title{display:flex;align-items:center;justify-content:space-between;padding:22px 22px 12px}.table-title a{color:var(--blue);text-decoration:none;font-size:13px;font-weight:750}.table-wrap{overflow-x:auto}.expenses{border-collapse:collapse;width:100%;font-size:13px}.expenses th{background:#fafbfe;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.04em;text-align:left;text-transform:uppercase;padding:12px 22px}.expenses td{padding:15px 22px;border-top:1px solid var(--line)}.expenses .number{text-align:right;font-variant-numeric:tabular-nums;font-weight:800;white-space:nowrap}.category-tag{background:#f0f4fa;border-radius:99px;color:#425575;font-size:12px;font-weight:700;padding:5px 8px;text-transform:capitalize}.empty{color:var(--muted);padding:18px 0}.footer{text-align:center;color:var(--muted);font-size:12px;margin-top:23px}@media(max-width:850px){.metrics{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}.right-column{display:grid;grid-template-columns:1fr 1fr;gap:18px}.right-column .budget-card{margin-top:0}}@media(max-width:600px){.page{padding:18px 13px 35px}.topbar,.intro{align-items:flex-start;flex-direction:column;gap:14px}.tools,.month-picker{width:100%}.month-picker input{flex:1;min-width:0}.intro h1{font-size:29px}.metrics{grid-template-columns:1fr 1fr;gap:10px}.metric,.card{padding:16px}.metric-value{font-size:21px}.right-column{display:block}.right-column .budget-card{margin-top:14px}.table-title{padding:17px 16px 10px}.expenses th,.expenses td{padding:13px 16px}.expenses th:nth-child(3),.expenses td:nth-child(3){display:none}.budget-summary{gap:13px}.ring{width:96px;height:96px}.ring-inner{font-size:20px}}@media(max-width:380px){.metrics{grid-template-columns:1fr}.budget-summary{align-items:flex-start;flex-direction:column}}
  </style></head><body><main class="page"><header class="topbar"><div class="brand"><img src="/assets/email/expense-tracker-logo-light.png" alt=""><span>Expense Tracker AI<small>Personal finance dashboard</small></span></div><div class="tools"><form class="month-picker" action="/dashboard" method="get"><label class="sr-only" for="month">Month</label><input id="month" name="month" type="month" value="${escapeHtml(month)}"><button type="submit">Update</button></form></div></header><section class="intro"><div><p class="eyebrow">Financial overview</p><h1>Good to see you.</h1><p>Your financial picture for ${escapeHtml(monthLabel)}.</p></div><span class="period">${escapeHtml(currency)} · Private account</span></section><section class="metrics" aria-label="Monthly summary"><article class="metric"><div class="metric-label">Total spent</div><div class="metric-value">${escapeHtml(formatMoney(spentMinor, currency))}</div><div class="metric-note">${activeDays} active spending day${activeDays === 1 ? "" : "s"}</div></article><article class="metric"><div class="metric-label">Income</div><div class="metric-value positive">${escapeHtml(formatMoney(incomeMinor, currency))}</div><div class="metric-note">Recorded this month</div></article><article class="metric"><div class="metric-label">Net cash flow</div><div class="metric-value ${netMinor < 0 ? "negative" : "positive"}">${escapeHtml(formatMoney(netMinor, currency))}</div><div class="metric-note">Income minus expenses</div></article><article class="metric"><div class="metric-label">Daily average</div><div class="metric-value">${escapeHtml(formatMoney(Math.round(spentMinor / Math.max(1, activeDays)), currency))}</div><div class="metric-note">Across active days</div></article></section><section class="layout"><div><article class="card"><div class="card-head"><div><h2>Spending activity</h2><p>Daily expense total across ${escapeHtml(monthLabel)}.</p></div><span class="badge">${escapeHtml(formatMoney(spentMinor, currency))} total</span></div><svg class="chart" viewBox="0 0 660 205" role="img" aria-label="Daily spending line chart"><line class="chart-grid" x1="20" y1="50" x2="640" y2="50"/><line class="chart-grid" x1="20" y1="113" x2="640" y2="113"/><line class="chart-grid" x1="20" y1="176" x2="640" y2="176"/><polygon class="chart-area" points="${graphArea}"/><polyline class="chart-line" points="${graphPoints}"/><text class="chart-label" x="20" y="198">Start</text><text class="chart-label" x="600" y="198">Month end</text></svg></article><article class="card table-card"><div class="table-title"><h2>Recent expenses</h2><a href="#recent-expenses">Latest activity</a></div><div class="table-wrap" id="recent-expenses"><table class="expenses"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="number">Amount</th></tr></thead><tbody>${expenseRows}</tbody></table></div></article></div><aside class="right-column"><article class="card"><div class="card-head"><div><h2>Spending by category</h2><p>Largest categories first.</p></div></div><ul class="categories">${categoryCards}</ul>${topCategory ? `<div class="insight"><b>Focus area: ${escapeHtml(topCategory.category)}</b><p>This is your largest category at ${Math.round(topCategory.amountMinor / categoryTotal * 100)}% of spending. A small reduction here will have the biggest impact.</p></div>` : ""}</article><article class="card budget-card"><div class="card-head"><div><h2>Budget health</h2><p>Overall monthly budget.</p></div><span class="badge">${budgetMinor === null ? "Not set" : `${usedPercent}% used`}</span></div><div class="budget-summary"><div class="ring"><div class="ring-inner">${budgetMinor === null ? "—" : `${usedPercent}%`}<small>used</small></div></div><div class="budget-copy"><strong>${budgetMinor === null ? "Create a budget" : escapeHtml(formatMoney(budgetMinor, currency))}</strong><p>${budgetMessage}</p><span class="state ${budgetTone}">${budgetMinor === null ? "Set a limit in MCP" : budgetTone === "over" ? "Needs attention" : "On track"}</span></div></div></article></aside></section><footer class="footer">Expense Tracker AI · Your financial data is private to your authenticated account.</footer></main></body></html>`;
}

type ReferenceDashboardInput = DashboardViewInput & {
  dailyIncome: number[];
  categoryBudgets: { category: string; amountMinor: number }[];
};

function referenceDashboardPage(input: ReferenceDashboardInput): string {
  const { month, currency, spentMinor, incomeMinor, budgetMinor, categoryRows, recentExpenses, dailySpend, dailyIncome, categoryBudgets } = input;
  const balanceMinor = incomeMinor - spentMinor;
  const savingsRate = incomeMinor > 0 ? Math.round(balanceMinor / incomeMinor * 100) : 0;
  const percent = budgetMinor && budgetMinor > 0 ? Math.round(spentMinor / budgetMinor * 100) : 0;
  const budgetRemaining = budgetMinor === null ? null : budgetMinor - spentMinor;
  const categoryTotal = Math.max(1, categoryRows.reduce((sum, row) => sum + row.amountMinor, 0));
  const colors = ["#ff5948", "#1769e8", "#ffb20d", "#32bf68", "#8c5de8", "#34b6c8"];
  let cursor = 0;
  const donutStops = categoryRows.slice(0, 6).map((row, index) => { const next = cursor + row.amountMinor / categoryTotal * 100; const result = `${colors[index]} ${cursor.toFixed(1)}% ${next.toFixed(1)}%`; cursor = next; return result; }).join(",") || "#e8edf5 0 100%";
  const maxPoint = Math.max(1, ...dailySpend, ...dailyIncome);
  const line = (points: number[]) => points.length ? points.map((value, index) => `${(index / Math.max(1, points.length - 1) * 590 + 30).toFixed(1)},${(168 - value / maxPoint * 126).toFixed(1)}`).join(" ") : "30,168 620,168";
  const spendingLine = line(dailySpend); const incomeLine = line(dailyIncome);
  const categories = categoryRows.slice(0, 6).map((row, index) => `<li><span class="dot" style="background:${colors[index]}"></span><span class="name">${escapeHtml(row.category)}</span><b>${escapeHtml(formatMoney(row.amountMinor, currency))}</b><em>${Math.round(row.amountMinor / categoryTotal * 100)}%</em></li>`).join("") || '<li class="empty">No category data yet.</li>';
  const transactions = recentExpenses.slice(0, 5).map((expense, index) => `<li><span class="transaction-icon c${index % 5}">${["☕", "🚕", "🛍", "⌂", "◈"][index % 5]}</span><span class="transaction-main"><b>${escapeHtml(expense.description || "Expense")}</b><small>${escapeHtml(expense.category)} · ${escapeHtml(expense.date)}</small></span><strong class="out">−${escapeHtml(formatMoney(expense.amountMinor, currency))}</strong></li>`).join("") || '<li class="empty">No transactions this month.</li>';
  const rows = categoryBudgets.length ? categoryBudgets.map((budget) => { const actual = categoryRows.find((category) => category.category === budget.category)?.amountMinor || 0; const used = Math.round(actual / Math.max(1, budget.amountMinor) * 100); return `<tr><td>${escapeHtml(budget.category)}</td><td>${escapeHtml(formatMoney(budget.amountMinor, currency))}</td><td>${escapeHtml(formatMoney(actual, currency))}</td><td><span class="mini-track"><i style="width:${Math.min(100, used)}%"></i></span></td><td class="${used > 100 ? "red" : "green"}">${used > 100 ? "Over" : "Good"}</td></tr>`; }).join("") : '<tr><td colspan="5" class="empty">Set category budgets in MCP to compare plan vs actual.</td></tr>';
  const top = categoryRows[0];
  const alerts = [top ? `Your largest category is ${top.category} at ${Math.round(top.amountMinor / categoryTotal * 100)}% of total spending.` : "Add expenses to unlock personalised insights.", budgetRemaining !== null && budgetRemaining < 0 ? `You are ${formatMoney(Math.abs(budgetRemaining), currency)} over your overall budget.` : budgetRemaining !== null ? `${formatMoney(budgetRemaining, currency)} remains in your monthly budget.` : "Set an overall budget to track progress.", incomeMinor ? `Your monthly savings rate is ${savingsRate}%.` : "Record income to calculate cash flow and savings."];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard · Expense Tracker AI</title><style>
  :root{--ink:#14203d;--muted:#71809c;--line:#e7edf6;--bg:#f7f9fd;--blue:#1263f3;--green:#18af69;--red:#f04545;--card:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0;background:var(--bg)}.app{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}.sidebar{padding:22px 14px;background:radial-gradient(circle at 0 0,#12449d,#021330 56%);color:#fff}.identity{display:flex;gap:10px;align-items:center;margin:0 4px 28px;font-weight:800;line-height:1.15}.identity img{width:38px;height:38px;border-radius:10px}.identity small{display:block;margin-top:4px;color:#a8c0ef;font-size:11px;font-weight:600}.nav{display:grid;gap:5px}.nav a{display:flex;gap:12px;align-items:center;padding:12px 13px;border-radius:9px;color:#e2ecff;text-decoration:none;font-size:14px;font-weight:650}.nav a.active{background:#1150b8;color:#fff}.nav a:hover{background:#0c3b89}.side-help{margin-top:42px;padding:15px;border:1px solid #315487;border-radius:11px;background:#092354}.side-help b{display:block;font-size:13px}.side-help p{margin:7px 0 12px;color:#b7c9ec;font-size:12px;line-height:1.45}.side-help a{display:inline-block;border-radius:7px;padding:9px 13px;color:#fff;background:#1263f3;text-decoration:none;font-size:12px;font-weight:750}.main{padding:18px 28px 38px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px}.top h1{margin:0;font-size:24px;letter-spacing:-.035em}.top p{margin:4px 0 0;font-size:13px}.controls{display:flex;gap:10px;align-items:center}.month-form{display:flex;gap:7px;padding:5px;border:1px solid var(--line);border-radius:8px;background:#fff}.month-form input{border:0;padding:7px;font:inherit;color:var(--ink)}.month-form button,.add{border:0;border-radius:7px;background:var(--blue);color:#fff;padding:9px 14px;font:700 13px inherit}.notify{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);text-decoration:none}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:20px 0 16px}.metric,.card{border:1px solid var(--line);border-radius:13px;background:var(--card);box-shadow:0 3px 10px rgba(30,54,102,.035)}.metric{position:relative;padding:18px}.metric p{margin:0;color:#526079;font-size:13px}.metric strong{display:block;margin-top:8px;font-size:23px;letter-spacing:-.04em}.metric small{display:block;margin-top:9px;color:var(--green);font-size:12px;font-weight:700}.metric .metric-icon{position:absolute;right:18px;top:22px;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:#e8f0ff;color:var(--blue);font-size:20px}.metric:nth-child(2) .metric-icon{background:#e5f9ec;color:var(--green)}.metric:nth-child(3) .metric-icon{background:#fff0f0;color:var(--red)}.metric:nth-child(4) .metric-icon{background:#f1eaff;color:#7d48e9}.grid-top{display:grid;grid-template-columns:.9fr 1.3fr;gap:15px}.card{padding:18px}.card h2{margin:0;font-size:15px;letter-spacing:-.025em}.budget-layout{display:flex;align-items:center;gap:26px;margin-top:15px}.gauge{width:130px;height:130px;flex:0 0 auto;border-radius:50%;padding:10px;background:conic-gradient(#ff5548 ${Math.min(percent,100)}%,#ffad23 0,#e9edf4 0)}.gauge>span{display:grid;width:100%;height:100%;place-content:center;border-radius:50%;background:#fff;text-align:center;font-size:25px;font-weight:850;letter-spacing:-.06em}.gauge small{display:block;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:0}.budget-list{display:grid;gap:10px;width:100%;font-size:12px}.budget-list div{display:flex;justify-content:space-between;gap:12px}.budget-list b{font-size:13px}.budget-list .red{color:var(--red)}.budget-progress{height:8px;margin-top:15px;border-radius:99px;background:#e8edf4;overflow:hidden}.budget-progress span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#1cbd68,#ffbd23,#f14343)}.budget-alert{display:flex;justify-content:space-between;gap:12px;margin-top:13px;border-radius:8px;padding:10px;color:var(--red);background:#fff3f3;font-size:12px}.trend-head{display:flex;align-items:center;justify-content:space-between}.legend{display:flex;gap:14px;color:var(--muted);font-size:11px}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:var(--blue)}.legend i.income{background:var(--green)}.trend{display:block;width:100%;margin-top:12px}.axis{stroke:#e9eef6;stroke-width:1}.spend{fill:none;stroke:#1263f3;stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.income{fill:none;stroke:#18af69;stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.axis-label{fill:#76849c;font:10px Inter,system-ui,sans-serif}.grid-middle{display:grid;grid-template-columns:1.1fr .9fr .9fr;gap:15px;margin-top:15px}.donut-layout{display:flex;gap:18px;align-items:center;margin-top:14px}.donut{width:132px;height:132px;flex:0 0 auto;border-radius:50%;padding:28px;background:conic-gradient(${donutStops})}.donut div{display:grid;place-content:center;width:100%;height:100%;border-radius:50%;background:#fff;text-align:center;font-size:15px;font-weight:800}.donut small{display:block;color:var(--muted);font-size:10px;font-weight:600}.category-list,.transactions,.insights{padding:0;margin:0;list-style:none}.category-list li{display:grid;grid-template-columns:10px 1fr auto 34px;gap:7px;align-items:center;padding:5px 0;font-size:11px}.dot{width:9px;height:9px;border-radius:50%}.category-list .name{text-transform:capitalize}.category-list em{color:var(--muted);font-style:normal;text-align:right}.transactions{margin-top:9px}.transactions li{display:flex;gap:9px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}.transactions li:last-child{border-bottom:0}.transaction-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#e9f0ff;font-size:13px}.c1{background:#e8f8ff}.c2{background:#fff0f8}.c3{background:#fff4e8}.c4{background:#eaf8ed}.transaction-main{display:grid;gap:3px;min-width:0;flex:1}.transaction-main b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.transaction-main small{color:var(--muted);font-size:10px}.out{color:var(--red);font-size:11px;white-space:nowrap}.insights{margin-top:10px}.insights li{display:flex;gap:8px;padding:10px 0;border-bottom:1px solid var(--line);font-size:12px;line-height:1.35}.insights li:last-child{border:0}.bulb{display:grid;place-items:center;width:25px;height:25px;flex:0 0 auto;border-radius:50%;background:#fff2d8;color:#de9200}.grid-bottom{display:grid;grid-template-columns:1.1fr .9fr .9fr;gap:15px;margin-top:15px}.table{width:100%;margin-top:10px;border-collapse:collapse;font-size:11px}.table th{padding:7px 4px;background:#f7f9fd;text-align:left;color:#57657d;font-size:10px}.table td{padding:7px 4px;border-bottom:1px solid var(--line)}.table td:first-child{text-transform:capitalize}.mini-track{display:block;width:60px;height:6px;border-radius:99px;background:#e7edf5;overflow:hidden}.mini-track i{display:block;height:100%;border-radius:inherit;background:#20b45e}.green{color:var(--green)}.red{color:var(--red)}.goal{margin-top:14px}.goal-title{display:flex;justify-content:space-between;gap:12px;font-size:13px}.goal-title b{font-size:20px}.goal-track{height:9px;margin:14px 0 7px;border-radius:99px;background:#e8edf4;overflow:hidden}.goal-track span{display:block;width:${Math.max(0, Math.min(100, savingsRate))}%;height:100%;border-radius:inherit;background:#1bb96b}.goal small{color:var(--muted);font-size:11px}.goal-stats{display:grid;grid-template-columns:1fr 1fr;margin-top:15px;border:1px solid var(--line);border-radius:8px;text-align:center}.goal-stats span{padding:10px;font-size:11px}.goal-stats span+span{border-left:1px solid var(--line)}.goal-stats b{display:block;font-size:14px;margin-top:4px}.accounts{margin-top:11px}.accounts div{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}.account-dot{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#e7f0ff;color:var(--blue)}.accounts b{margin-left:auto}.total{margin-top:13px;font-size:14px;font-weight:800}.total strong{float:right;color:var(--blue);font-size:17px}.empty{color:var(--muted);font-size:12px}.mobile-menu{display:none}@media(max-width:1050px){.metrics{grid-template-columns:repeat(2,1fr)}.grid-middle,.grid-bottom{grid-template-columns:1fr 1fr}.grid-middle>article:last-child,.grid-bottom>article:first-child{grid-column:span 2}}@media(max-width:760px){.app{display:block}.sidebar{display:none}.main{padding:16px 13px}.mobile-menu{display:block;position:fixed;z-index:2;bottom:14px;right:14px;border:0;border-radius:50%;width:48px;height:48px;background:var(--blue);color:#fff;font-size:20px}.top{align-items:flex-start;flex-direction:column}.controls{width:100%}.month-form{flex:1}.month-form input{min-width:0;width:100%}.grid-top,.grid-middle,.grid-bottom{grid-template-columns:1fr}.grid-middle>article:last-child,.grid-bottom>article:first-child{grid-column:auto}.budget-layout{gap:14px}.gauge{width:108px;height:108px}.donut-layout{justify-content:center}.card{padding:15px}.metrics{gap:10px}.metric{padding:15px}.metric strong{font-size:20px}}@media(max-width:400px){.metrics{grid-template-columns:1fr}.controls{flex-wrap:wrap}.add{width:100%}}
  </style></head><body><div class="app"><aside class="sidebar"><div class="identity"><img src="/assets/email/expense-tracker-logo-dark.png" alt=""><span>Expense<br>Tracker AI<small>Personal finance</small></span></div><nav class="nav"><a class="active" href="#dashboard">⌂ Dashboard</a><a href="#transactions">▤ Transactions</a><a href="#budget">◉ Budget</a><a href="#reports">▥ Reports</a><a href="#insights">✧ AI Insights</a><a href="#goals">◎ Goals</a><a href="#accounts">▦ Accounts</a><a href="#categories">⊞ Categories</a><a href="#settings">⚙ Settings</a></nav><section class="side-help"><b>Ask AI Assistant</b><p>Where did my money go?</p><a href="#insights">Ask now</a></section></aside><main class="main" id="dashboard"><header class="top"><div><h1>Dashboard</h1><p>Welcome back. Here is your monthly financial overview.</p></div><div class="controls"><form class="month-form" action="/dashboard" method="get"><input name="month" type="month" value="${escapeHtml(month)}"><button type="submit">View month</button></form><a class="notify" href="#insights" aria-label="View insights">♧</a><a class="add" href="#transactions">＋ Add Expense</a></div></header><section class="metrics"><article class="metric"><p>Total balance</p><strong>${escapeHtml(formatMoney(balanceMinor, currency))}</strong><small>${balanceMinor >= 0 ? "↑ Positive cash flow" : "↓ Needs attention"}</small><span class="metric-icon">▣</span></article><article class="metric"><p>Total income</p><strong>${escapeHtml(formatMoney(incomeMinor, currency))}</strong><small>↑ Income recorded</small><span class="metric-icon">↓</span></article><article class="metric"><p>Total expenses</p><strong>${escapeHtml(formatMoney(spentMinor, currency))}</strong><small class="${budgetRemaining !== null && budgetRemaining < 0 ? "red" : ""}">${budgetRemaining !== null && budgetRemaining < 0 ? "↑ Above budget" : "Monthly spend"}</small><span class="metric-icon">↑</span></article><article class="metric"><p>Monthly savings</p><strong>${escapeHtml(formatMoney(balanceMinor, currency))}</strong><small>${savingsRate >= 0 ? `↑ ${savingsRate}% savings rate` : "↓ Negative savings"}</small><span class="metric-icon">✧</span></article></section><section class="grid-top"><article class="card" id="budget"><h2>Budget Overview</h2><div class="budget-layout"><div class="gauge"><span>${budgetMinor === null ? "—" : `${percent}%`}<small>of budget</small></span></div><div class="budget-list"><div><span>Budget</span><b>${budgetMinor === null ? "Not set" : escapeHtml(formatMoney(budgetMinor, currency))}</b></div><div><span>Spent</span><b>${escapeHtml(formatMoney(spentMinor, currency))}</b></div><div><span>Remaining</span><b class="${budgetRemaining !== null && budgetRemaining < 0 ? "red" : ""}">${budgetRemaining === null ? "—" : escapeHtml(formatMoney(budgetRemaining, currency))}</b></div><div><span>Over budget</span><b class="red">${budgetRemaining !== null && budgetRemaining < 0 ? escapeHtml(formatMoney(Math.abs(budgetRemaining), currency)) : "—"}</b></div></div></div><div class="budget-progress"><span style="width:${Math.min(100, percent)}%"></span></div><div class="budget-alert"><span>${budgetRemaining !== null && budgetRemaining < 0 ? `⚠ You are ${escapeHtml(formatMoney(Math.abs(budgetRemaining), currency))} over budget this month` : "✓ Your budget is on track this month"}</span><a href="#budget">View Budget</a></div></article><article class="card"><div class="trend-head"><div><h2>Spending Trend</h2></div><span class="legend"><span><i></i>Expenses</span><span><i class="income"></i>Income</span></span></div><svg class="trend" viewBox="0 0 650 195" role="img" aria-label="Daily expenses and income trend"><line class="axis" x1="30" y1="42" x2="620" y2="42"/><line class="axis" x1="30" y1="105" x2="620" y2="105"/><line class="axis" x1="30" y1="168" x2="620" y2="168"/><polyline class="spend" points="${spendingLine}"/><polyline class="income" points="${incomeLine}"/><text class="axis-label" x="30" y="188">Start</text><text class="axis-label" x="293" y="188">Mid-month</text><text class="axis-label" x="579" y="188">Month end</text></svg></article></section><section class="grid-middle"><article class="card" id="categories"><h2>Expense by Category</h2><div class="donut-layout"><div class="donut"><div>${escapeHtml(formatMoney(spentMinor, currency))}<small>Total</small></div></div><ul class="category-list">${categories}</ul></div></article><article class="card" id="transactions"><div class="trend-head"><h2>Recent Transactions</h2><a href="#transactions">View all</a></div><ul class="transactions">${transactions}</ul></article><article class="card" id="insights"><div class="trend-head"><h2>AI Insights</h2><span class="badge">New</span></div><ul class="insights">${alerts.map((alert) => `<li><span class="bulb">✦</span><span>${escapeHtml(alert)}</span></li>`).join("")}</ul><a href="#insights">View all insights</a></article></section><section class="grid-bottom"><article class="card" id="reports"><div class="trend-head"><h2>Budget vs Actual</h2><a href="#budget">Manage Budget</a></div><table class="table"><thead><tr><th>Category</th><th>Budget</th><th>Spent</th><th>Progress</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></article><article class="card" id="goals"><div class="trend-head"><h2>Savings Goal</h2><a href="#goals">Edit Goal</a></div><div class="goal"><div class="goal-title"><span>Monthly savings target</span><b>${escapeHtml(formatMoney(Math.max(0, incomeMinor * 0.2), currency))}</b></div><div class="goal-track"><span></span></div><small>${savingsRate >= 20 ? "You are on track for a 20% savings target." : "Keep saving to reach a 20% income target."}</small><div class="goal-stats"><span>Target<b>20%</b></span><span>Saved this month<b>${savingsRate}%</b></span></div></div></article><article class="card" id="accounts"><div class="trend-head"><h2>Accounts Overview</h2><a href="#accounts">View all</a></div><div class="accounts"><div><span class="account-dot">▣</span><span>Main cash flow<small>Income − expenses</small></span><b>${escapeHtml(formatMoney(balanceMinor, currency))}</b></div><div><span class="account-dot">◎</span><span>Income recorded<small>This month</small></span><b>${escapeHtml(formatMoney(incomeMinor, currency))}</b></div><div><span class="account-dot">◉</span><span>Expenses recorded<small>This month</small></span><b class="red">−${escapeHtml(formatMoney(spentMinor, currency))}</b></div></div><div class="total">Net balance<strong>${escapeHtml(formatMoney(balanceMinor, currency))}</strong></div></article></section></main></div><button class="mobile-menu" aria-label="Menu">☰</button></body></html>`;
}

void dashboardPage;
void properDashboardPage;

function useHttp(): boolean {
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") return true;
  if (process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio") return false;
  return Boolean(process.env.PORT);
}

async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Public email artwork (for example the budget-alert hero) is served from
  // the repository assets directory. Configure PUBLIC_BASE_URL in production
  // so customer emails can reference this stable HTTPS location.
  app.use("/assets", express.static("assets", { maxAge: "7d", immutable: true }));

  // Permissive CORS so browser-based and proxied MCP clients can connect.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.header("origin") || "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, mcp-session-id, x-user-id, x-mcpize-user",
    );
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check for MCPize / Cloud Run uptime monitoring.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: "expense-tracker", version: "1.0.0" });
  });

  // Domain-ownership check for the OpenAI Apps/MCP directory submission flow.
  // Serves the verification token OpenAI issues at the well-known path it
  // polls; override via env var so the token isn't pinned in source.
  const OPENAI_APPS_CHALLENGE_TOKEN =
    process.env.OPENAI_APPS_CHALLENGE_TOKEN ||
    "yqb2BkBk70m95rd9eVpIMobCvynU0v3cOUDDG1TbGJ8";
  app.get("/.well-known/openai-apps-challenge", (_req: Request, res: Response) => {
    res.type("text/plain").send(OPENAI_APPS_CHALLENGE_TOKEN);
  });
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "expense-tracker-mcp",
      transport: "streamable-http",
      endpoint: "/mcp",
    });
  });

  // The dashboard deliberately uses the exact same identity resolver as the
  // MCP endpoint. On MCPize, the authenticated browser/proxy supplies
  // x-mcpize-user-id; without it we return no finance data at all.
  app.get("/dashboard", async (req: Request, res: Response) => {
    const dashboardSecret = process.env.DASHBOARD_SESSION_SECRET;
    const token = typeof req.query.dashboard_token === "string" ? req.query.dashboard_token : undefined;
    const tokenUserId = verifyDashboardSessionToken(token, dashboardSecret);
    if (tokenUserId) {
      const secure = req.secure || req.header("x-forwarded-proto") === "https";
      res.cookie("expense_tracker_dashboard", token, { httpOnly: true, sameSite: "lax", secure, maxAge: 15 * 60 * 1000, path: "/dashboard" });
      const month = typeof req.query.month === "string" && isValidMonth(req.query.month) ? `?month=${encodeURIComponent(req.query.month)}` : "";
      res.redirect(302, `/dashboard${month}`);
      return;
    }
    const cookieToken = req.header("cookie")?.match(/(?:^|;\s*)expense_tracker_dashboard=([^;]+)/)?.[1];
    const userId = resolveUserId(req) || verifyDashboardSessionToken(cookieToken, dashboardSecret);
    if (!userId) {
      res.status(401).type("html").send("<h1>Sign-in required</h1><p>Open this dashboard through your authenticated MCPize connection.</p>");
      return;
    }
    try {
      const requestedMonth = typeof req.query.month === "string" ? req.query.month : currentMonth();
      const month = isValidMonth(requestedMonth) ? requestedMonth : currentMonth();
      const [expenses, budgets, state] = await Promise.all([
        store.listExpenses(userId, { from: `${month}-01`, to: `${month}-31`, limit: 500 }),
        store.listBudgets(userId),
        store.getFinanceState(userId),
      ]);
      const incomeThisMonth = state.incomes.filter((income) => income.date.slice(0, 7) === month);
      const overallBudget = budgets.find((budget) => budget.category === null);
      const currency = overallBudget?.currency || expenses[0]?.currency || incomeThisMonth[0]?.currency || process.env.DEFAULT_CURRENCY || "USD";
      const currencyExpenses = expenses.filter((expense) => expense.currency === currency);
      const spentMinor = currencyExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0);
      const incomeMinor = incomeThisMonth.filter((income) => income.currency === currency).reduce((sum, income) => sum + income.amountMinor, 0);
      const [year, monthNumber] = month.split("-").map(Number);
      const dailySpend = Array.from({ length: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() }, () => 0);
      const dailyIncome = Array.from({ length: dailySpend.length }, () => 0);
      for (const expense of currencyExpenses) {
        const day = Number(expense.date.slice(8, 10));
        if (day >= 1 && day <= dailySpend.length) dailySpend[day - 1] += expense.amountMinor;
      }
      for (const income of incomeThisMonth) {
        const day = Number(income.date.slice(8, 10));
        if (income.currency === currency && day >= 1 && day <= dailyIncome.length) dailyIncome[day - 1] += income.amountMinor;
      }
      const activeDays = dailySpend.filter((amount) => amount > 0).length;
      const categories = new Map<string, number>();
      for (const expense of currencyExpenses) categories.set(expense.category, (categories.get(expense.category) || 0) + expense.amountMinor);
      const categoryRows = [...categories.entries()]
        .map(([category, amountMinor]) => ({ category, amountMinor }))
        .sort((a, b) => b.amountMinor - a.amountMinor);
      const recentExpenses = [...currencyExpenses]
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 12)
        .map(({ date, category, description, amountMinor }) => ({ date, category, description, amountMinor }));
      res.set("Cache-Control", "private, no-store, max-age=0");
      res.type("html").send(referenceDashboardPage({
        month,
        currency,
        spentMinor,
        incomeMinor,
        budgetMinor: overallBudget?.currency === currency ? overallBudget.amountMinor : null,
        categoryRows,
        recentExpenses,
        dailySpend,
        activeDays,
        dailyIncome,
        categoryBudgets: budgets
          .filter((budget) => budget.category !== null && budget.currency === currency)
          .map((budget) => ({ category: budget.category!, amountMinor: budget.amountMinor })),
      }));
    } catch (error) {
      console.error("[dashboard] failed to load:", error);
      res.status(500).type("html").send("<h1>Dashboard unavailable</h1><p>Please try again shortly.</p>");
    }
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, with the
  // subscriber isolated via their auth header. The store is shared, so data
  // persists across requests.
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const userId = resolveUserId(req);
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
        method?: string;
        id?: unknown;
        params?: { name?: string };
      };
      const method = body.method;
      const label = `${method ?? "?"}${body.params?.name ? ` tool=${body.params.name}` : ""}`;

      // Opt-in request diagnostics: set LOG_REQUESTS=1 to log the resolved user
      // id and end-to-end server latency (ms) per request. `ms=` is dominated by
      // DB round trips, so it's the number to watch when comparing Turso regions.
      // Off by default so production stays quiet and skips per-request logging
      // work. Header values other than the (non-secret) user id are never logged.
      if (process.env.LOG_REQUESTS) {
        const started = Date.now();
        console.error(
          `[req] method=${label} userId=${userId ?? "(none)"} mcpizeUserId=${req.header("x-mcpize-user-id") || "-"}`,
        );
        res.once("finish", () => {
          console.error(`[req-done] method=${label} ms=${Date.now() - started}`);
        });
      }

      // Fail closed: methods that read or write a user's data require an
      // identified user. Without one we refuse rather than touch a shared
      // bucket. Discovery (initialize, tools/list, …) is still allowed so
      // clients can connect and list capabilities.
      const DATA_METHODS = new Set(["tools/call", "resources/read"]);
      if (!userId && method && DATA_METHODS.has(method)) {
        res.status(200).json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: -32001,
            message:
              "No authenticated user identity on the request (missing " +
              "x-mcpize-user-id / user token). This server refuses to read or " +
              "write expense data without an identified user.",
          },
        });
        return;
      }

      const server = buildServer(store, userId ?? "__unidentified__");
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. This server is stateless — use POST /mcp.",
      },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.error(
      `[expense-tracker-mcp] HTTP transport listening on :${port} (POST /mcp)`,
    );
  });
}

async function startStdio(): Promise<void> {
  const userId = process.env.DEFAULT_USER_ID || "local";
  const server = buildServer(store, userId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for JSON-RPC; log to stderr only.
  console.error("[expense-tracker-mcp] stdio transport ready");
}

if (useHttp()) {
  await startHttp();
} else {
  await startStdio();
}
