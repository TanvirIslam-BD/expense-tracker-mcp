import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDashboardSessionToken } from "./dashboard-auth.js";
import type { ExpenseStore } from "./store/types.js";
import {
  currentMonth,
  daysInMonth,
  formatMoney,
  isSafeMoneyAmount,
  isValidCurrency,
  isValidDate,
  isValidMonth,
  newId,
  resolveCategory,
  toMajor,
  toMinor,
  todayISO,
  view,
} from "./util.js";

const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || "USD")
  .toUpperCase()
  .slice(0, 3);

/** Most CSV data rows `import_expenses` will process in a single call. Matches
 *  the window used to look up existing expenses for duplicate detection. */
const MAX_IMPORT_ROWS = 5000;

/**
 * Email artwork, embedded as CID attachments.
 *
 * Hosted `/assets/...` URLs do not work: the platform gateway in front of this
 * app requires a bearer token on every path except `/.well-known/*`, so the
 * unauthenticated fetch an email client (or Gmail's image proxy) makes gets a
 * 401 and the recipient sees broken images. Embedding sidesteps the gate.
 *
 * These are deliberately small, email-sized derivatives of the full-resolution
 * source art: the originals are 1254x1254 logos rendered at 28px and a
 * 1024x1536 hero, which would put ~5 MB of base64 in every alert.
 */
const EMAIL_ASSETS = [
  { file: "hero-email.jpg", contentId: "budget-alert-hero", contentType: "image/jpeg" },
  { file: "logo-dark-email.png", contentId: "expense-tracker-logo-dark", contentType: "image/png" },
  { file: "logo-light-email.png", contentId: "expense-tracker-logo-light", contentType: "image/png" },
] as const;

type InlineEmailAsset = { content: string; filename: string; content_id: string; content_type: string };

/** `assets/` sits one level above both `src/` and `dist/`, so this resolves
 *  identically whether we run from source (tests) or the compiled build —
 *  unlike a process.cwd() path, which breaks when started from elsewhere. */
function emailAssetPath(file: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "email", file);
}

/** Reads the artwork for CID embedding, or null if it isn't available. */
async function loadInlineEmailAssets(): Promise<InlineEmailAsset[] | null> {
  try {
    return await Promise.all(
      EMAIL_ASSETS.map(async ({ file, contentId, contentType }) => ({
        content: (await readFile(emailAssetPath(file))).toString("base64"),
        filename: file,
        content_id: contentId,
        content_type: contentType,
      })),
    );
  } catch (error) {
    console.error(
      "[email-alert] inline artwork unavailable, falling back to hosted URLs " +
        "(these 401 behind the gateway — set PUBLIC_BASE_URL to a public host):",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Final `src` values for the three images in the alert template. */
type EmailAssetSrcs = { hero: string; logoDark: string; logoLight: string };

const INLINE_EMAIL_ASSET_SRCS: EmailAssetSrcs = {
  hero: "cid:budget-alert-hero",
  logoDark: "cid:expense-tracker-logo-dark",
  logoLight: "cid:expense-tracker-logo-light",
};

// --- small render helpers ---------------------------------------------------

type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/svg+xml" }
  )[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function text(s: string, structuredContent?: object): ToolResult {
  return structuredContent
    ? { content: [{ type: "text", text: s }], structuredContent: structuredContent as Record<string, unknown> }
    : { content: [{ type: "text", text: s }] };
}

function fail(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

function jsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

// ---------------------------------------------------------------------------
// Lightweight, dependency-free report charts. MCP image content is base64
// encoded, so inline SVG keeps the server portable while clients that render
// MCP images can show the charts directly. The text + structured result remains
// useful in clients that choose not to render SVG image blocks.
// ---------------------------------------------------------------------------

type ChartSeries = { label: string; amountMinor: number };

const CHART_COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#ca8a04", "#16a34a",
  "#0891b2", "#4f46e5", "#be123c", "#475569", "#0f766e", "#9333ea",
];

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[char]!);
}

function svgImage(svg: string): { type: "image"; data: string; mimeType: "image/svg+xml" } {
  return {
    type: "image",
    data: Buffer.from(svg, "utf8").toString("base64"),
    mimeType: "image/svg+xml",
  };
}

/** Keep chart labels legible when a user has many custom categories. */
function chartSeries(entries: ChartSeries[], maximum = 10): ChartSeries[] {
  const sorted = [...entries].filter((e) => e.amountMinor > 0).sort((a, b) => b.amountMinor - a.amountMinor);
  if (sorted.length <= maximum) return sorted;
  const visible = sorted.slice(0, maximum - 1);
  return [
    ...visible,
    {
      label: "Other",
      amountMinor: sorted.slice(maximum - 1).reduce((sum, entry) => sum + entry.amountMinor, 0),
    },
  ];
}

function pieChartSvg(title: string, currency: string, entries: ChartSeries[]): string {
  const series = chartSeries(entries);
  const total = series.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const width = 760;
  const height = Math.max(310, 105 + series.length * 28);
  const cx = 165;
  const cy = 175;
  const radius = 112;
  let angle = -Math.PI / 2;
  const slices = series.map((entry, index) => {
    const next = angle + (entry.amountMinor / total) * Math.PI * 2;
    const startX = cx + radius * Math.cos(angle);
    const startY = cy + radius * Math.sin(angle);
    const endX = cx + radius * Math.cos(next);
    const endY = cy + radius * Math.sin(next);
    const largeArc = next - angle > Math.PI ? 1 : 0;
    const path = `M ${cx} ${cy} L ${startX.toFixed(2)} ${startY.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${endX.toFixed(2)} ${endY.toFixed(2)} Z`;
    angle = next;
    return `<path d="${path}" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/>`;
  }).join("");
  const legend = series.map((entry, index) => {
    const y = 92 + index * 28;
    const percent = ((entry.amountMinor / total) * 100).toFixed(1);
    return `<rect x="330" y="${y - 13}" width="14" height="14" rx="3" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/><text x="354" y="${y}" class="label">${escapeXml(entry.label)} — ${escapeXml(formatMoney(entry.amountMinor, currency))} (${percent}%)</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}"><style>text{font-family:Arial,sans-serif;fill:#172033}.title{font-size:21px;font-weight:700}.label{font-size:14px}.muted{font-size:13px;fill:#526075}</style><rect width="100%" height="100%" rx="16" fill="#f8fafc"/><text x="28" y="40" class="title">${escapeXml(title)}</text><text x="28" y="64" class="muted">${escapeXml(formatMoney(total, currency))} total</text>${slices}<circle cx="${cx}" cy="${cy}" r="52" fill="#f8fafc"/><text x="${cx}" y="170" text-anchor="middle" class="muted">Total</text><text x="${cx}" y="190" text-anchor="middle" class="label">${escapeXml(currency)}</text>${legend}</svg>`;
}

function budgetChartSvg(month: string, currency: string, rows: { scope: string; budgetMinor: number; spentMinor: number }[]): string {
  const width = 760;
  const height = Math.max(210, 105 + rows.length * 58);
  const chartLeft = 205;
  const chartWidth = 500;
  const maximum = Math.max(1, ...rows.flatMap((row) => [row.budgetMinor, row.spentMinor]));
  const renderedRows = rows.map((row, index) => {
    const y = 100 + index * 58;
    const budgetWidth = (row.budgetMinor / maximum) * chartWidth;
    const spentWidth = (row.spentMinor / maximum) * chartWidth;
    const over = row.spentMinor > row.budgetMinor;
    return `<text x="28" y="${y + 5}" class="label">${escapeXml(row.scope)}</text><rect x="${chartLeft}" y="${y - 12}" width="${chartWidth}" height="18" rx="5" fill="#dbe4f0"/><rect x="${chartLeft}" y="${y - 12}" width="${spentWidth.toFixed(2)}" height="18" rx="5" fill="${over ? "#dc2626" : "#2563eb"}"/><line x1="${(chartLeft + budgetWidth).toFixed(2)}" y1="${y - 17}" x2="${(chartLeft + budgetWidth).toFixed(2)}" y2="${y + 11}" stroke="#0f172a" stroke-width="2"/><text x="${chartLeft}" y="${y + 30}" class="muted">${escapeXml(formatMoney(row.spentMinor, currency))} spent / ${escapeXml(formatMoney(row.budgetMinor, currency))} budget${over ? " — over budget" : ""}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Budget versus spending, ${escapeXml(currency)}"><style>text{font-family:Arial,sans-serif;fill:#172033}.title{font-size:21px;font-weight:700}.label{font-size:14px;font-weight:600}.muted{font-size:13px;fill:#526075}</style><rect width="100%" height="100%" rx="16" fill="#f8fafc"/><text x="28" y="40" class="title">Budget vs. spending — ${escapeXml(month)} (${escapeXml(currency)})</text><text x="28" y="64" class="muted">Blue = spent; black marker = budget; red = over budget</text>${renderedRows}</svg>`;
}

/** Rows per page: y starts at 780 and steps down 15pt per line, so this many
 *  expense rows plus a heading stay clear of the bottom margin on US Letter. */
const PDF_ROWS_PER_PAGE = 46;

/**
 * Minimal standards-compliant, text-only PDF for a portable report download.
 * Paginates across as many pages as the data needs — a long export must never
 * be silently clipped, since the caller reports the full row count alongside it.
 */
function reportPdfBase64(title: string, lines: string[]): string {
  const escape = (value: string) => value.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7E]/g, "?");
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += PDF_ROWS_PER_PAGE) pages.push(lines.slice(i, i + PDF_ROWS_PER_PAGE));
  if (pages.length === 0) pages.push([]);

  // Object numbering: 1 catalog, 2 page tree, 3 font, then one Page object per
  // page, then one content stream per page (each Page points at its stream).
  const firstPageObject = 4;
  const firstContentObject = firstPageObject + pages.length;
  const contents = pages.map((rows, page) => [
    pages.length > 1 ? `${title} (page ${page + 1} of ${pages.length})` : title,
    ...rows,
  ].map((line, index) => `BT /F1 ${index === 0 ? 18 : 10} Tf 48 ${780 - index * 15} Td (${escape(line)}) Tj ET`).join("\n"));

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageObject + i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.map((_, i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstContentObject + i} 0 R >>`),
    ...contents.map((body) => `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`),
  ];

  let pdf = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8").toString("base64");
}

/** Email-client-safe monthly budget alert. Tables and inline CSS work in Gmail,
 * Outlook, and mobile clients; the category bars provide a dependable chart
 * fallback where inline SVG/chart libraries are stripped. */
function budgetAlertEmailHtml(input: {
  month: string;
  scope: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  categories: { label: string; amountMinor: number }[];
  assets: EmailAssetSrcs;
}): string {
  return screenshotInspiredBudgetAlertEmailHtml(input);
}

/** Superseded by the template above; kept for reference only. */
function legacyBudgetAlertEmailHtml(input: {
  month: string;
  scope: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  categories: { label: string; amountMinor: number }[];
}): string {
  const { month, scope, currency, spentMinor, budgetMinor } = input;
  const percent = Math.round((spentMinor / budgetMinor) * 100);
  const remaining = budgetMinor - spentMinor;
  const total = input.categories.reduce((sum, category) => sum + category.amountMinor, 0);
  const categories = chartSeries(input.categories, 6);
  const rows = categories.map((category) => {
    const width = total ? Math.max(2, Math.min(100, Math.round((category.amountMinor / total) * 100))) : 0;
    return `<tr><td style="padding:8px 0;color:#334155;font-size:14px;line-height:20px;">${escapeXml(category.label)}</td><td style="padding:8px 0 8px 12px;width:52%;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="height:8px;background:#e2e8f0;border-radius:4px;"><div style="height:8px;width:${width}%;background:#2563eb;border-radius:4px;line-height:8px;font-size:1px;">&nbsp;</div></td></tr></table></td><td align="right" style="padding:8px 0 8px 12px;color:#0f172a;font-size:14px;font-weight:600;white-space:nowrap;">${escapeXml(formatMoney(category.amountMinor, currency))}</td></tr>`;
  }).join("");
  const summary = scope === "overall" ? "Your overall monthly budget has been crossed." : `Your ${scope} monthly budget has been crossed.`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;"><tr><td align="center" style="padding:28px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;"><tr><td style="padding:28px 32px 20px;background:#0f172a;color:#ffffff;"><div style="font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:#cbd5e1;">Money Copilot AI</div><div style="margin-top:10px;font-size:25px;line-height:32px;font-weight:700;">Budget limit crossed</div><div style="margin-top:8px;font-size:15px;line-height:22px;color:#e2e8f0;">${escapeXml(month)} &middot; ${escapeXml(scope)}</div></td></tr><tr><td style="padding:28px 32px 8px;"><p style="margin:0 0 20px;font-size:16px;line-height:24px;color:#334155;">${escapeXml(summary)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;"><tr><td style="padding:18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td><div style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#9a3412;">Amount spent</div><div style="margin-top:4px;font-size:27px;line-height:32px;font-weight:700;color:#9a3412;">${escapeXml(formatMoney(spentMinor, currency))}</div></td><td align="right"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#9a3412;">Monthly limit</div><div style="margin-top:4px;font-size:18px;line-height:24px;font-weight:700;color:#9a3412;">${escapeXml(formatMoney(budgetMinor, currency))}</div></td></tr></table><div style="margin-top:16px;height:10px;background:#fed7aa;border-radius:6px;"><div style="height:10px;width:100%;background:#ea580c;border-radius:6px;line-height:10px;font-size:1px;">&nbsp;</div></div><div style="margin-top:10px;font-size:14px;line-height:20px;color:#9a3412;font-weight:600;">${percent}% used &middot; ${escapeXml(formatMoney(Math.abs(remaining), currency))} over budget</div></td></tr></table></td></tr><tr><td style="padding:18px 32px 8px;"><div style="font-size:18px;line-height:26px;font-weight:700;color:#0f172a;">Monthly spending breakdown</div><div style="margin-top:4px;font-size:14px;line-height:20px;color:#64748b;">Category chart for ${escapeXml(currency)} spending this month</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;">${rows || '<tr><td style="color:#64748b;font-size:14px;">No category detail available.</td></tr>'}</table></td></tr><tr><td style="padding:22px 32px 28px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e2e8f0;"><tr><td style="padding-top:18px;font-size:14px;line-height:21px;color:#475569;">Review your full budget report for forecasts, category charts, and suggestions. Consider pausing discretionary spending in the highest categories until the new month.</td></tr></table></td></tr></table><div style="max-width:620px;padding-top:14px;font-size:12px;line-height:18px;color:#64748b;text-align:center;">You received this because you enabled budget-limit email alerts in Money Copilot AI.</div></td></tr></table></body></html>`;
}

/** Enhanced decision-focused template for customer-facing budget alerts. */
function enhancedBudgetAlertEmailHtml(input: {
  month: string;
  scope: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  categories: { label: string; amountMinor: number }[];
}): string {
  const percent = Math.round((input.spentMinor / input.budgetMinor) * 100);
  const over = input.spentMinor - input.budgetMinor;
  const [year, monthNumber] = input.month.split("-").map(Number);
  const now = new Date();
  const elapsed = now.getUTCFullYear() === year && now.getUTCMonth() + 1 === monthNumber ? Math.max(1, now.getUTCDate()) : daysInMonth(input.month);
  const daysLeft = Math.max(0, daysInMonth(input.month) - elapsed);
  const dailyPace = Math.round(input.spentMinor / elapsed);
  const categoryTotal = input.categories.reduce((sum, item) => sum + item.amountMinor, 0);
  const top = chartSeries(input.categories, 5);
  const rows = top.map((item) => {
    const share = categoryTotal ? Math.max(2, Math.round((item.amountMinor / categoryTotal) * 100)) : 0;
    return `<tr><td style="padding:9px 0;font-size:14px;color:#334155;">${escapeXml(item.label)}</td><td style="padding:9px 10px;width:47%;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="height:7px;background:#dbeafe;border-radius:4px;"><div style="height:7px;width:${share}%;background:#2563eb;border-radius:4px;font-size:1px;line-height:7px;">&nbsp;</div></td></tr></table></td><td align="right" style="padding:9px 0;font-size:14px;font-weight:700;color:#0f172a;white-space:nowrap;">${escapeXml(formatMoney(item.amountMinor, input.currency))}</td></tr>`;
  }).join("");
  const dailyMessage = daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} remain. Your current daily pace is ${formatMoney(dailyPace, input.currency)}.` : "This budget period has ended.";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#0f172a;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your ${escapeXml(input.scope)} budget is ${percent}% used for ${escapeXml(input.month)}.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7;"><tr><td align="center" style="padding:28px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dbe3ee;border-radius:14px;overflow:hidden;"><tr><td style="padding:26px 32px;background:#111827;color:#ffffff;"><div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#a5b4fc;">Money Copilot AI - Budget watch</div><div style="margin-top:9px;font-size:26px;line-height:33px;font-weight:700;">Time to review your spending</div><div style="margin-top:7px;font-size:15px;line-height:22px;color:#dbeafe;">${escapeXml(input.month)} &middot; ${escapeXml(input.scope)} budget</div></td></tr><tr><td style="padding:28px 32px 12px;"><div style="font-size:16px;line-height:24px;color:#334155;">Your budget limit has been crossed. Here is the clearest view of what happened and what to do next.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;"><tr><td style="padding:18px 18px 10px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td><div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#9a3412;">Spent</div><div style="margin-top:4px;font-size:28px;font-weight:700;color:#9a3412;">${escapeXml(formatMoney(input.spentMinor, input.currency))}</div></td><td align="right"><div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#9a3412;">Monthly limit</div><div style="margin-top:5px;font-size:18px;font-weight:700;color:#9a3412;">${escapeXml(formatMoney(input.budgetMinor, input.currency))}</div></td></tr></table><div style="margin-top:16px;height:10px;background:#fed7aa;border-radius:6px;"><div style="height:10px;width:100%;background:#ea580c;border-radius:6px;font-size:1px;line-height:10px;">&nbsp;</div></div><div style="margin-top:10px;font-size:14px;font-weight:700;color:#9a3412;">${percent}% used - ${escapeXml(formatMoney(over, input.currency))} over budget</div></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;"><tr><td width="50%" style="padding:14px 12px 14px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;"><div style="font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:#64748b;">Daily pace</div><div style="margin-top:5px;font-size:18px;font-weight:700;color:#0f172a;">${escapeXml(formatMoney(dailyPace, input.currency))}</div></td><td width="50%" style="padding:14px 0 14px 12px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;"><div style="font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:#64748b;">Budget status</div><div style="margin-top:5px;font-size:18px;font-weight:700;color:#b91c1c;">Over by ${escapeXml(formatMoney(over, input.currency))}</div></td></tr></table><div style="margin-top:20px;font-size:18px;font-weight:700;color:#0f172a;">Where the money went</div><div style="margin-top:5px;font-size:14px;line-height:20px;color:#64748b;">Category breakdown for this month's ${escapeXml(input.currency)} spending</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px;">${rows || '<tr><td style="font-size:14px;color:#64748b;">No category detail is available yet.</td></tr>'}</table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px;background:#eff6ff;border-radius:10px;"><tr><td style="padding:16px 18px;"><div style="font-size:14px;font-weight:700;color:#1e3a8a;">Suggested next step</div><div style="margin-top:5px;font-size:14px;line-height:21px;color:#334155;">${escapeXml(dailyMessage)} Focus on the largest category above and pause non-essential purchases until your next budget review.</div></td></tr></table></td></tr><tr><td style="padding:18px 32px 28px;"><div style="border-top:1px solid #e2e8f0;padding-top:16px;font-size:12px;line-height:18px;color:#64748b;text-align:center;">You received this email because you enabled budget-limit alerts in Money Copilot AI. Manage these notifications from your MCP client.</div></td></tr></table></td></tr></table></body></html>`;
}

/** Adds the artwork-led hero treatment from the approved customer-mail design. */
function screenshotInspiredBudgetAlertEmailHtml(input: {
  month: string;
  scope: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  categories: { label: string; amountMinor: number }[];
  assets: EmailAssetSrcs;
}): string {
  void enhancedBudgetAlertEmailHtml;
  void fullDashboardBudgetAlertEmailHtml;
  void legacyBudgetAlertEmailHtml;
  const base = referenceBudgetAlertEmailHtml(input);
  // Gradients and flexbox are not reliably rendered in email clients. A
  // bordered ring gives the budget gauge a stable, polished fallback.
  const inboxSafe = base
    .replace(/background:conic-gradient\([^;]+;display:flex;align-items:center;justify-content:center;margin:auto;/, "border:10px solid #ff563f;background:#fff;text-align:center;box-sizing:border-box;margin:auto;")
    .replace("width:88px;height:88px;border-radius:50%;background:#fff;padding-top:25px;box-sizing:border-box;", "height:88px;border-radius:50%;background:#fff;padding-top:22px;box-sizing:border-box;")
    .replace("▰ &nbsp;Money Copilot AI", '<img src="__LOGO_DARK_SRC__" width="28" height="28" alt="Money Copilot AI" style="vertical-align:middle;border:0;border-radius:7px;">&nbsp; Money Copilot AI')
    .replace("🔷 &nbsp;<b>Money Copilot AI</b>", '<img src="__LOGO_LIGHT_SRC__" width="22" height="22" alt="Money Copilot AI" style="vertical-align:middle;border:0;border-radius:6px;">&nbsp; <b>Money Copilot AI</b>');
  // Global replaces: the hero placeholder appears twice (a `background`
  // attribute and a CSS `url(...)`), so the old single-occurrence string
  // substitution left one of them pointing at the unreachable hosted URL.
  return inboxSafe
    .replace(/__HERO_SRC__/g, escapeXml(input.assets.hero))
    .replace(/__LOGO_DARK_SRC__/g, escapeXml(input.assets.logoDark))
    .replace(/__LOGO_LIGHT_SRC__/g, escapeXml(input.assets.logoLight));
}

function categoryEmoji(label: string): string {
  const key = label.toLowerCase();
  if (key.includes("food") || key.includes("dining")) return "🍔";
  if (key.includes("transport") || key.includes("travel")) return "🚕";
  if (key.includes("shop")) return "🛍️";
  if (key.includes("bill") || key.includes("utility")) return "🧾";
  return "💳";
}

function referenceBudgetAlertEmailHtml(input: {
  month: string; scope: string; currency: string; spentMinor: number; budgetMinor: number;
  categories: { label: string; amountMinor: number }[];
}): string {
  const over = Math.max(0, input.spentMinor - input.budgetMinor);
  const percent = Math.round((input.spentMinor / Math.max(1, input.budgetMinor)) * 100);
  const categories = chartSeries(input.categories, 3);
  const max = Math.max(1, ...categories.map((c) => c.amountMinor));
  const cards = categories.map((c) => `<tr><td style="padding:8px 0;font-size:15px;color:#111b3b;white-space:nowrap;">${categoryEmoji(c.label)}&nbsp; ${escapeXml(c.label)}</td><td style="padding:8px 12px;width:100%;"><div style="height:9px;background:#edf1f7;border-radius:8px;"><div style="height:9px;width:${Math.round(c.amountMinor / max * 100)}%;background:#1677f2;border-radius:8px;"></div></div></td><td align="right" style="padding:8px 0;font-size:15px;color:#111b3b;white-space:nowrap;">${escapeXml(formatMoney(c.amountMinor, input.currency))}</td></tr>`).join("");
  const actions = ["Pause shopping for 5 days", "Reduce food delivery", `Save around ${formatMoney(Math.max(0, Math.round(over * 1.8)), input.currency)}`];
  return `<!doctype html><html><body style="margin:0;background:#f3f7fc;font-family:Arial,Helvetica,sans-serif;color:#101a3a;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fc;"><tr><td align="center" style="padding:20px 10px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px #d9e3f1;"><tr><td background="__HERO_SRC__" style="height:300px;padding:28px 38px;background:#061840 url('__HERO_SRC__') center/cover no-repeat;color:#fff;vertical-align:top;"><div style="font-size:21px;font-weight:700;">▰ &nbsp;Money Copilot AI</div><div style="margin-top:46px;font-size:42px;line-height:1.1;font-weight:700;">Budget Alert 🔔</div><div style="margin-top:14px;font-size:25px;">You're only ${escapeXml(formatMoney(over, input.currency))} over budget.</div><div style="margin-top:12px;font-size:17px;line-height:26px;color:#e2e9ff;max-width:370px;">Your AI analyzed your spending and found opportunities to save.</div><a href="${escapeXml(process.env.EXPENSE_TRACKER_WEB_URL || "https://www.copilotai.live/")}" style="display:inline-block;margin-top:22px;padding:14px 24px;background:#1677f2;color:#fff;text-decoration:none;border-radius:8px;font-size:16px;font-weight:700;">Review Spending&nbsp; →</a></td></tr><tr><td style="padding:18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e1e8f2;border-radius:14px;"><tr><td style="padding:22px 24px;"><div style="font-size:22px;font-weight:700;">Budget Overview</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;"><tr><td width="28%" align="center"><div style="width:116px;height:116px;border-radius:50%;background:conic-gradient(#ff3b30 ${Math.min(percent,100)}%,#edf1f7 0);display:flex;align-items:center;justify-content:center;margin:auto;"><div style="width:88px;height:88px;border-radius:50%;background:#fff;padding-top:25px;box-sizing:border-box;"><b style="font-size:28px;">${percent}%</b><br><span style="font-size:11px;color:#59657e;">of budget</span></div></div></td><td align="center"><span style="font-size:13px;color:#59657e;">Spent</span><br><b style="font-size:27px;">${escapeXml(formatMoney(input.spentMinor, input.currency))}</b></td><td align="center" style="border-left:1px solid #e1e8f2;border-right:1px solid #e1e8f2;"><span style="font-size:13px;color:#59657e;">Budget</span><br><b style="font-size:27px;">${escapeXml(formatMoney(input.budgetMinor, input.currency))}</b></td><td align="center"><span style="font-size:13px;color:#59657e;">Over Budget</span><br><b style="font-size:27px;color:#ef3d36;">${escapeXml(formatMoney(over, input.currency))}</b></td></tr></table><div style="margin-top:18px;height:11px;background:linear-gradient(90deg,#4ac477,#ffc928,#f0443e);border-radius:8px;"></div></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;border:1px solid #e1e8f2;border-radius:14px;"><tr><td style="padding:22px 24px;"><div style="font-size:22px;font-weight:700;">🤖 &nbsp;AI Insights <span style="float:right;padding:7px 12px;background:#e3f8ec;border-radius:12px;color:#16934d;font-size:13px;font-weight:400;">AI Confidence&nbsp;96%</span></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;"><tr><td style="padding:15px;border:1px solid #e1e8f2;border-radius:10px;font-size:15px;">🍔 &nbsp;Food is your <b>biggest expense</b></td><td width="10"></td><td style="padding:15px;border:1px solid #e1e8f2;border-radius:10px;font-size:15px;">🛍️ &nbsp;Shopping <b style="color:#1677f2;">increased</b></td><td width="10"></td><td style="padding:15px;border:1px solid #e1e8f2;border-radius:10px;font-size:15px;">💰 &nbsp;Save approximately <b style="color:#16934d;">${escapeXml(formatMoney(Math.max(0, Math.round(over * 1.8)), input.currency))}</b></td></tr></table></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;border:1px solid #e1e8f2;border-radius:14px;"><tr><td style="padding:22px 24px;"><div style="font-size:22px;font-weight:700;">Spending Breakdown</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;">${cards || '<tr><td>No category data yet.</td></tr>'}</table></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;background:#1677f2;border-radius:14px;color:#fff;"><tr><td style="padding:24px 28px;"><div style="font-size:23px;font-weight:700;">📋 &nbsp;AI Action Plan</div>${actions.map((a) => `<div style="margin-top:10px;font-size:16px;">◉ &nbsp;${escapeXml(a)}</div>`).join("")}</td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;border:1px solid #e1e8f2;border-radius:14px;"><tr><td style="padding:22px 24px;font-size:18px;"><span style="font-size:38px;vertical-align:middle;">💬</span> <b>Ask Money Copilot AI</b><div style="margin-top:10px;color:#59657e;">“Where did my money go?”</div></td><td align="right" style="padding:22px 24px;"><a href="${escapeXml(process.env.EXPENSE_TRACKER_WEB_URL || "https://www.copilotai.live/")}" style="display:inline-block;padding:13px 20px;background:#1677f2;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Open Money Copilot AI&nbsp; →</a></td></tr></table></td></tr><tr><td align="center" style="padding:20px;color:#59657e;font-size:12px;">🔷 &nbsp;<b>Money Copilot AI</b><br>Smart Tracking. Smarter Saving.<br><span style="color:#8995aa;">You're in control. Your AI is here to help.</span></td></tr></table></td></tr></table></body></html>`;
}

function fullDashboardBudgetAlertEmailHtml(input: {
  month: string;
  scope: string;
  currency: string;
  spentMinor: number;
  budgetMinor: number;
  categories: { label: string; amountMinor: number }[];
}): string {
  const total = input.categories.reduce((sum, item) => sum + item.amountMinor, 0);
  const top = chartSeries(input.categories, 3);
  const percent = Math.round((input.spentMinor / input.budgetMinor) * 100);
  const over = input.spentMinor - input.budgetMinor;
  const daysIn = daysInMonth(input.month);
  const now = new Date();
  const [y, m] = input.month.split("-").map(Number);
  const elapsed = now.getUTCFullYear() === y && now.getUTCMonth() + 1 === m ? Math.max(1, now.getUTCDate()) : daysIn;
  const projected = Math.round((input.spentMinor / elapsed) * daysIn);
  const potentialSavings = Math.max(0, projected - input.budgetMinor);
  const icon = (label: string) => label === "food" ? "🍔" : label === "transport" ? "🚕" : label === "shopping" ? "🛍️" : label === "entertainment" ? "🎬" : label === "health" ? "💊" : "💳";
  const analysis = top.map((item, index) => `<td valign="top" width="33.33%" style="padding:6px;"><table role="presentation" width="100%" height="92" cellspacing="0" cellpadding="0" style="border:1px solid #dbe3f0;border-radius:10px;"><tr><td style="padding:13px;"><div style="font-size:26px;line-height:30px;">${icon(item.label)}</div><div style="margin-top:5px;font-size:13px;line-height:18px;color:#172554;"><strong>${escapeXml(item.label)}</strong> is your ${index === 0 ? "biggest expense" : "top spending area"}</div></td></tr></table></td>`).join("");
  const spendCards = top.map((item) => { const share = total ? Math.round((item.amountMinor / total) * 100) : 0; return `<td valign="top" width="33.33%" style="padding:6px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe3f0;border-radius:10px;"><tr><td style="padding:14px;"><div style="font-size:26px;line-height:30px;">${icon(item.label)}</div><div style="margin-top:5px;font-size:15px;font-weight:700;color:#172554;">${escapeXml(item.label)}</div><div style="font-size:21px;line-height:27px;font-weight:700;color:#0f172a;">${escapeXml(formatMoney(item.amountMinor, input.currency))}</div><div style="margin-top:10px;height:7px;background:#e2e8f0;border-radius:4px;"><div style="height:7px;width:${Math.max(2, share)}%;background:#2563eb;border-radius:4px;font-size:1px;">&nbsp;</div></div><div style="margin-top:7px;font-size:12px;color:#64748b;">${share}% of total spending</div><div style="margin-top:10px;padding:9px;background:#f5f3ff;border-radius:7px;font-size:12px;line-height:17px;color:#37306b;"><strong>AI tip</strong><br>Review this category before making your next purchase.</div></td></tr></table></td>`; }).join("");
  const actionRows = top.map((item, index) => `<tr><td style="padding:5px 0;color:#334155;font-size:13px;line-height:19px;">🔵 &nbsp;Review ${escapeXml(item.label)} spending${index === 0 ? " first" : " this week"}</td></tr>`).join("");
  const progress = Math.min(100, Math.max(0, percent));
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your AI reviewed your ${escapeXml(input.month)} spending - you are ${escapeXml(formatMoney(over, input.currency))} over budget.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;"><tr><td align="center" style="padding:18px 10px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dbe3f0;border-radius:14px;overflow:hidden;"><tr><td style="background:#061840;"><img src="__HERO_SRC__" width="640" alt="Money Copilot AI reviewing your spending" style="display:block;width:100%;max-width:640px;height:auto;border:0;outline:none;text-decoration:none;"></td></tr><tr><td style="padding:22px 28px 25px;background:#061840;color:#ffffff;"><div style="font-size:12px;letter-spacing:1.1px;text-transform:uppercase;color:#b7c8ff;">Money Copilot AI</div><div style="margin-top:8px;font-size:28px;line-height:34px;font-weight:700;">Your AI just reviewed your <span style="color:#44e1cd;">spending</span></div><div style="margin-top:8px;font-size:15px;line-height:22px;color:#e0e7ff;">You are ${escapeXml(formatMoney(over, input.currency))} over budget. Here is how to get back on track.</div><div style="margin-top:16px;display:inline-block;padding:12px 20px;background:#2867f2;border-radius:9px;color:#ffffff;font-size:14px;font-weight:700;">Review my spending &nbsp;→</div></td></tr><tr><td style="padding:18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbe3f0;border-radius:10px;"><tr><td style="padding:18px 16px 8px;"><div style="font-size:18px;font-weight:700;color:#172554;">🧠 &nbsp;AI Spending Analysis <span style="float:right;padding:5px 10px;border:1px solid #91e5c7;border-radius:16px;color:#23765e;font-size:12px;font-weight:400;">AI confidence&nbsp; 96%</span></div></td></tr><tr>${analysis || '<td style="padding:12px;color:#64748b;">No category data yet.</td>'}</tr><tr><td style="height:10px;"></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;border:1px solid #dbe3f0;border-radius:10px;"><tr><td style="padding:18px 16px 8px;"><div style="font-size:18px;font-weight:700;color:#172554;">◔ &nbsp;Budget Overview</div></td></tr><tr><td style="padding:8px 16px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="33%" align="center"><div style="font-size:12px;color:#64748b;">Spent</div><div style="font-size:22px;font-weight:700;">${escapeXml(formatMoney(input.spentMinor, input.currency))}</div></td><td width="33%" align="center" style="border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;"><div style="font-size:12px;color:#64748b;">Budget</div><div style="font-size:22px;font-weight:700;">${escapeXml(formatMoney(input.budgetMinor, input.currency))}</div></td><td width="33%" align="center"><div style="font-size:12px;color:#64748b;">Over budget</div><div style="font-size:22px;font-weight:700;color:#ef3d36;">${escapeXml(formatMoney(over, input.currency))}</div></td></tr></table><div style="margin-top:18px;height:12px;background:#dce7f8;border-radius:8px;"><div style="height:12px;width:${progress}%;background:linear-gradient(90deg,#31be82,#f2aa20,#f04438);border-radius:8px;font-size:1px;">&nbsp;</div></div><div style="margin-top:7px;text-align:right;font-size:12px;color:#64748b;">${percent}% of monthly budget used</div><div style="margin-top:14px;padding:11px 13px;background:#fff2f0;border:1px solid #ffd4cf;border-radius:8px;font-size:13px;color:#172554;">⚠️ You have used <strong style="color:#ef3d36;">${escapeXml(formatMoney(over, input.currency))}</strong> over your monthly budget.</div></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;border:1px solid #dbe3f0;border-radius:10px;"><tr><td style="padding:18px 16px 8px;"><div style="font-size:18px;font-weight:700;color:#172554;">📈 &nbsp;Where Your Money Went <span style="float:right;color:#2867f2;font-size:12px;font-weight:600;">View full breakdown&nbsp;→</span></div></td></tr><tr>${spendCards || '<td style="padding:12px;color:#64748b;">No category data yet.</td>'}</tr><tr><td style="height:10px;"></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;"><tr><td valign="top" width="50%" style="padding:18px 12px 18px 16px;border:1px solid #dbe3f0;border-radius:10px;"><div style="font-size:17px;font-weight:700;color:#172554;">📉 &nbsp;End of Month Forecast</div><div style="margin-top:17px;height:42px;border-bottom:2px solid #2867f2;background:linear-gradient(165deg,transparent 60%,#edf3ff 61%);"></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;"><tr><td align="center"><div style="font-size:11px;color:#64748b;">Daily pace</div><div style="font-size:17px;font-weight:700;">${escapeXml(formatMoney(Math.round(input.spentMinor / elapsed), input.currency))}</div></td><td align="center"><div style="font-size:11px;color:#64748b;">Projected total</div><div style="font-size:17px;font-weight:700;color:#ef3d36;">${escapeXml(formatMoney(projected, input.currency))}</div></td></tr></table></td><td width="6"></td><td valign="top" width="50%" style="padding:18px 16px 18px 12px;border:1px solid #dbe3f0;border-radius:10px;background:#f1f6ff;"><div style="font-size:17px;font-weight:700;color:#172554;">✨ &nbsp;Your AI Action Plan</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;">${actionRows || '<tr><td style="font-size:13px;">Review your recent expenses.</td></tr>'}</table><div style="margin-top:12px;padding:9px;background:#dff8ed;border-radius:7px;color:#23765e;font-size:13px;font-weight:700;">Potential savings: ${escapeXml(formatMoney(potentialSavings, input.currency))}</div></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;background:#fff9e9;border:1px solid #f4df9e;border-radius:10px;"><tr><td style="padding:16px 18px;"><div style="font-size:12px;color:#9a6811;">🏆 Weekly Challenge</div><div style="margin-top:5px;font-size:18px;font-weight:700;">3-Day No Shopping Challenge</div><div style="margin-top:4px;font-size:13px;color:#64748b;">Avoid non-essential shopping for the next 3 days. Reward: save ~${escapeXml(formatMoney(Math.round(potentialSavings / 2), input.currency))}.</div></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;background:#f6f8fd;border:1px solid #dbe3f0;border-radius:10px;"><tr><td align="center" style="padding:22px 16px;"><div style="font-size:20px;font-weight:700;color:#172554;">Ask Money Copilot AI</div><div style="margin-top:5px;font-size:13px;color:#64748b;">Your personal finance coach, always here to help.</div><div style="margin-top:15px;font-size:12px;color:#334155;">Where did my money go? &nbsp; · &nbsp; How can I save? &nbsp; · &nbsp; Show subscriptions</div></td></tr></table></td></tr><tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;"><div style="font-size:13px;font-weight:700;color:#172554;">🤖 &nbsp;Money Copilot AI</div><div style="margin-top:4px;font-size:11px;color:#64748b;">Track &nbsp;·&nbsp; Analyze &nbsp;·&nbsp; Forecast &nbsp;·&nbsp; Save</div><div style="margin-top:15px;text-align:center;font-size:11px;color:#94a3b8;">You received this email because you enabled budget-limit alerts. Manage notifications from your MCP client.</div></td></tr></table></td></tr></table></body></html>`;
}

function trendChartSvg(series: { month: string; totals: Record<string, number> }[]): string {
  // `flatMap` already yields currency codes. Wrapping it in Object.keys would
  // return array *indices* ("0", "1", …), so every totals lookup missed and the
  // chart rendered a flat zero line whatever the real spending was.
  const currency = series.flatMap((point) => Object.keys(point.totals))[0];
  const values = series.map((point) => currency ? point.totals[currency] ?? 0 : 0); const max = Math.max(1, ...values);
  const points = values.map((value, index) => `${60 + index * (640 / Math.max(1, values.length - 1))},${230 - (value / max) * 150}`).join(" ");
  const labels = series.map((point, index) => `<text x="${60 + index * (640 / Math.max(1, series.length - 1))}" y="260" text-anchor="middle" class="label">${escapeXml(point.month)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="300" viewBox="0 0 760 300" role="img" aria-label="Monthly spending trend"><style>text{font-family:Arial,sans-serif;fill:#172033}.title{font-size:20px;font-weight:700}.label{font-size:12px}.muted{font-size:13px;fill:#526075}</style><rect width="100%" height="100%" rx="16" fill="#f8fafc"/><text x="28" y="38" class="title">Monthly spending trend${currency ? ` (${escapeXml(currency)})` : ""}</text><line x1="60" y1="230" x2="700" y2="230" stroke="#94a3b8"/><polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="4" stroke-linejoin="round"/>${values.map((value, index) => `<circle cx="${60 + index * (640 / Math.max(1, values.length - 1))}" cy="${230 - (value / max) * 150}" r="5" fill="#2563eb"/><text x="${60 + index * (640 / Math.max(1, values.length - 1))}" y="${215 - (value / max) * 150}" text-anchor="middle" class="muted">${value.toFixed(2)}</text>`).join("")}${labels}</svg>`;
}

/**
 * A monetary amount in major units. Liberal in what it accepts: a real number,
 * or a string like "12.50" or "1,234.56" (commas, whitespace, and a leading
 * currency symbol are stripped before parsing). A well-behaved LLM client sends
 * a number, but scripts — or the occasional model slip on comma-grouped values —
 * send strings, so we coerce rather than reject. Bad input gets a friendly,
 * human-readable message instead of a raw type error.
 */
function moneyAmount(describe = "Amount in major units, e.g. 12.50") {
  return z
    .preprocess((v) => {
      if (typeof v === "string") {
        const cleaned = v.replace(/[,\s$£€]/g, "");
        if (cleaned === "") return undefined; // empty → trigger "required"
        const n = Number(cleaned);
        return Number.isNaN(n) ? v : n; // keep original so invalid_type fires
      }
      return v;
    }, z
      .number({
        required_error:
          "Amount is required — give a positive number in major units, e.g. 12.50.",
        invalid_type_error:
          "Amount must be a number in major units, e.g. 12.50.",
      })
      .positive("Amount must be greater than 0.")
      .refine(isSafeMoneyAmount, "Amount is too large or not safely representable."))
    .describe(describe);
}

/** Sum minor units grouped by currency (expenses may mix currencies). */
function totalsByCurrency(items: { amountMinor: number; currency: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of items) out[e.currency] = (out[e.currency] ?? 0) + e.amountMinor;
  return out;
}

function renderTotals(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "0.00";
  return entries.map(([cur, minor]) => formatMoney(minor, cur)).join(" + ");
}

function currencyOrError(value?: string): string | null {
  const currency = (value ?? DEFAULT_CURRENCY).trim().toUpperCase();
  return isValidCurrency(currency) ? currency : null;
}

function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
}

function previousMonth(month: string, offset: number): string {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 - offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Tool input schemas, built ONCE at module load and shared across every
 * per-request server. In stateless HTTP mode a fresh McpServer is built per
 * request; the zod validators here are pure/static (no per-request state), so
 * reconstructing ~40 of them on every request is wasted CPU. Hoisting them out
 * lets each request reuse the same validated schema objects. (Handlers still
 * close over the per-request userId, so they stay inside buildServer.)
 */
const TOOL_INPUTS = {
  add_expense: {
    amount: moneyAmount(),
    category: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Category, e.g. food, transport, rent, utilities, entertainment, " +
          "shopping, health. If the user didn't state a category, YOU should " +
          "infer the most fitting one from the description/context and pass " +
          "it here — don't leave it blank. (If it's still omitted, the server " +
          "falls back to keyword inference, then 'uncategorized'.)",
      ),
    description: z.string().default("").describe("Optional note"),
    merchant: z.string().min(1).optional().describe("Merchant or vendor"),
    payment_method: z.string().min(1).optional().describe("Payment method, e.g. cash or card"),
    tags: z.array(z.string().min(1)).max(20).optional().describe("Optional searchable tags"),
    date: z.string().optional().describe("Date YYYY-MM-DD; defaults to today"),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe("ISO-4217 code; defaults to server currency"),
  },
  add_expenses: {
    expenses: z
      .array(
        z.object({
          amount: moneyAmount("Amount in major units"),
          category: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Category. If the user didn't state one, infer the most " +
                "fitting category yourself rather than leaving it blank.",
            ),
          description: z.string().default("").describe("Optional note"),
          date: z.string().optional().describe("Date YYYY-MM-DD; defaults to today"),
          currency: z.string().length(3).optional().describe("ISO-4217 code"),
        }),
      )
      .min(1)
      .max(100)
      .describe("The expenses to add (1–100)"),
  },
  list_expenses: {
    category: z.string().optional().describe("Filter by category"),
    search: z
      .string()
      .optional()
      .describe("Case-insensitive text match on the note/description or category"),
    from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
    to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
    limit: z.number().int().positive().max(500).default(50),
    offset: z.number().int().min(0).default(0).describe("Number of matching expenses to skip for pagination"),
  },
  get_expense: { id: z.string().min(1).describe("Expense id") },
  get_recent_expense: {
    category: z
      .string()
      .min(1)
      .optional()
      .describe("Optional: only consider expenses in this category"),
  },
  update_expense: {
    id: z.string().min(1).describe("Expense id"),
    amount: moneyAmount("New amount in major units").optional(),
    category: z.string().min(1).optional(),
    description: z.string().optional(),
    date: z.string().optional().describe("YYYY-MM-DD"),
    currency: z.string().length(3).optional(),
  },
  delete_expense: { id: z.string().min(1).describe("Expense id") },
  summarize_expenses: {
    group_by: z.enum(["category", "month"]).default("category"),
    from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
    to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
  },
  set_budget: {
    amount: moneyAmount("Monthly limit in major units"),
    category: z
      .string()
      .min(1)
      .optional()
      .describe("Category; omit for an overall budget"),
    currency: z.string().length(3).optional(),
    period: z.enum(["weekly", "monthly", "yearly", "custom"]).default("monthly"),
    start_date: z.string().optional().describe("Required for custom budget periods"),
    end_date: z.string().optional().describe("Required for custom budget periods"),
    rollover: z.enum(["reset", "carry"]).default("reset"),
  },
  delete_budget: {
    category: z
      .string()
      .min(1)
      .optional()
      .describe("Category; omit for the overall budget"),
  },
  delete_account: {
    confirm: z
      .literal(true)
      .describe(
        "Must be exactly true. This permanently and irreversibly deletes " +
          "every expense, budget, and finance record for this user — confirm " +
          "the user explicitly wants this before calling.",
      ),
  },
  get_budget_status: {
    month: z
      .string()
      .optional()
      .describe("Month YYYY-MM; defaults to current month"),
  },
  full_budget_report: {
    month: z
      .string()
      .optional()
      .describe("Month YYYY-MM; defaults to the current month"),
  },
  add_income: {
    amount: moneyAmount("Income amount in major units"), source: z.string().min(1),
    date: z.string().optional(), currency: z.string().optional(), notes: z.string().optional(),
  },
  set_recurring_expense: {
    amount: moneyAmount(), category: z.string().min(1), description: z.string().default(""),
    merchant: z.string().optional(), frequency: z.enum(["weekly", "monthly", "yearly"]),
    next_date: z.string(), currency: z.string().optional(), active: z.boolean().default(true),
  },
  get_spending_forecast: { month: z.string().optional() },
  compare_months: { months: z.number().int().min(2).max(24).default(6), currency: z.string().optional() },
  get_budget_alerts: { month: z.string().optional() },
  set_alert_thresholds: { thresholds: z.array(z.number().min(1).max(100)).min(1).max(10) },
  import_expenses: { csv: z.string().min(1), on_duplicate: z.enum(["skip", "allow"]).default("skip") },
  manage_categories: { action: z.enum(["list", "upsert", "delete"]), category: z.string().optional(), limit: moneyAmount().optional(), currency: z.string().optional(), color: z.string().optional() },
  get_cash_flow_report: { month: z.string().optional() },
  split_expense: { total_amount: moneyAmount(), date: z.string().optional(), currency: z.string().optional(), merchant: z.string().optional(), description: z.string().optional(), splits: z.array(z.object({ category: z.string().min(1), amount: moneyAmount() })).min(2).max(20) },
  manage_budget_templates: { action: z.enum(["list", "save", "apply", "delete"]), name: z.string().min(1).optional(), template: z.array(z.object({ category: z.string().optional(), amount: moneyAmount(), currency: z.string().optional(), period: z.enum(["weekly", "monthly", "yearly", "custom"]).default("monthly"), rollover: z.enum(["reset", "carry"]).default("reset") })).max(50).optional() },
  find_duplicate_expenses: { from: z.string().optional(), to: z.string().optional() },
  set_budget_email_alert: { email: z.string().email().optional().describe("Recipient email; omit only when disabling"), enabled: z.boolean().default(true) },
  export_expenses: {
    format: z.enum(["csv", "json", "pdf"]).default("csv"),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().positive().max(5000).default(1000),
    offset: z.number().int().min(0).default(0),
  },
};

/** Shape of the client-facing expense view (see util.ts `view()`). */
const expenseViewShape = {
  id: z.string(),
  date: z.string(),
  category: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
};

/** Money totals grouped by ISO-4217 currency code, in major units. */
const currencyTotalsShape = z.record(z.string(), z.number());

/**
 * Tool output schemas, hoisted for the same reason as TOOL_INPUTS. Each
 * matches the `structuredContent` a handler actually returns, so clients that
 * want structured data don't have to parse the human-readable text/JSON block.
 */
const TOOL_OUTPUTS = {
  add_expense: expenseViewShape,
  add_expenses: {
    count: z.number(),
    totals: currencyTotalsShape,
    expenses: z.array(z.object(expenseViewShape)),
  },
  list_expenses: {
    count: z.number(),
    totals: currencyTotalsShape,
    expenses: z.array(z.object(expenseViewShape)),
  },
  get_expense: expenseViewShape,
  get_recent_expense: expenseViewShape,
  update_expense: expenseViewShape,
  delete_expense: {
    deleted: z.boolean(),
    id: z.string(),
  },
  summarize_expenses: {
    group_by: z.enum(["category", "month"]),
    range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
    overall_total: currencyTotalsShape,
    groups: z.array(
      z.object({ key: z.string(), count: z.number(), totals: currencyTotalsShape }),
    ),
  },
  set_budget: {
    scope: z.string(),
    amount: z.number(),
    currency: z.string(),
  },
  list_budgets: {
    budgets: z.array(
      z.object({
        scope: z.string(),
        amount: z.number(),
        currency: z.string(),
        period: z.literal("monthly"),
      }),
    ),
  },
  delete_budget: {
    deleted: z.boolean(),
    scope: z.string(),
  },
  delete_account: {
    deleted: z.boolean(),
    expenses_deleted: z.number(),
    budgets_deleted: z.number(),
  },
  get_budget_status: {
    month: z.string(),
    statuses: z.array(
      z.object({
        scope: z.string(),
        currency: z.string(),
        budget: z.number(),
        spent: z.number(),
        remaining: z.number(),
        percent_used: z.number(),
        over_budget: z.boolean(),
      }),
    ),
  },
  full_budget_report: {
    month: z.string(),
    expense_count: z.number(),
    totals: currencyTotalsShape,
    categories: z.array(
      z.object({ category: z.string(), count: z.number(), totals: currencyTotalsShape }),
    ),
    budgets: z.array(
      z.object({
        scope: z.string(),
        currency: z.string(),
        budget: z.number(),
        spent: z.number(),
        remaining: z.number(),
        percent_used: z.number(),
        over_budget: z.boolean(),
      }),
    ),
    charts: z.array(
      z.object({
        type: z.enum(["pie", "budget_bar"]),
        currency: z.string(),
        title: z.string(),
        series: z.array(z.object({ label: z.string(), value: z.number() })),
      }),
    ),
    forecast: currencyTotalsShape,
    previous_month_totals: currencyTotalsShape,
  },
  list_categories: {
    categories: z.array(
      z.object({ category: z.string(), count: z.number(), totals: currencyTotalsShape }),
    ),
  },
  export_expenses: {
    format: z.enum(["csv", "json", "pdf"]),
    count: z.number(),
    csv: z.string().optional(),
    pdf_base64: z.string().optional(),
    expenses: z.array(z.object(expenseViewShape)).optional(),
  },
};

/**
 * Build a fully-configured MCP server bound to one store and one user id.
 *
 * In stateless HTTP mode a fresh server is built per request, with the
 * subscriber's id captured in this closure; the store itself is a shared
 * singleton, so data persists across requests. Tool input schemas are reused
 * from the module-level TOOL_INPUTS (built once) rather than rebuilt here.
 */
export function buildServer(store: ExpenseStore, userId: string): McpServer {
  const server = new McpServer(
    { name: "expense-tracker", version: "1.0.0" },
    {
      instructions:
        "Personal expense tracker. Use add_expense (or add_expenses for many at " +
        "once) to record spending, list_expenses/summarize_expenses to review " +
        "it, and set_budget/get_budget_status to track monthly budgets. When the " +
        "user asks for a complete report, chart, or pie chart, use full_budget_report. Amounts " +
        "are in major currency units (e.g. 12.50). Dates are YYYY-MM-DD; months " +
        "are YYYY-MM. IMPORTANT: when the user records an expense without naming " +
        "a category, choose the most appropriate category yourself (e.g. food, " +
        "transport, rent, utilities, entertainment, shopping, health) and pass " +
        "it — never leave the category blank, so spending reports stay complete.",
    },
  );

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "add_expense",
    {
      title: "Add expense",
      description:
        "Record a new expense. Amount is a positive decimal in major units " +
        "(e.g. 12.50). Date defaults to today. If budget-limit email alerts " +
        "are enabled and this entry crosses a monthly budget, the server also " +
        "sends an alert email with budget and spending details through the " +
        "configured email provider.",
      inputSchema: TOOL_INPUTS.add_expense,
      outputSchema: TOOL_OUTPUTS.add_expense,
      annotations: {
        title: "Add expense",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ amount, category, description, date, currency, merchant, payment_method, tags }) => {
      const d = date ?? todayISO();
      if (!isValidDate(d)) return fail(`Invalid date "${d}". Use YYYY-MM-DD.`);
      const cur = currencyOrError(currency);
      if (!cur) return fail("Currency must be a 3-letter ISO code, e.g. USD.");

      const note = description ?? "";
      const expense = await store.addExpense({
        userId,
        amountMinor: toMinor(amount),
        currency: cur,
        category: resolveCategory(category, note),
        description: note,
        date: d,
      });
      const viewed = view(expense);
      if (merchant || payment_method || tags?.length) {
        const state = await store.getFinanceState(userId);
        state.expenseMetadata ??= {};
        state.expenseMetadata[expense.id] = { merchant, paymentMethod: payment_method, tags: tags?.map((tag) => tag.trim().toLowerCase()) };
        await store.setFinanceState(userId, state);
      }
      await notifyBudgetLimitCrossedForMonths([d.slice(0, 7)]);

      return text(
        `Added ${formatMoney(expense.amountMinor, expense.currency)} for ` +
          `"${expense.category}" on ${expense.date}.\nID: ${expense.id}\n\n` +
          jsonBlock(viewed),
        viewed,
      );
    },
  );

  server.registerTool(
    "add_expenses",
    {
      title: "Add multiple expenses",
      description:
        "Record several expenses in one call — efficient for a receipt with " +
        "many line items or logging a whole day's spending at once. Each item " +
        "takes the same fields as add_expense. If budget-limit email alerts are " +
        "enabled and these entries cross a monthly budget, the server also sends " +
        "an alert email through the configured email provider.",
      inputSchema: TOOL_INPUTS.add_expenses,
      outputSchema: TOOL_OUTPUTS.add_expenses,
      annotations: {
        title: "Add multiple expenses",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ expenses }) => {
      const today = todayISO();
      const prepared = [];
      for (let i = 0; i < expenses.length; i++) {
        const e = expenses[i];
        const d = e.date ?? today;
        if (!isValidDate(d)) {
          return fail(`Item ${i + 1}: invalid date "${d}". Use YYYY-MM-DD.`);
        }
        const note = e.description ?? "";
        const cur = currencyOrError(e.currency);
        if (!cur) return fail(`Item ${i + 1}: currency must be a 3-letter ISO code, e.g. USD.`);
        prepared.push({
          userId,
          amountMinor: toMinor(e.amount),
          currency: cur,
          category: resolveCategory(e.category, note),
          description: note,
          date: d,
        });
      }

      const created = await store.addExpenses(prepared);
      await notifyBudgetLimitCrossedForMonths(created.map((expense) => expense.date.slice(0, 7)));
      const totals = totalsByCurrency(created);
      const structured = {
        count: created.length,
        totals: Object.fromEntries(
          Object.entries(totals).map(([c, m]) => [c, toMajor(m)]),
        ),
        expenses: created.map(view),
      };
      return text(
        `Added ${created.length} expense(s), total ${renderTotals(totals)}.\n\n` +
          jsonBlock(created.map(view)),
        structured,
      );
    },
  );

  server.registerTool(
    "list_expenses",
    {
      title: "List expenses",
      description:
        "List expenses, newest first, with optional category, date-range, and " +
        "free-text filters. Use `search` to find expenses by a word in the " +
        "note/description (e.g. \"coffee\") or category.",
      inputSchema: TOOL_INPUTS.list_expenses,
      outputSchema: TOOL_OUTPUTS.list_expenses,
      annotations: {
        title: "List expenses",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category, search, from, to, limit, offset }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);
      if (from && to && from > to) return fail('"from" must not be after "to".');

      const items = await store.listExpenses(userId, { category, search, from, to, limit, offset });
      if (items.length === 0) {
        return text("No expenses found for that filter.", {
          count: 0,
          totals: {},
          expenses: [],
        });
      }

      const lines = items.map((e) => {
        const note = e.description ? `  ${e.description}` : "";
        return (
          `• ${e.date}  ${formatMoney(e.amountMinor, e.currency).padStart(10)}  ` +
          `[${e.category}]${note}  (${e.id})`
        );
      });
      const totals = totalsByCurrency(items);
      const structured = {
        count: items.length,
        totals: Object.fromEntries(
          Object.entries(totals).map(([c, m]) => [c, toMajor(m)]),
        ),
        expenses: items.map(view),
      };

      return text(
        `${items.length} expense(s), total ${renderTotals(totals)}:\n` +
          lines.join("\n") +
          "\n\n" +
          jsonBlock(items.map(view)),
        structured,
      );
    },
  );

  server.registerTool(
    "get_expense",
    {
      title: "Get expense",
      description: "Fetch a single expense by its id.",
      inputSchema: TOOL_INPUTS.get_expense,
      outputSchema: TOOL_OUTPUTS.get_expense,
      annotations: {
        title: "Get expense",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const expense = await store.getExpense(userId, id);
      if (!expense) return fail(`No expense found with id ${id}.`);
      const viewed = view(expense);
      return text(jsonBlock(viewed), viewed);
    },
  );

  server.registerTool(
    "get_recent_expense",
    {
      title: "Get most recent expense",
      description:
        "Fetch the single most recently dated expense (optionally within a " +
        "category). Use this to resolve references like \"my last expense\" or " +
        "\"that coffee I just added\" into a concrete id you can then pass to " +
        "update_expense or delete_expense.",
      inputSchema: TOOL_INPUTS.get_recent_expense,
      outputSchema: TOOL_OUTPUTS.get_recent_expense,
      annotations: {
        title: "Get most recent expense",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category }) => {
      const [expense] = await store.listExpenses(userId, { category, limit: 1 });
      if (!expense) {
        return category
          ? fail(`No expenses found in category "${category}".`)
          : fail("No expenses recorded yet.");
      }
      const viewed = view(expense);
      return text(
        `Most recent${category ? ` "${category}"` : ""} expense: ` +
          `${formatMoney(expense.amountMinor, expense.currency)} on ${expense.date}.\n` +
          `ID: ${expense.id}\n\n` +
          jsonBlock(viewed),
        viewed,
      );
    },
  );

  server.registerTool(
    "update_expense",
    {
      title: "Update expense",
      description:
        "Update fields of an existing expense. Only provided fields change. If " +
        "budget-limit email alerts are enabled and the change crosses a monthly " +
        "budget, the server also sends an alert email through the configured " +
        "email provider.",
      inputSchema: TOOL_INPUTS.update_expense,
      outputSchema: TOOL_OUTPUTS.update_expense,
      annotations: {
        title: "Update expense",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, amount, category, description, date, currency }) => {
      if (date && !isValidDate(date)) return fail(`Invalid date "${date}".`);
      if (currency && !currencyOrError(currency)) return fail("Currency must be a 3-letter ISO code, e.g. USD.");
      if (
        amount == null &&
        category == null &&
        description == null &&
        date == null &&
        currency == null
      ) {
        return fail("Provide at least one field to update.");
      }

      const updated = await store.updateExpense(userId, id, {
        amountMinor: amount != null ? toMinor(amount) : undefined,
        category: category?.trim().toLowerCase(),
        description,
        date,
        currency: currency ? currencyOrError(currency)! : undefined,
      });
      if (!updated) return fail(`No expense found with id ${id}.`);

      // Raising an amount (or moving an expense into another month) can cross a
      // limit just as an insert can. Only the destination month needs checking:
      // spending in the month an expense moved out of can only go down.
      await notifyBudgetLimitCrossedForMonths([updated.date.slice(0, 7)]);
      const viewed = view(updated);
      return text(`Updated expense ${id}.\n\n` + jsonBlock(viewed), viewed);
    },
  );

  server.registerTool(
    "delete_expense",
    {
      title: "Delete expense",
      description: "Delete an expense by its id.",
      inputSchema: TOOL_INPUTS.delete_expense,
      outputSchema: TOOL_OUTPUTS.delete_expense,
      annotations: {
        title: "Delete expense",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const removed = await store.deleteExpense(userId, id);
      return removed
        ? text(`Deleted expense ${id}.`, { deleted: true, id })
        : fail(`No expense found with id ${id}.`);
    },
  );

  server.registerTool(
    "summarize_expenses",
    {
      title: "Summarize expenses",
      description:
        "Aggregate spending grouped by category or by month, within an " +
        "optional date range.",
      inputSchema: TOOL_INPUTS.summarize_expenses,
      outputSchema: TOOL_OUTPUTS.summarize_expenses,
      annotations: {
        title: "Summarize expenses",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ group_by, from, to }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);
      if (from && to && from > to) return fail('"from" must not be after "to".');

      // Grouping + summing happens in the store (SQL GROUP BY on Turso), so we
      // never pull the full row set back just to fold it in memory here.
      const groups = await store.aggregate(userId, { groupBy: group_by, from, to });
      if (groups.length === 0) {
        return text("No expenses found for that range.", {
          group_by,
          range: { from: from ?? null, to: to ?? null },
          overall_total: {},
          groups: [],
        });
      }

      const rows = groups
        .map((g) => ({
          key: g.key,
          count: g.count,
          // Sort weight: sum of minor units across currencies (rough but stable).
          weight: Object.values(g.totals).reduce((a, b) => a + b, 0),
          totals: g.totals,
        }))
        .sort((a, b) =>
          group_by === "month" ? b.key.localeCompare(a.key) : b.weight - a.weight,
        );

      // Fold overall totals + count from the grouped buckets.
      const overall: Record<string, number> = {};
      let totalCount = 0;
      for (const r of rows) {
        totalCount += r.count;
        for (const [c, m] of Object.entries(r.totals)) {
          overall[c] = (overall[c] ?? 0) + m;
        }
      }
      const lines = rows.map(
        (r) => `• ${r.key.padEnd(16)}  ${renderTotals(r.totals)}  (${r.count})`,
      );

      const structured = {
        group_by,
        range: { from: from ?? null, to: to ?? null },
        overall_total: Object.fromEntries(
          Object.entries(overall).map(([c, m]) => [c, toMajor(m)]),
        ),
        groups: rows.map((r) => ({
          key: r.key,
          count: r.count,
          totals: Object.fromEntries(
            Object.entries(r.totals).map(([c, m]) => [c, toMajor(m)]),
          ),
        })),
      };

      return text(
        `Spending by ${group_by} (${totalCount} expenses, ` +
          `total ${renderTotals(overall)}):\n` +
          lines.join("\n") +
          "\n\n" +
          jsonBlock(structured),
        structured,
      );
    },
  );

  server.registerTool(
    "set_budget",
    {
      title: "Set budget",
      description:
        "Set a monthly budget. Omit category for an overall budget; provide a " +
        "category for a per-category budget. Re-setting a matching budget " +
        "overwrites its existing configuration. Note: weekly, yearly, and custom " +
        "periods are recorded but are not yet reflected in budget status, alerts, " +
        "or reports — use monthly for budgets you want tracked.",
      inputSchema: TOOL_INPUTS.set_budget,
      outputSchema: TOOL_OUTPUTS.set_budget,
      annotations: {
        title: "Set budget",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ amount, category, currency, period, start_date, end_date, rollover }) => {
      const cur = currencyOrError(currency);
      if (!cur) return fail("Currency must be a 3-letter ISO code, e.g. USD.");
      if (period === "custom" && (!start_date || !end_date || !isValidDate(start_date) || !isValidDate(end_date) || start_date > end_date)) {
        return fail("Custom budgets require a valid start_date and end_date (YYYY-MM-DD).");
      }
      // Preserve the legacy monthly table for fast existing reports. Extended
      // weekly/yearly/custom and rollover rules live in durable finance state.
      if (period !== "monthly" || rollover !== "reset") {
        const state = await store.getFinanceState(userId);
        const target = category ? category.trim().toLowerCase() : null;
        const existing = state.budgetRules.find((rule) => rule.category === target && rule.period === period && rule.currency === cur);
        const rule = { id: existing?.id ?? newId(), category: target, amountMinor: toMinor(amount), currency: cur, period, startDate: start_date, endDate: end_date, rollover, createdAt: existing?.createdAt ?? new Date().toISOString() };
        if (existing) Object.assign(existing, rule); else state.budgetRules.push(rule);
        await store.setFinanceState(userId, state);
        return text(`Set ${period} ${target ? `"${target}"` : "overall"} budget to ${formatMoney(rule.amountMinor, cur)} (${rollover} rollover).`, { scope: target ?? "overall", amount, currency: cur, period, rollover, start_date, end_date });
      }
      const budget = await store.setBudget({
        userId,
        category: category ? category.trim().toLowerCase() : null,
        amountMinor: toMinor(amount),
        currency: cur,
      });
      const label = budget.category ? `"${budget.category}"` : "overall";
      return text(
        `Set ${label} monthly budget to ` +
          `${formatMoney(budget.amountMinor, budget.currency)}.`,
        {
          scope: budget.category ?? "overall",
          amount: toMajor(budget.amountMinor),
          currency: budget.currency,
        },
      );
    },
  );

  server.registerTool(
    "list_budgets",
    {
      title: "List budgets",
      description:
        "List all monthly budgets you've set — the overall budget and any " +
        "per-category budgets.",
      inputSchema: {},
      outputSchema: TOOL_OUTPUTS.list_budgets,
      annotations: {
        title: "List budgets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const budgets = await store.listBudgets(userId);
      if (budgets.length === 0) {
        return text("No budgets set. Use set_budget to create one.", { budgets: [] });
      }
      const lines = budgets.map(
        (b) =>
          `• ${(b.category ?? "overall").padEnd(14)} ` +
          `${formatMoney(b.amountMinor, b.currency)} / month`,
      );
      const structured = budgets.map((b) => ({
        scope: b.category ?? "overall",
        amount: toMajor(b.amountMinor),
        currency: b.currency,
        period: b.period,
      }));
      return text(lines.join("\n") + "\n\n" + jsonBlock(structured), { budgets: structured });
    },
  );

  server.registerTool(
    "delete_budget",
    {
      title: "Delete budget",
      description:
        "Remove a monthly budget. Omit category to delete the overall budget; " +
        "provide a category to delete that category's budget.",
      inputSchema: TOOL_INPUTS.delete_budget,
      outputSchema: TOOL_OUTPUTS.delete_budget,
      annotations: {
        title: "Delete budget",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category }) => {
      const target = category ? category.trim().toLowerCase() : null;
      const budgets = await store.listBudgets(userId);
      const found = budgets.find((b) => b.category === target);
      const label = target ? `"${target}"` : "overall";
      if (!found) return fail(`No ${label} budget to delete.`);
      await store.deleteBudget(userId, found.id);
      return text(`Deleted ${label} monthly budget.`, {
        deleted: true,
        scope: target ?? "overall",
      });
    },
  );

  server.registerTool(
    "delete_account",
    {
      title: "Delete all account data",
      description:
        "Permanently and irreversibly delete every expense, budget, and " +
        "finance record (income, recurring transactions, category settings, " +
        "budget templates, alert preferences) for this user. Requires " +
        "confirm: true. There is no undo — only call this after the user has " +
        "explicitly and unambiguously asked to delete all their data.",
      inputSchema: TOOL_INPUTS.delete_account,
      outputSchema: TOOL_OUTPUTS.delete_account,
      annotations: {
        title: "Delete all account data",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      // deleteAllUserData already clears finance_state in both backends —
      // no need to re-write an empty state row afterward.
      const { expensesDeleted, budgetsDeleted } = await store.deleteAllUserData(userId);
      const structured = { deleted: true, expenses_deleted: expensesDeleted, budgets_deleted: budgetsDeleted };
      return text(
        `Deleted all account data: ${expensesDeleted} expense(s), ${budgetsDeleted} budget(s), and all ` +
          `income/recurring/category/template/alert settings. This cannot be undone.`,
        structured,
      );
    },
  );

  server.registerTool(
    "get_budget_status",
    {
      title: "Get budget status",
      description:
        "Compare this month's (or a given month's) spending against your " +
        "budgets. Reports spent, remaining, and over-budget flags.",
      inputSchema: TOOL_INPUTS.get_budget_status,
      outputSchema: TOOL_OUTPUTS.get_budget_status,
      annotations: {
        title: "Get budget status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ month }) => {
      const m = month ?? currentMonth();
      if (!isValidMonth(m)) return fail(`Invalid month "${m}". Use YYYY-MM.`);

      const budgets = await store.listBudgets(userId);
      if (budgets.length === 0) {
        return text("No budgets set. Use set_budget to create one.", {
          month: m,
          statuses: [],
        });
      }

      // Scope to the month at the store level (uses the (user_id, date) index)
      // rather than fetching every expense and filtering in memory. All valid
      // days in month `m` sort within [`${m}-01`, `${m}-31`] lexicographically.
      const monthExpenses = await store.listExpenses(userId, {
        from: `${m}-01`,
        to: `${m}-31`,
      });

      const statuses = budgets.map((b) => {
        const relevant = monthExpenses.filter(
          (e) =>
            e.currency === b.currency &&
            (b.category === null || e.category === b.category),
        );
        const spentMinor = relevant.reduce((a, e) => a + e.amountMinor, 0);
        const remainingMinor = b.amountMinor - spentMinor;
        const pct = b.amountMinor > 0 ? (spentMinor / b.amountMinor) * 100 : 0;
        return {
          scope: b.category ?? "overall",
          currency: b.currency,
          budget: toMajor(b.amountMinor),
          spent: toMajor(spentMinor),
          remaining: toMajor(remainingMinor),
          percent_used: Math.round(pct * 10) / 10,
          over_budget: spentMinor > b.amountMinor,
          _budgetMinor: b.amountMinor,
          _spentMinor: spentMinor,
          _remainingMinor: remainingMinor,
        };
      });

      const lines = statuses.map((s) => {
        const flag = s.over_budget ? "  ⚠ OVER" : "";
        return (
          `• ${s.scope.padEnd(14)} ${formatMoney(s._spentMinor, s.currency)} / ` +
          `${formatMoney(s._budgetMinor, s.currency)}  ` +
          `(${s.percent_used}% used, ${formatMoney(s._remainingMinor, s.currency)} left)${flag}`
        );
      });

      const structured = statuses.map((s) => ({
        scope: s.scope,
        currency: s.currency,
        budget: s.budget,
        spent: s.spent,
        remaining: s.remaining,
        percent_used: s.percent_used,
        over_budget: s.over_budget,
      }));

      return text(
        `Budget status for ${m}:\n` + lines.join("\n") + "\n\n" + jsonBlock(structured),
        { month: m, statuses: structured },
      );
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "List the categories you've used, with expense counts and totals.",
      inputSchema: {},
      outputSchema: TOOL_OUTPUTS.list_categories,
      annotations: {
        title: "List categories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      // Category counts + totals computed in the store (SQL GROUP BY), not by
      // fetching every expense and folding it here.
      const groups = await store.aggregate(userId, { groupBy: "category" });
      if (groups.length === 0) {
        return text("No expenses recorded yet.", { categories: [] });
      }

      const rows = groups.sort((a, b) => b.count - a.count);
      const lines = rows.map(
        (g) => `• ${g.key.padEnd(16)} ${g.count} expense(s), ${renderTotals(g.totals)}`,
      );
      const structured = rows.map((g) => ({
        category: g.key,
        count: g.count,
        totals: Object.fromEntries(
          Object.entries(g.totals).map(([c, m]) => [c, toMajor(m)]),
        ),
      }));

      return text(lines.join("\n") + "\n\n" + jsonBlock(structured), {
        categories: structured,
      });
    },
  );

  /**
   * Fire budget-limit alerts for every month a write touched. Bulk writes
   * (add_expenses, split_expense, import_expenses) can cross a limit just as
   * easily as a single add, and can span more than one month, so every write
   * path routes through here rather than alerting only on add_expense.
   *
   * Gated on the provider env vars up front so servers without email
   * configured — the common case — skip the finance-state read entirely.
   */
  async function notifyBudgetLimitCrossedForMonths(months: Iterable<string>): Promise<void> {
    if (!process.env.RESEND_API_KEY || !process.env.BUDGET_ALERT_EMAIL_FROM) return;
    const unique = [...new Set(months)].filter(isValidMonth).sort();
    if (unique.length === 0) return;
    const state = await store.getFinanceState(userId);
    if (!state.emailAlertsEnabled || !state.notificationEmail) return;
    for (const month of unique) await notifyBudgetLimitCrossed(month);
  }

  /** Send each budget-limit alert at most once per month/scope/currency. */
  async function notifyBudgetLimitCrossed(month: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.BUDGET_ALERT_EMAIL_FROM;
    const state = await store.getFinanceState(userId);
    if (!state.emailAlertsEnabled || !state.notificationEmail || !apiKey || !from) return;
    const expenses = await store.listExpenses(userId, monthRange(month));
    const budgets = await store.listBudgets(userId);
    state.sentAlertKeys ??= [];
    let changed = false;
    for (const budget of budgets) {
      const spent = expenses.filter((expense) => expense.currency === budget.currency && (budget.category === null || expense.category === budget.category)).reduce((sum, expense) => sum + expense.amountMinor, 0);
      if (spent < budget.amountMinor) continue;
      const scope = budget.category ?? "overall";
      const key = `${month}:${scope}:${budget.currency}:100`;
      if (state.sentAlertKeys.includes(key)) continue;
      const subject = `Budget limit crossed: ${scope} (${month})`;
      const providerKey = `budget-alert:${createHash("sha256").update(userId).digest("hex").slice(0, 24)}:${key}`;
      const text = `Your ${scope} budget for ${month} has been crossed. Spent: ${formatMoney(spent, budget.currency)}. Budget: ${formatMoney(budget.amountMinor, budget.currency)}.`;
      const categoryMap = new Map<string, number>();
      for (const expense of expenses) {
        if (expense.currency !== budget.currency || (budget.category !== null && expense.category !== budget.category)) continue;
        categoryMap.set(expense.category, (categoryMap.get(expense.category) ?? 0) + expense.amountMinor);
      }
      const publicRoot = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
      const publicHeroUrl = process.env.BUDGET_ALERT_HERO_URL || (publicRoot ? `${publicRoot}/assets/email/budget-alert-robot-v2.png` : "");
      const publicDarkLogoUrl = publicRoot ? `${publicRoot}/assets/email/expense-tracker-logo-dark.png` : "";
      const publicLightLogoUrl = publicRoot ? `${publicRoot}/assets/email/expense-tracker-logo-light.png` : "";
      // CID embedding is the default: hosted /assets URLs sit behind the
      // gateway's auth and 401 for the unauthenticated fetch every mail client
      // makes. Set EMAIL_INLINE_HERO=false only if /assets is publicly served.
      const inlineAssets = process.env.EMAIL_INLINE_HERO === "false" ? null : await loadInlineEmailAssets();
      const assets: EmailAssetSrcs = inlineAssets
        ? INLINE_EMAIL_ASSET_SRCS
        : { hero: publicHeroUrl, logoDark: publicDarkLogoUrl, logoLight: publicLightLogoUrl };
      const html = budgetAlertEmailHtml({ month, scope, currency: budget.currency, spentMinor: spent, budgetMinor: budget.amountMinor, categories: [...categoryMap.entries()].map(([label, amountMinor]) => ({ label, amountMinor })), assets });
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "expense-tracker-mcp/1.0", "Idempotency-Key": providerKey },
          body: JSON.stringify({ from, to: [state.notificationEmail], subject, text, html, attachments: inlineAssets ?? undefined }),
        });
        if (!response.ok) {
          const providerBody = await response.text();
          throw new Error(`email provider responded ${response.status}: ${providerBody.slice(0, 300)}`);
        }
        state.sentAlertKeys.push(key); changed = true;
      } catch (error) {
        // Notifications are best-effort: never fail an acknowledged expense if
        // email delivery is temporarily unavailable.
        console.error("[email-alert] delivery failed:", error instanceof Error ? error.message : error);
      }
    }
    if (changed) await store.setFinanceState(userId, state);
  }

  server.registerTool(
    "full_budget_report",
    {
      title: "Full budget and expense report with charts",
      description:
        "Generate a complete monthly expense and budget report. Returns spending " +
        "totals, category and budget details, plus pie and budget-bar chart images " +
        "when the MCP client supports image content.",
      inputSchema: TOOL_INPUTS.full_budget_report,
      outputSchema: TOOL_OUTPUTS.full_budget_report,
      annotations: {
        title: "Full budget and expense report with charts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ month }) => {
      const m = month ?? currentMonth();
      if (!isValidMonth(m)) return fail(`Invalid month "${m}". Use YYYY-MM.`);

      const expenses = await store.listExpenses(userId, monthRange(m));
      const previousExpenses = await store.listExpenses(userId, monthRange(previousMonth(m, 1)));
      const budgets = await store.listBudgets(userId);
      const totals = totalsByCurrency(expenses);
      const elapsedDays = m === currentMonth() ? Math.max(1, Number(todayISO().slice(8, 10))) : daysInMonth(m);
      const forecast = Object.fromEntries(Object.entries(totals).map(([currency, minor]) => [currency, toMajor(Math.round((minor / elapsedDays) * daysInMonth(m)))]));
      const previousMonthTotals = Object.fromEntries(Object.entries(totalsByCurrency(previousExpenses)).map(([currency, minor]) => [currency, toMajor(minor)]));

      const categoryMap = new Map<string, { count: number; totals: Record<string, number> }>();
      for (const expense of expenses) {
        const category = categoryMap.get(expense.category) ?? { count: 0, totals: {} };
        category.count += 1;
        category.totals[expense.currency] = (category.totals[expense.currency] ?? 0) + expense.amountMinor;
        categoryMap.set(expense.category, category);
      }
      const categories = [...categoryMap.entries()]
        .map(([category, value]) => ({ category, ...value }))
        .sort((a, b) => b.count - a.count);

      const budgetRows = budgets.map((budget) => {
        const spentMinor = expenses
          .filter(
            (expense) =>
              expense.currency === budget.currency &&
              (budget.category === null || expense.category === budget.category),
          )
          .reduce((sum, expense) => sum + expense.amountMinor, 0);
        const remainingMinor = budget.amountMinor - spentMinor;
        return {
          scope: budget.category ?? "overall",
          currency: budget.currency,
          budget: toMajor(budget.amountMinor),
          spent: toMajor(spentMinor),
          remaining: toMajor(remainingMinor),
          percent_used: Math.round((spentMinor / budget.amountMinor) * 1000) / 10,
          over_budget: spentMinor > budget.amountMinor,
          budgetMinor: budget.amountMinor,
          spentMinor,
        };
      });

      const charts: { type: "pie" | "budget_bar"; currency: string; title: string; series: { label: string; value: number }[] }[] = [];
      const images: { type: "image"; data: string; mimeType: "image/svg+xml" }[] = [];
      for (const currency of Object.keys(totals).sort()) {
        const series = categories
          .map((category) => ({ label: category.category, amountMinor: category.totals[currency] ?? 0 }))
          .filter((entry) => entry.amountMinor > 0);
        if (series.length === 0) continue;
        const title = `Spending by category — ${m} (${currency})`;
        const visibleSeries = chartSeries(series);
        charts.push({
          type: "pie",
          currency,
          title,
          series: visibleSeries.map((entry) => ({ label: entry.label, value: toMajor(entry.amountMinor) })),
        });
        images.push(svgImage(pieChartSvg(title, currency, series)));
      }
      for (const currency of [...new Set(budgetRows.map((row) => row.currency))].sort()) {
        const rows = budgetRows.filter((row) => row.currency === currency);
        const title = `Budget vs. spending — ${m} (${currency})`;
        charts.push({
          type: "budget_bar",
          currency,
          title,
          series: rows.map((row) => ({ label: row.scope, value: row.spent })),
        });
        images.push(svgImage(budgetChartSvg(m, currency, rows)));
      }

      const structured = {
        month: m,
        expense_count: expenses.length,
        totals: Object.fromEntries(Object.entries(totals).map(([currency, minor]) => [currency, toMajor(minor)])),
        forecast,
        previous_month_totals: previousMonthTotals,
        categories: categories.map((category) => ({
          category: category.category,
          count: category.count,
          totals: Object.fromEntries(
            Object.entries(category.totals).map(([currency, minor]) => [currency, toMajor(minor)]),
          ),
        })),
        budgets: budgetRows.map(({ budgetMinor: _budgetMinor, spentMinor: _spentMinor, ...row }) => row),
        charts,
      };
      const budgetSummary = budgetRows.length
        ? `${budgetRows.filter((row) => row.over_budget).length} over budget`
        : "no budgets set";
      const report =
        `Full report for ${m}: ${expenses.length} expense(s), total ${renderTotals(totals)}; ${budgetSummary}.` +
        (images.length
          ? "\n\nCharts are attached below. Clients without image rendering can use the structured chart data."
          : "\n\nNo chart data is available yet. Add expenses or a budget for this month.");
      return {
        content: [{ type: "text", text: report + "\n\n" + jsonBlock(structured) }, ...images],
        structuredContent: structured,
      };
    },
  );

  // Advanced finance-management tools. Their state is kept in the store's
  // durable per-user finance document, while expense rows remain queryable via
  // the existing indexed table.
  server.registerTool("set_budget_email_alert", { title: "Configure budget-limit email alerts", description: "Enable or disable an email when a monthly budget is crossed. Email is sent only if the server has RESEND_API_KEY and BUDGET_ALERT_EMAIL_FROM configured.", inputSchema: TOOL_INPUTS.set_budget_email_alert, annotations: { title: "Configure budget-limit email alerts", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ email, enabled }) => {
    if (enabled && !email) return fail("email is required when enabling alerts.");
    const state = await store.getFinanceState(userId);
    state.emailAlertsEnabled = enabled;
    if (email) state.notificationEmail = email.trim().toLowerCase();
    if (!enabled) state.sentAlertKeys = [];
    await store.setFinanceState(userId, state);
    return text(enabled ? `Budget-limit emails enabled for ${state.notificationEmail}.` : "Budget-limit emails disabled.", { enabled, email: state.notificationEmail ?? null, configured_provider: Boolean(process.env.RESEND_API_KEY && process.env.BUDGET_ALERT_EMAIL_FROM) });
  });

  server.registerTool("get_dashboard_link", {
    title: "Open private finance dashboard",
    description: "Create a short-lived link to the authenticated user's private /dashboard page.",
    inputSchema: z.object({}),
    annotations: { title: "Open private finance dashboard", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const baseUrl = (process.env.DASHBOARD_WEB_URL || process.env.EXPENSE_TRACKER_WEB_URL || process.env.PUBLIC_BASE_URL)?.replace(/\/$/, "");
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!baseUrl || !secret) return fail("Dashboard links require DASHBOARD_WEB_URL (or EXPENSE_TRACKER_WEB_URL) and DASHBOARD_SESSION_SECRET on the server.");
    const dashboardToken = createDashboardSessionToken(userId, secret);
    const url = `${baseUrl}/dashboard?dashboard_token=${encodeURIComponent(dashboardToken)}`;
    return text(`Open your private dashboard: ${url}\n\nThis link expires in 15 minutes.`, { url, expires_in_minutes: 15 });
  });

  server.registerTool("add_income", { title: "Add income", description: "Record income for cash-flow and savings reports.", inputSchema: TOOL_INPUTS.add_income, annotations: { title: "Add income", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async ({ amount, source, date, currency, notes }) => {
    const d = date ?? todayISO(); const cur = currencyOrError(currency);
    if (!isValidDate(d)) return fail(`Invalid date "${d}".`);
    if (!cur) return fail("Currency must be a 3-letter ISO code, e.g. USD.");
    const state = await store.getFinanceState(userId);
    const income = { id: newId(), amountMinor: toMinor(amount), currency: cur, source: source.trim(), date: d, notes: notes ?? "", createdAt: new Date().toISOString() };
    state.incomes.push(income); await store.setFinanceState(userId, state);
    return text(`Added income ${formatMoney(income.amountMinor, cur)} from ${income.source}.`, { ...income, amount: toMajor(income.amountMinor) });
  });

  server.registerTool("set_recurring_expense", { title: "Set recurring expense", description: "Create or update a recurring rent, subscription, utility, or loan expense.", inputSchema: TOOL_INPUTS.set_recurring_expense, annotations: { title: "Set recurring expense", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ amount, category, description, merchant, frequency, next_date, currency, active }) => {
    const cur = currencyOrError(currency); if (!cur) return fail("Currency must be a 3-letter ISO code, e.g. USD.");
    if (!isValidDate(next_date)) return fail(`Invalid next_date "${next_date}".`);
    const state = await store.getFinanceState(userId);
    const key = `${merchant ?? ""}|${category.trim().toLowerCase()}|${frequency}`;
    const existing = state.recurring.find((entry) => `${entry.merchant}|${entry.category}|${entry.frequency}` === key && entry.kind === "expense");
    const entry = { id: existing?.id ?? newId(), kind: "expense" as const, amountMinor: toMinor(amount), currency: cur, category: resolveCategory(category, description), description, merchant: merchant ?? "", frequency, nextDate: next_date, active, createdAt: existing?.createdAt ?? new Date().toISOString() };
    if (existing) Object.assign(existing, entry); else state.recurring.push(entry);
    await store.setFinanceState(userId, state);
    return text(`Saved ${frequency} recurring expense ${formatMoney(entry.amountMinor, cur)} (${entry.category}).`, { ...entry, amount: toMajor(entry.amountMinor) });
  });

  server.registerTool("split_expense", { title: "Split expense", description: "Record one purchase split across two or more categories. If budget-limit email alerts are enabled and the split crosses a monthly budget, the server also sends an alert email through the configured email provider.", inputSchema: TOOL_INPUTS.split_expense, annotations: { title: "Split expense", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async ({ total_amount, date, currency, merchant, description, splits }) => {
    const d = date ?? todayISO(); const cur = currencyOrError(currency);
    if (!isValidDate(d)) return fail(`Invalid date "${d}".`); if (!cur) return fail("Currency must be a 3-letter ISO code, e.g. USD.");
    const splitMinor = splits.reduce((sum, split) => sum + toMinor(split.amount), 0);
    if (splitMinor !== toMinor(total_amount)) return fail("Split amounts must equal total_amount exactly.");
    const created = await store.addExpenses(splits.map((split) => ({ userId, amountMinor: toMinor(split.amount), currency: cur, category: resolveCategory(split.category, description), description: [merchant, description].filter(Boolean).join(" — "), date: d })));
    await notifyBudgetLimitCrossedForMonths([d.slice(0, 7)]);
    return text(`Added ${created.length} split expense entries totalling ${formatMoney(splitMinor, cur)}.`, { count: created.length, expenses: created.map(view) });
  });

  server.registerTool("import_expenses", { title: "Import expenses from CSV", description: `Import CSV columns amount, category, date, description, currency; duplicate rows can be skipped. Processes up to ${MAX_IMPORT_ROWS} data rows per call and reports any beyond that as not_processed. If budget-limit email alerts are enabled and the import crosses a monthly budget, the server also sends an alert email through the configured email provider.`, inputSchema: TOOL_INPUTS.import_expenses, annotations: { title: "Import expenses from CSV", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async ({ csv, on_duplicate }) => {
    const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean); if (lines.length < 2) return fail("CSV needs a header and at least one data row.");
    const header = lines[0].split(",").map((value) => value.trim().toLowerCase());
    const index = (name: string) => header.indexOf(name); if (index("amount") < 0) return fail("CSV must contain an amount column.");
    const existing = await store.listExpenses(userId, { limit: 5000 }); const prepared: { userId: string; amountMinor: number; currency: string; category: string; description: string; date: string }[] = []; let skipped = 0;
    // Rows beyond the cap are reported back, never dropped in silence: the
    // caller needs to know an import was partial so it can send the remainder.
    const dataLines = lines.slice(1);
    const notProcessed = Math.max(0, dataLines.length - MAX_IMPORT_ROWS);
    for (const line of dataLines.slice(0, MAX_IMPORT_ROWS)) {
      const values = line.match(/(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^,]*))/g)?.map((part) => part.replace(/^,/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
      const amount = Number(values[index("amount")]?.replace(/[,$\s]/g, "")); const d = values[index("date")] || todayISO(); const cur = currencyOrError(values[index("currency")] || undefined);
      if (!isSafeMoneyAmount(amount) || !isValidDate(d) || !cur) { skipped++; continue; }
      const category = resolveCategory(values[index("category")], values[index("description")]); const description = values[index("description")] ?? ""; const minor = toMinor(amount);
      if (on_duplicate === "skip" && existing.some((e) => e.amountMinor === minor && e.date === d && e.currency === cur && e.category === category && e.description === description)) { skipped++; continue; }
      prepared.push({ userId, amountMinor: minor, currency: cur, category, description, date: d });
    }
    const created = await store.addExpenses(prepared);
    await notifyBudgetLimitCrossedForMonths(created.map((expense) => expense.date.slice(0, 7)));
    return text(
      `Imported ${created.length} expense(s); skipped ${skipped}.` +
        (notProcessed
          ? ` ${notProcessed} row(s) were NOT processed — this tool imports at most ` +
            `${MAX_IMPORT_ROWS} rows per call. Re-run with the remaining rows.`
          : ""),
      { imported: created.map(view), skipped, not_processed: notProcessed, row_limit: MAX_IMPORT_ROWS },
    );
  });

  server.registerTool("manage_categories", { title: "Manage categories", description: "List, create, update, or remove custom category limits and colors.", inputSchema: TOOL_INPUTS.manage_categories, annotations: { title: "Manage categories", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ action, category, limit, currency, color }) => {
    const state = await store.getFinanceState(userId); if (action === "list") return text(jsonBlock(state.categories), { categories: state.categories.map((entry) => ({ ...entry, limit: entry.limitMinor == null ? undefined : toMajor(entry.limitMinor) })) });
    if (!category?.trim()) return fail("category is required for upsert or delete."); const name = category.trim().toLowerCase();
    if (action === "delete") { state.categories = state.categories.filter((entry) => entry.category !== name); await store.setFinanceState(userId, state); return text(`Deleted category settings for ${name}.`); }
    const cur = limit == null ? undefined : currencyOrError(currency); if (limit != null && !cur) return fail("Currency must be a 3-letter ISO code, e.g. USD.");
    const next = { category: name, limitMinor: limit == null ? undefined : toMinor(limit), currency: cur ?? undefined, color }; const old = state.categories.find((entry) => entry.category === name); if (old) Object.assign(old, next); else state.categories.push(next); await store.setFinanceState(userId, state); return text(`Saved category ${name}.`, { ...next, limit: limit });
  });

  server.registerTool("set_alert_thresholds", { title: "Set budget alert thresholds", description: "Set the percentage thresholds that trigger budget alerts.", inputSchema: TOOL_INPUTS.set_alert_thresholds, annotations: { title: "Set budget alert thresholds", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ thresholds }) => {
    const state = await store.getFinanceState(userId); state.alertThresholds = [...new Set(thresholds)].sort((a, b) => a - b); await store.setFinanceState(userId, state); return text(`Saved alert thresholds: ${state.alertThresholds.join("%, ")}%.`, { thresholds: state.alertThresholds });
  });

  server.registerTool("get_cash_flow_report", { title: "Get cash-flow report", description: "Report income, expenses, net cash flow, and savings rate for a month.", inputSchema: TOOL_INPUTS.get_cash_flow_report, annotations: { title: "Get cash-flow report", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ month }) => {
    const m = month ?? currentMonth(); if (!isValidMonth(m)) return fail(`Invalid month "${m}".`); const range = monthRange(m); const [expenses, state] = await Promise.all([store.listExpenses(userId, range), store.getFinanceState(userId)]);
    const income = state.incomes.filter((entry) => entry.date >= range.from && entry.date <= range.to); const currencies = new Set([...expenses.map((e) => e.currency), ...income.map((e) => e.currency)]); const result = [...currencies].sort().map((currency) => { const earned = income.filter((e) => e.currency === currency).reduce((sum, e) => sum + e.amountMinor, 0); const spent = expenses.filter((e) => e.currency === currency).reduce((sum, e) => sum + e.amountMinor, 0); return { currency, income: toMajor(earned), expenses: toMajor(spent), net: toMajor(earned - spent), savings_rate: earned ? Math.round(((earned - spent) / earned) * 1000) / 10 : null }; });
    const structured = { month: m, currencies: result }; return text(`Cash flow for ${m}.\n\n${jsonBlock(structured)}`, structured);
  });

  server.registerTool("get_spending_forecast", { title: "Get spending forecast", description: "Forecast month-end spending and remaining daily budget from spending so far.", inputSchema: TOOL_INPUTS.get_spending_forecast, annotations: { title: "Get spending forecast", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ month }) => {
    const m = month ?? currentMonth(); if (!isValidMonth(m)) return fail(`Invalid month "${m}".`); const range = monthRange(m); const [expenses, budgets] = await Promise.all([store.listExpenses(userId, range), store.listBudgets(userId)]); const elapsed = m === currentMonth() ? Math.max(1, Number(todayISO().slice(8, 10))) : daysInMonth(m); const result = Object.entries(totalsByCurrency(expenses)).map(([currency, spent]) => { const forecast = Math.round((spent / elapsed) * daysInMonth(m)); const overall = budgets.find((b) => b.category === null && b.currency === currency); return { currency, spent: toMajor(spent), forecast: toMajor(forecast), remaining_daily_budget: overall ? toMajor((overall.amountMinor - spent) / Math.max(1, daysInMonth(m) - elapsed)) : null }; }); const structured = { month: m, forecasts: result }; return text(`Spending forecast for ${m}.\n\n${jsonBlock(structured)}`, structured);
  });

  server.registerTool("compare_months", { title: "Compare monthly spending", description: "Compare expenses across recent months, with a trend chart data series.", inputSchema: TOOL_INPUTS.compare_months, annotations: { title: "Compare monthly spending", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ months, currency }) => {
    const cur = currency ? currencyOrError(currency) : null; if (currency && !cur) return fail("Currency must be a 3-letter ISO code, e.g. USD."); const series = [] as { month: string; totals: Record<string, number> }[];
    for (let offset = months - 1; offset >= 0; offset--) { const m = previousMonth(currentMonth(), offset); const entries = await store.listExpenses(userId, monthRange(m)); const totals = totalsByCurrency(cur ? entries.filter((e) => e.currency === cur) : entries); series.push({ month: m, totals: Object.fromEntries(Object.entries(totals).map(([code, minor]) => [code, toMajor(minor)])) }); }
    const structured = { months: series, chart: { type: "line", series } }; return { content: [{ type: "text", text: `Spending comparison for ${months} months.\n\n${jsonBlock(structured)}` }, svgImage(trendChartSvg(series))], structuredContent: structured };
  });

  server.registerTool("get_budget_alerts", { title: "Get budget alerts", description: "List configured threshold alerts and over-budget categories.", inputSchema: TOOL_INPUTS.get_budget_alerts, annotations: { title: "Get budget alerts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ month }) => {
    const m = month ?? currentMonth(); if (!isValidMonth(m)) return fail(`Invalid month "${m}".`); const [expenses, budgets, state] = await Promise.all([store.listExpenses(userId, monthRange(m)), store.listBudgets(userId), store.getFinanceState(userId)]); const alerts = budgets.flatMap((budget) => { const spent = expenses.filter((e) => e.currency === budget.currency && (budget.category === null || e.category === budget.category)).reduce((sum, e) => sum + e.amountMinor, 0); const percent = (spent / budget.amountMinor) * 100; return state.alertThresholds.filter((threshold) => percent >= threshold).map((threshold) => ({ scope: budget.category ?? "overall", currency: budget.currency, threshold, percent_used: Math.round(percent * 10) / 10, over_budget: spent > budget.amountMinor })); }); const structured = { month: m, alerts }; return text(alerts.length ? `Budget alerts for ${m}.\n\n${jsonBlock(structured)}` : `No budget alerts for ${m}.`, structured);
  });

  server.registerTool("find_duplicate_expenses", { title: "Find duplicate expenses", description: "Find likely duplicate expenses with the same date, category, amount, currency, and description.", inputSchema: TOOL_INPUTS.find_duplicate_expenses, annotations: { title: "Find duplicate expenses", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ from, to }) => {
    if ((from && !isValidDate(from)) || (to && !isValidDate(to)) || (from && to && from > to)) return fail("Use a valid chronological YYYY-MM-DD date range.");
    const expenses = await store.listExpenses(userId, { from, to, limit: 5000 }); const grouped = new Map<string, typeof expenses>();
    for (const expense of expenses) { const key = [expense.date, expense.amountMinor, expense.currency, expense.category, expense.description.trim().toLowerCase()].join("|"); const rows = grouped.get(key) ?? []; rows.push(expense); grouped.set(key, rows); }
    const duplicates = [...grouped.values()].filter((rows) => rows.length > 1).map((rows) => rows.map(view)); return text(duplicates.length ? `Found ${duplicates.length} likely duplicate group(s).\n\n${jsonBlock(duplicates)}` : "No likely duplicates found.", { duplicates });
  });

  server.registerTool("manage_budget_templates", { title: "Manage budget templates", description: "Save, apply, list, or delete reusable student, family, business, or custom budget templates.", inputSchema: TOOL_INPUTS.manage_budget_templates, annotations: { title: "Manage budget templates", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ action, name, template }) => {
    const state = await store.getFinanceState(userId); if (action === "list") return text(jsonBlock(state.templates), { templates: state.templates }); if (!name?.trim()) return fail("name is required."); const key = name.trim().toLowerCase();
    if (action === "delete") { state.templates = state.templates.filter((entry) => entry.name !== key); await store.setFinanceState(userId, state); return text(`Deleted template ${key}.`); }
    if (action === "save") { if (!template?.length) return fail("template rules are required to save."); const rules = template.map((rule) => ({ category: rule.category?.trim().toLowerCase() ?? null, amountMinor: toMinor(rule.amount), currency: currencyOrError(rule.currency) ?? DEFAULT_CURRENCY, period: rule.period, rollover: rule.rollover })); const existing = state.templates.find((entry) => entry.name === key); if (existing) existing.rules = rules; else state.templates.push({ name: key, rules }); await store.setFinanceState(userId, state); return text(`Saved template ${key}.`, { name: key, rules: template }); }
    const saved = state.templates.find((entry) => entry.name === key); if (!saved) return fail(`No template named ${key}.`); const created = await Promise.all(saved.rules.map((rule) => store.setBudget({ userId, category: rule.category, amountMinor: rule.amountMinor, currency: rule.currency }))); return text(`Applied template ${key}.`, { budgets: created.map((budget) => ({ scope: budget.category ?? "overall", amount: toMajor(budget.amountMinor), currency: budget.currency })) });
  });

  server.registerTool(
    "export_expenses",
    {
      title: "Export expenses",
      description: "Export expenses as CSV or JSON, with an optional date range.",
      inputSchema: TOOL_INPUTS.export_expenses,
      outputSchema: TOOL_OUTPUTS.export_expenses,
      annotations: {
        title: "Export expenses",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ format, from, to, limit, offset }) => {
      if (from && !isValidDate(from)) return fail(`Invalid "from" date: ${from}`);
      if (to && !isValidDate(to)) return fail(`Invalid "to" date: ${to}`);
      if (from && to && from > to) return fail('"from" must not be after "to".');

      const items = (await store.listExpenses(userId, { from, to, limit, offset })).map(view);
      if (items.length === 0) {
        return text("No expenses to export.", { format, count: 0 });
      }

      if (format === "pdf") {
        const pdf_base64 = reportPdfBase64("Money Copilot AI Export", items.map((item) => `${item.date} | ${item.category} | ${item.amount.toFixed(2)} ${item.currency} | ${item.description}`));
        const structured = { format, count: items.length, pdf_base64 };
        return text("Created a portable PDF expense report. The base64 payload can be saved as expenses-report.pdf.\n\n" + jsonBlock(structured), structured);
      }

      if (format === "json") {
        return text(jsonBlock(items), { format, count: items.length, expenses: items });
      }

      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const header = "id,date,category,description,amount,currency";
      const rows = items.map((e) =>
        [
          e.id,
          e.date,
          e.category,
          esc(e.description),
          e.amount.toFixed(2),
          e.currency,
        ].join(","),
      );
      const csv = [header, ...rows].join("\n");
      return text("```csv\n" + csv + "\n```", { format, count: items.length, csv });
    },
  );

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  server.registerResource(
    "recent-expenses",
    "expense://recent",
    {
      title: "Recent expenses",
      description: "The 20 most recent expenses for the current user (JSON).",
      mimeType: "application/json",
    },
    async (uri) => {
      const items = await store.listExpenses(userId, { limit: 20 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(items.map(view), null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "current-month-summary",
    "expense://summary/current-month",
    {
      title: "Current month summary",
      description: "This month's spending grouped by category (JSON).",
      mimeType: "application/json",
    },
    async (uri) => {
      const m = currentMonth();
      // Month-scoped at the store level (indexed) — no full-table fetch.
      const items = await store.listExpenses(userId, {
        from: `${m}-01`,
        to: `${m}-31`,
      });
      const byCat: Record<string, Record<string, number>> = {};
      for (const e of items) {
        byCat[e.category] ??= {};
        byCat[e.category][e.currency] =
          (byCat[e.category][e.currency] ?? 0) + e.amountMinor;
      }
      const summary = {
        month: m,
        count: items.length,
        by_category: Object.fromEntries(
          Object.entries(byCat).map(([cat, totals]) => [
            cat,
            Object.fromEntries(
              Object.entries(totals).map(([c, minor]) => [c, toMajor(minor)]),
            ),
          ]),
        ),
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  server.registerPrompt(
    "monthly_report",
    {
      title: "Monthly spending report",
      description:
        "Generate a spending report for a month with category breakdown and " +
        "budget analysis.",
      argsSchema: {
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("Month YYYY-MM; defaults to current month"),
      },
    },
    ({ month }) => {
      const m = month ?? currentMonth();
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Produce a spending report for ${m}.\n` +
                `1. Call full_budget_report for ${m}; it includes attached charts.\n` +
                `Then write a concise report: total spend, top 3 categories, any ` +
                `over-budget categories, and 2-3 concrete savings suggestions.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "budget_review",
    {
      title: "Budget review",
      description: "Review current budgets against spending and suggest adjustments.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Call get_budget_status for the current month, then assess whether " +
              "my budgets are realistic given recent spending (use " +
              "summarize_expenses and list_categories). Recommend specific budget " +
              "increases or decreases and flag categories with no budget set.",
          },
        },
      ],
    }),
  );

  server.registerPrompt("monthly_financial_review", { title: "Monthly financial review", description: "Review full cash flow, budgets, forecast, and alerts for a month.", argsSchema: { month: z.string().regex(/^\d{4}-\d{2}$/).optional() } }, ({ month }) => ({ messages: [{ role: "user", content: { type: "text", text: `For ${month ?? currentMonth()}, call full_budget_report, get_cash_flow_report, get_spending_forecast, and get_budget_alerts. Summarize performance, risks, and the three best next actions.` } }] }));

  server.registerPrompt("savings_plan", { title: "Savings plan", description: "Create a realistic savings plan from income, spending, and forecasts.", argsSchema: {} }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Call get_cash_flow_report, get_spending_forecast, compare_months, and full_budget_report. Propose a concrete monthly savings target and category-level cuts without assuming currencies can be combined." } }] }));

  server.registerPrompt("subscription_audit", { title: "Subscription audit", description: "Audit recurring subscriptions and identify reduction opportunities.", argsSchema: {} }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Review recurring expenses and recent expense categories. Identify subscription-like charges, duplicates, and unused recurring costs; recommend which to cancel or renegotiate." } }] }));

  return server;
}
