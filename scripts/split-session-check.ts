/**
 * Guards the state where `/shell` still reports a signed-in shopper while account endpoints 401.
 *
 * Reported live: auth_status said signedIn/accountToolsUsable true with a reassuring hint, and
 * get_cart on the same server at the same moment said not signed in. auth_status was reading
 * `/shell`, which is a proxy for account access rather than account access itself.
 *
 * Run with `npm run check:split-session`.
 */
import { WoolworthsApi } from "../src/woolworths/api.js";
import { WoolworthsApiError, WoolworthsClient } from "../src/woolworths/client.js";
import { Authenticator, NotSignedInError } from "../src/woolworths/auth.js";
import { Session } from "../src/woolworths/session.js";

const SHELL_SAYS_SIGNED_IN = {
  context: {
    shopper: { firstName: "Test", isLoggedIn: true, hasOnecard: false, orderCount: "0" },
  },
};

/** `/shell` is happy, every account endpoint is not: the split state as reported. */
class SplitSessionClient extends WoolworthsClient {
  constructor() {
    super(new Session(), {});
  }

  override get(path: string): Promise<unknown> {
    if (path === "shell") return Promise.resolve(SHELL_SAYS_SIGNED_IN);
    return Promise.reject(
      new WoolworthsApiError(
        `/api/v1/${path} returned HTTP 401`,
        401,
        `https://www.woolworths.co.nz/api/v1/${path}`,
      ),
    );
  }
}

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const api = new WoolworthsApi(new SplitSessionClient(), new Authenticator());

const access = await api.checkAccountAccess();
check("account access is reported unusable", !access.usable, String(access.usable));
check(
  "the shell's claim is kept, not discarded",
  access.shellReportsSignedIn,
  String(access.shellReportsSignedIn),
);
check(
  "the disagreement is visible rather than flattened",
  access.usable !== access.shellReportsSignedIn,
  `usable=${access.usable} shellReportsSignedIn=${access.shellReportsSignedIn}`,
);

// The whole bug: the status tool and the cart tool must give the same answer.
const cartFailed = await api.getCart().then(
  () => false,
  (error: unknown) => error instanceof NotSignedInError,
);
check("get_cart reports not signed in", cartFailed, cartFailed ? "NotSignedInError" : "unexpected");
check(
  "status and cart agree",
  !access.usable && cartFailed,
  `accountToolsUsable=${access.usable}, get_cart usable=${!cartFailed}`,
);

console.log(
  failures.length === 0 ? "\nSplit-session check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
