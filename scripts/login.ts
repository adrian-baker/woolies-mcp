/**
 * Signs in to Woolworths in a real browser window and hands the session to the server.
 *
 * Why a browser rather than an HTTP POST: Auth0 serves a Cloudflare Turnstile challenge to
 * clients that do not look like browsers. A real browser is not challenged at all — the captured
 * browser sign-in posted `state`, `username` and `password` with no captcha field — so signing in
 * as a person is both the legitimate path and the frictionless one. Nothing here reads, stores or
 * transmits the password: it is typed (or filled by a password manager) into the real login page.
 *
 * Usage:  npm run login -- [--server http://host:port/mcp/<token>]
 * Without --server the cookies are written to session.json for a local stdio server to load.
 */

import { writeFile } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";

const START = "https://www.woolworths.co.nz/api/v1.0/bff/initiate-oidc-signin";
const SITE = "https://www.woolworths.co.nz";
const SIGNED_IN_CHECK = `${SITE}/api/v1/bff/get-user`;
const SESSION_FILE = "session.json";
const WAIT_FOR_SIGN_IN_MS = 5 * 60 * 1000;

interface ExportedCookie {
  readonly setCookie: string;
  readonly url: string;
}

async function main(): Promise<void> {
  const server = argValue("--server");

  console.log("Opening a browser window at the Woolworths sign-in page.");
  console.log("Sign in as you normally would — password manager, Touch ID, and any challenge the");
  console.log("page shows are all yours to complete. This script only waits and then captures the");
  console.log("resulting session; it never sees your password.\n");

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ locale: "en-NZ" });
  const page = await context.newPage();

  const returnTo = Buffer.from(`${SITE}/`).toString("base64");
  await page.goto(`${START}?redirectUrl=${encodeURIComponent(returnTo)}`);

  const signedIn = await waitForSignIn(context);
  if (!signedIn) {
    await browser.close();
    fail("Timed out waiting for sign-in. Nothing was captured.");
  }

  const cookies = await exportCookies(context);
  await browser.close();

  // Saved before the handover, always: a server-side failure must never cost another sign-in.
  await writeFile(SESSION_FILE, JSON.stringify({ cookies }, null, 2), { mode: 0o600 });
  console.log(`\nSigned in. Captured ${cookies.length} cookies, saved to ${SESSION_FILE}.`);

  if (server === undefined) {
    console.log("No --server given, so the session was only saved locally.");
    return;
  }

  await handOver(server, cookies);
}

/** Polls the site's own signed-in check, which is what the server will use too. */
async function waitForSignIn(context: BrowserContext): Promise<boolean> {
  const deadline = Date.now() + WAIT_FOR_SIGN_IN_MS;
  process.stdout.write("Waiting for sign-in");
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    process.stdout.write(".");
    const response = await context.request
      .get(SIGNED_IN_CHECK, { headers: { accept: "application/json" }, failOnStatusCode: false })
      .catch(() => undefined);
    if (!response?.ok()) continue;
    const body: unknown = await response.json().catch(() => undefined);
    if (isSignedIn(body)) {
      process.stdout.write("\n");
      return true;
    }
  }
  process.stdout.write("\n");
  return false;
}

function isSignedIn(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  // The BFF reports the shopper once the session is real; anonymous sessions have no email.
  const candidates = [record["email"], record["userId"], record["firstName"]];
  return candidates.some((value) => typeof value === "string" && value.length > 0);
}

/** Renders Playwright's cookies as Set-Cookie strings the server's jar can absorb. */
async function exportCookies(context: BrowserContext): Promise<ExportedCookie[]> {
  const cookies = await context.cookies();
  return cookies
    .filter((cookie) => cookie.domain.includes("woolworths.co.nz"))
    .map((cookie) => {
      const host = cookie.domain.replace(/^\./, "");
      const attributes = [
        `${cookie.name}=${cookie.value}`,
        `Domain=${cookie.domain}`,
        `Path=${cookie.path}`,
      ];
      if (cookie.expires > 0) {
        attributes.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
      }
      if (cookie.httpOnly) attributes.push("HttpOnly");
      if (cookie.secure) attributes.push("Secure");
      return { setCookie: attributes.join("; "), url: `https://${host}${cookie.path}` };
    });
}

async function handOver(server: string, cookies: readonly ExportedCookie[]): Promise<void> {
  const target = new URL(server);
  target.pathname = `${target.pathname.replace(/\/$/, "")}/session`;

  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookies }),
  });
  if (!response.ok) {
    fail(`Handing the session to ${target.origin} failed with HTTP ${response.status}.`);
  }
  const result: unknown = await response.json().catch(() => ({}));
  console.log(`Server accepted the session: ${JSON.stringify(result)}`);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

await main();
