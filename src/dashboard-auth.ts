import { createHmac, timingSafeEqual } from "node:crypto";

type DashboardSession = { u: string; e: number };

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createDashboardSessionToken(userId: string, secret: string, ttlMs = 15 * 60 * 1000): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + ttlMs } satisfies DashboardSession)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyDashboardSessionToken(token: string | undefined, secret: string | undefined): string | null {
  if (!token || !secret) return null;
  const [payload, receivedSignature, ...extra] = token.split(".");
  if (!payload || !receivedSignature || extra.length) return null;
  const expectedSignature = signature(payload, secret);
  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(expectedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DashboardSession;
    return typeof session.u === "string" && session.u.length > 0 && Number.isFinite(session.e) && session.e > Date.now()
      ? session.u
      : null;
  } catch {
    return null;
  }
}
