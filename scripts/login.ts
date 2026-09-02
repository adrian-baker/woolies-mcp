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
import { browserFetch } from "./browser-fetch.js";
import { NotSignedInError } from "../src/woolworths/auth.js";
import {
  FetchGraphQlTransport,
  SessionGraphQlTransport,
} from "../src/woolworths/graphql-client.js";
import {
  CART_READ_DOCUMENT,
  CART_READ_OPERATION,
  IDENTITY_DOCUMENT,
  IDENTITY_OPERATION,
} from "../src/woolworths/graphql-documents.js";
import { cartReadResponseSchema } from "../src/woolworths/schemas.js";
import { Session, SITE_ORIGIN } from "../src/woolworths/session.js";
import { Throttle } from "../src/woolworths/throttle.js";

/**
 * Where the browser is pointed to start OIDC. A page to navigate to, not an API this server
 * integrates with: nothing reads its response, and the sign-in that follows happens entirely in
 * the browser. It is the site's own entry point and has no `/api/graphql` equivalent.
 */
const START = "https://www.woolworths.co.nz/api/v1.0/bff/initiate-oidc-signin";
const SITE = "https://www.woolworths.co.nz";
const SESSION_FILE = "session.json";
/** A Next.js route; loading one is what mints the cookies `/api/graphql` authenticates on. */
const NEXT_PAGE = "/cart";
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

  const usable = await verifyCapture(cookies);

  if (server === undefined) {
    console.log("No --server given, so the session was only saved locally.");
  } else {
    await handOver(server, cookies);
  }

  if (!usable) {
    fail("The captured session does not work. Nothing downstream will, either.");
  }
}

/**
 * Waits for the browser to finish signing in.
 *
 * `me` on `/api/graphql` is the signal, and the only one. The legacy `bff/get-user` was polled
 * alongside it until it reported `isLoggedIn: false` in the same poll that `me` returned a
 * customer id — it answers for a session the site's migration left behind, so it can only ever
 * disagree or agree by luck.
 *
 * Only a signal the site states plainly counts as "not yet". Anything it cannot answer —
 * unreachable, an HTTP error, an unrecognised payload, an unexpected GraphQL error — throws.
 * Returning false there is how this script waited out five minutes on a sign-in that had already
 * succeeded, and reported a broken signal as a shopper who never signed in.
 */
async function waitForSignIn(context: BrowserContext): Promise<boolean> {
  const deadline = Date.now() + WAIT_FOR_SIGN_IN_MS;
  let lastDetail = "(nothing observed yet)";
  let polls = 0;

  console.log("Waiting for sign-in. What the site reports, every 20 seconds:");
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const graph = await readGraphQlMe(context);
    lastDetail = `graphql me: ${graph.detail}`;
    // Every tenth poll, so the output is readable but never silent for long.
    if (polls % 10 === 0) console.log(`  ${lastDetail}`);
    polls += 1;

    if (graph.signedIn) {
      console.log(`  ${lastDetail}`);
      return true;
    }
  }
  console.error(`\nGave up waiting. The last thing the site said was:\n  ${lastDetail}`);
  return false;
}

/** A signal the site stated plainly: signed in, or anonymous. Anything else throws. */
interface SignInSignal {
  readonly signedIn: boolean;
  readonly detail: string;
}

/**
 * The signal that matters: `me` is banned for guests, so resolving it proves the browser holds a
 * real account session. It is the same field the cart tools are guarded by, sent through the same
 * client — so an `errors` array becomes an exception here exactly as it does in the server.
 *
 * The Next.js session is minted first. `/api/graphql` authenticates on `__session__0` /
 * `__session__1`, which only a Next.js page sets; a browser signed in on the old storefront has
 * never been issued them, and asking before the exchange reports a signed-in shopper as a guest.
 */
async function readGraphQlMe(context: BrowserContext): Promise<SignInSignal> {
  await mintNextSession(context);

  const transport = new FetchGraphQlTransport(browserFetch(context));
  try {
    const data = await transport.send(IDENTITY_OPERATION, IDENTITY_DOCUMENT, {});
    const id = data.me?.id;
    if (typeof id === "string" && id.length > 0) return { signedIn: true, detail: `me.id ${id}` };
    // No errors and no id: the operation resolved to something this script does not understand.
    throw new Error(`/api/graphql resolved ${IDENTITY_OPERATION} with no me.id.`);
  } catch (error: unknown) {
    // The site refusing `me` to an anonymous caller is the plainly stated "not signed in".
    if (error instanceof NotSignedInError) {
      return { signedIn: false, detail: "guest — the site refuses `me` to anonymous callers" };
    }
    throw error;
  }
}

/**
 * Loads a Next.js page so the site exchanges the sign-in cookies for `__session__0` /
 * `__session__1`. Re-run on every poll: before sign-in the exchange yields a guest session, and
 * the authenticated pair is only issued once the sign-in has actually happened.
 */
async function mintNextSession(context: BrowserContext): Promise<void> {
  const response = await context.request.get(`${SITE_ORIGIN}${NEXT_PAGE}`, {
    headers: { accept: "text/html" },
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(
      `${NEXT_PAGE} answered HTTP ${response.status()}, so no GraphQL session was minted.`,
    );
  }
}

/**
 * Proves the captured cookies actually work, by making the call the tools make.
 *
 * One check, because there is one API: everything this server does goes through
 * `/api/graphql`, and a cart read is the call that also proves the site is not answering as a
 * guest. There is no second half left to disagree with it.
 */
async function verifyCapture(cookies: readonly ExportedCookie[]): Promise<boolean> {
  console.log("\nChecking the captured session against the site.");
  const session = new Session();
  await session.bootstrap();
  await session.importCookies(cookies);

  const result = await readCart(session);
  console.log(`  cart (/api/graphql):  ${result}`);
  return result.startsWith("OK");
}

/**
 * `customerCart` answers an unauthenticated caller with an empty guest cart at HTTP 200, so the
 * read selects `me` and this reports what that proved rather than that a request succeeded.
 */
async function readCart(session: Session): Promise<string> {
  try {
    const transport = new SessionGraphQlTransport(session, new Throttle(1_000));
    const data = await transport.send(CART_READ_OPERATION, CART_READ_DOCUMENT, {});
    const parsed = cartReadResponseSchema.parse(data);
    if (parsed.me === null) return "NOT SIGNED IN — the site served a guest cart.";
    const cart = parsed.customerCart;
    return `OK — ${cart.lineItems.length} lines, ${cart.totalItemQuantity} items.`;
  } catch (error: unknown) {
    if (error instanceof NotSignedInError) return "NOT SIGNED IN — the site served a guest cart.";
    return `FAILED — ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
  }
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
