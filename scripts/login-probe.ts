/**
 * Verifies the *unauthenticated* half of the sign-in chain: that the BFF entry point still hands
 * over an authorize URL, that following it lands on the Auth0 credential form, and that the
 * `state` this server would post back parses out of that page.
 *
 * Uses NO credentials and submits nothing, so it is safe to run any time. It is the check that
 * catches an upstream login change before a real attempt is spent on it.
 *
 * Run with `npm run check:login`.
 */
import { LOGIN_CHAIN_REDIRECTS, SITE_ORIGIN, Session } from "../src/woolworths/session.js";

const session = new Session();
await session.bootstrap();

const start = new URL(`${SITE_ORIGIN}/api/v1.0/bff/initiate-oidc-signin`);
start.searchParams.set("redirectUrl", Buffer.from(`${SITE_ORIGIN}/`).toString("base64"));

const response = await session.fetch(
  start,
  { headers: { accept: "text/html,application/xhtml+xml" } },
  LOGIN_CHAIN_REDIRECTS,
);
const html = await response.text();
const landed = new URL(response.url);
const state = /<input[^>]*name=["']state["'][^>]*value=["']([^"']*)["']/i.exec(html)?.[1];
const hasUsername = /name=["']username["']/i.test(html);

const checks: [string, boolean, string][] = [
  ["entry point reachable", response.ok, `HTTP ${response.status}`],
  ["landed on the Auth0 credential UI", landed.origin === "https://auth.woolworths.co.nz", landed.origin + landed.pathname],
  ["state parses out of the page", state !== undefined && state.length > 0, state === undefined ? "(absent)" : `${state.length} chars`],
  ["username field present", hasUsername, hasUsername ? "yes" : "no"],
];

let failed = 0;
for (const [name, passed, detail] of checks) {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!passed) failed += 1;
}
console.log(failed === 0 ? "\nLogin chain reachable (no credentials used)." : `\nFAILED: ${failed} check(s)`);
process.exitCode = failed === 0 ? 0 : 1;
