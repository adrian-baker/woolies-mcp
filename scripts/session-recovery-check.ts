/**
 * Guards the two ways a live request can destroy a sign-in.
 *
 * A rejected request must not cost the jar: the authenticated `cw-*` cookies are the sign-in and
 * nothing reloads them, so clearing them on a 400 or 403 signs the shopper out permanently.
 * A 307 or 308 must keep the method, body and `x-requested-with`; reissued as a bare GET the
 * site answers 400, which is the first fault again.
 *
 * Driven against a stubbed fetch, so this runs offline. The URLs are `/api/graphql`, the only
 * endpoint the server calls.
 *
 * Run with `npm run check:session-recovery`.
 */
import { Session } from "../src/woolworths/session.js";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly requestedWith: string | null;
  readonly body: string | null;
}

const realFetch = globalThis.fetch;
const seen: Seen[] = [];

/** Answers the bootstrap, and redirects the first API call once with the given status. */
function stubFetch(redirectStatus: number | undefined): typeof globalThis.fetch {
  let redirected = false;
  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      method: init?.method ?? "GET",
      requestedWith: headers.get("x-requested-with"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (redirectStatus !== undefined && url.includes("/api/graphql") && !redirected) {
      redirected = true;
      return Promise.resolve(
        new Response(null, {
          status: redirectStatus,
          headers: { location: "https://www.woolworths.co.nz/api/graphql?moved=1" },
        }),
      );
    }
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "set-cookie": "ak_bmsc=fresh; Path=/" } }),
    );
  };
}

// --- A rejection must not cost the sign-in ---------------------------------------------------
const session = new Session();
await session.importCookies([
  {
    setCookie: "cw-lrkswrdjp=signed-in; Path=/; Expires=Wed, 09 Sep 2026 08:00:00 GMT",
    url: "https://www.woolworths.co.nz/",
  },
]);
check(
  "the session starts signed in",
  (await session.cookieExpiry()) !== undefined,
  String(await session.cookieExpiry()),
);

globalThis.fetch = stubFetch(undefined);
await session.refreshBootstrap();
globalThis.fetch = realFetch;

const survived = (await session.cookieExpiry()) !== undefined;
check("recovering from a rejection keeps the sign-in", survived, survived ? "kept" : "DESTROYED");

// --- 307 and 308 must carry the method, body and headers -------------------------------------
for (const status of [307, 308]) {
  seen.length = 0;
  const redirecting = new Session();
  globalThis.fetch = stubFetch(status);
  await redirecting.fetch(new URL("https://www.woolworths.co.nz/api/graphql"), {
    method: "POST",
    body: JSON.stringify({ query: "query CustomerCart { me { id } }" }),
    headers: { "x-requested-with": "OnlineShopping.WebApp" },
  });
  globalThis.fetch = realFetch;

  const followed = seen[1];
  check(
    `${status} keeps the method`,
    followed?.method === "POST",
    followed?.method ?? "(no second hop)",
  );
  check(`${status} keeps the body`, followed?.body !== null, followed?.body ?? "(dropped)");
  check(
    `${status} keeps x-requested-with`,
    followed?.requestedWith === "OnlineShopping.WebApp",
    followed?.requestedWith ?? "(dropped)",
  );
}

// --- 302 still downgrades to GET, as browsers do ----------------------------------------------
seen.length = 0;
const seeOther = new Session();
globalThis.fetch = stubFetch(302);
await seeOther.fetch(new URL("https://www.woolworths.co.nz/api/graphql"), {
  method: "POST",
  body: "x",
});
globalThis.fetch = realFetch;
check("302 still becomes a GET", seen[1]?.method === "GET", seen[1]?.method ?? "(no second hop)");

console.log(
  failures.length === 0 ? "\nSession-recovery check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
