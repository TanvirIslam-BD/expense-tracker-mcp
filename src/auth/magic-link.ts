import { randomInt } from "node:crypto";

interface PendingLogin {
  email: string;
  code: string;
  expiresAt: number;
}

const CODE_TTL_MS = 10 * 60 * 1000;

/** One entry per in-flight OAuth interaction (uid -> pending email code).
 * In-memory and short-lived by design; does not need to survive a restart. */
const pendingLogins = new Map<string, PendingLogin>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [uid, entry] of pendingLogins) {
    if (entry.expiresAt < now) pendingLogins.delete(uid);
  }
}

export function issueLoginCode(uid: string, email: string): string {
  sweepExpired();
  const code = String(randomInt(100000, 1000000));
  pendingLogins.set(uid, { email: email.trim().toLowerCase(), code, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/** Single-use: a correct verification consumes the code so it can't be replayed. */
export function verifyLoginCode(uid: string, code: string): string | null {
  const entry = pendingLogins.get(uid);
  if (!entry || entry.expiresAt < Date.now() || entry.code !== code.trim()) return null;
  pendingLogins.delete(uid);
  return entry.email;
}

/**
 * Sends the magic-link email via Resend, reusing the same provider as
 * budget-limit alerts (server.ts). Falls back to logging the link when
 * RESEND_API_KEY/BUDGET_ALERT_EMAIL_FROM aren't configured, so the sign-in
 * flow is still testable in local/dev without an email provider.
 */
export async function sendLoginCodeEmail(email: string, uid: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.BUDGET_ALERT_EMAIL_FROM;
  const verifyUrl = `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/oauth/interaction/${uid}/verify?code=${code}`;

  if (!apiKey || !from) {
    console.error(
      `[oidc] RESEND_API_KEY/BUDGET_ALERT_EMAIL_FROM not configured — login code for ${email}: ${code}` +
        (verifyUrl.startsWith("http") ? ` (or open: ${verifyUrl})` : ""),
    );
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "expense-tracker-mcp/1.0" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your Expense Tracker sign-in code",
      text: `Your sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`email provider responded ${response.status}: ${body.slice(0, 300)}`);
  }
}
