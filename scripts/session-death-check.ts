/**
 * Proves what a caller is told when a signed-in session dies mid-use.
 *
 * The bug this guards: `requireSignedIn` caches a confirmed sign-in for a minute, so a session
 * that dies inside that window skips the live check, hits a 401, and used to surface Woolworths'
 * "Ooops looks like you cant perform that action". The fast path is exactly the path a mid-use
 * death takes, so that was the message most callers saw.
 *
 * Driven by a client that reports a signed-in shell and then 401s, because reproducing this
 * against the real site needs a live session to kill and a browser to make another.
 *
 * Run with `npm run check:session-death`.
 */
import { WoolworthsApi } from "../src/woolworths/api.js";
import { WoolworthsApiError, WoolworthsClient } from "../src/woolworths/client.js";
import { Authenticator, NotSignedInError } from "../src/woolworths/auth.js";
import { Session } from "../src/woolworths/session.js";

const SIGNED_IN_SHELL = {
  context: {
    shopper: { firstName: "Test", isLoggedIn: true, hasOnecard: false, orderCount: "0" },
  },
};

const UPSTREAM_401 = `{"message":"Ooops looks like you cant perform that action"}`;

/** Signed in according to /shell, 401 on every account endpoint: a session that has just died. */
class DeadSessionClient extends WoolworthsClient {
  public shellReads = 0;

  constructor() {
    super(new Session(), {});
  }

  override get(path: string): Promise<unknown> {
    if (path === "shell") {
      this.shellReads += 1;
      return Promise.resolve(SIGNED_IN_SHELL);
    }
    return Promise.reject(this.unauthorized(path));
  }

  override post(path: string): Promise<unknown> {
    return Promise.reject(this.unauthorized(path));
  }

  private unauthorized(path: string): WoolworthsApiError {
    return new WoolworthsApiError(
      `/api/v1/${path} returned HTTP 401: ${UPSTREAM_401}`,
      401,
      `https://www.woolworths.co.nz/api/v1/${path}`,
    );
  }
}

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const client = new DeadSessionClient();
const api = new WoolworthsApi(client, new Authenticator());

// Warm the cache the way a real burst does: one confirmed sign-in, then account calls.
await api.requireSignedIn();
check("cache warmed by a live check", client.shellReads === 1, `${client.shellReads} shell read`);

const caught: unknown = await api.getCart().then(
  () => undefined,
  (error: unknown) => error,
);

check(
  "caller is told to sign in, not shown the upstream error",
  caught instanceof NotSignedInError,
  caught instanceof Error ? caught.name : String(caught),
);
check(
  "message says what to do",
  caught instanceof Error && caught.message.includes("npm run login"),
  caught instanceof Error ? `${caught.message.slice(0, 54)}...` : "(none)",
);
check(
  "upstream 401 kept as the cause",
  caught instanceof Error &&
    caught.cause instanceof WoolworthsApiError &&
    caught.cause.status === 401,
  caught instanceof Error && caught.cause instanceof WoolworthsApiError
    ? `HTTP ${caught.cause.status}`
    : "(no cause)",
);
check(
  "raw upstream wording never reaches the caller",
  caught instanceof Error && !caught.message.includes("Ooops"),
  caught instanceof Error && caught.message.includes("Ooops") ? "leaked" : "not present",
);

// The 401 must drop the cache, so the next call re-checks instead of trusting the window.
await api.getCart().catch(() => undefined);
check(
  "401 invalidated the cache",
  client.shellReads === 2,
  `${client.shellReads} shell reads after two account calls`,
);

console.log(
  failures.length === 0 ? "\nSession-death check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
