import type { Express, Request, Response } from "express";
import type Provider from "oidc-provider";
import { deriveOAuthUserId } from "./oidc-provider.js";
import { issueLoginCode, sendLoginCodeEmail, verifyLoginCode } from "./magic-link.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function loginFormHtml(uid: string, message?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in — Expense Tracker</title>
    <style>body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 20px;color:#122247}
    input{font:inherit;width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;margin:8px 0;box-sizing:border-box}
    button{font:inherit;font-weight:700;padding:10px 16px;border:0;border-radius:8px;background:#2867f2;color:#fff;cursor:pointer}
    .msg{padding:10px;border-radius:8px;background:#eef4ff;margin-bottom:16px;font-size:14px}</style>
    </head><body><h1>Sign in</h1>
    ${message ? `<p class="msg">${escapeHtml(message)}</p>` : ""}
    <form method="post" action="/oauth/interaction/${escapeHtml(uid)}/login">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" required autofocus placeholder="you@example.com">
      <button type="submit">Send sign-in code</button>
    </form>
    <form method="get" action="/oauth/interaction/${escapeHtml(uid)}/verify" style="margin-top:20px">
      <label for="code">Already have a code?</label>
      <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" placeholder="123456">
      <button type="submit">Verify code</button>
    </form>
    </body></html>`;
}

/** Mounts the login/verify views for the OAuth authorization server's
 * "login" interaction prompt, plus auto-grants the "consent" prompt for the
 * single first-party client — see oidc-provider.ts for why. */
export function mountOidcInteractions(app: Express, provider: Provider): void {
  app.get("/oauth/interaction/:uid", async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name === "login") {
        res.type("html").send(loginFormHtml(details.uid));
        return;
      }
      // Only the "consent" prompt remains, and there is exactly one
      // registered client (Anthropic's) whose own consent screen already
      // gated this connection before the user arrived here.
      const result = { consent: {} };
      await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true });
    } catch (error) {
      console.error("[oidc] interaction lookup failed:", error);
      res.status(400).type("html").send("<h1>Sign-in link expired</h1><p>Please try connecting again.</p>");
    }
  });

  app.post("/oauth/interaction/:uid/login", async (req: Request, res: Response) => {
    const uid = req.params.uid;
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email || !email.includes("@")) {
      res.type("html").send(loginFormHtml(uid, "Enter a valid email address."));
      return;
    }
    try {
      const code = issueLoginCode(uid, email);
      await sendLoginCodeEmail(email, uid, code);
      res.type("html").send(loginFormHtml(uid, `We sent a 6-digit code to ${email}. Enter it below, or use the link in the email.`));
    } catch (error) {
      console.error("[oidc] failed to send login code:", error);
      res.type("html").send(loginFormHtml(uid, "Could not send the sign-in email. Please try again shortly."));
    }
  });

  app.get("/oauth/interaction/:uid/verify", async (req: Request, res: Response) => {
    const uid = req.params.uid;
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const email = verifyLoginCode(uid, code);
    if (!email) {
      res.type("html").send(loginFormHtml(uid, "That code is invalid or has expired. Request a new one."));
      return;
    }
    const accountId = deriveOAuthUserId(email);
    const result = { login: { accountId } };
    await provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true });
  });
}
