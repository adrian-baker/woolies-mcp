/**
 * Proves what a caller is told when a signed-in session dies mid-use.
 *
 * The bug this guards: a confirmed sign-in is cached briefly so a burst of writes costs one proof
 * rather than one per write, and a session that dies inside that window used to surface the
 * upstream error rather than the handover.
 *
 * On `/api/graphql` a dead session does not fail at all: the site serves an empty guest cart at
 * HTTP 200 with no error. So a death mid-window must report the sign-in handover, never an empty
 * cart, and must not leave a cached identity a later write could be attempted against.
 *
 * Driven by a scripted transport, because reproducing this against the real site needs a live
 * session to kill and a browser to make another.
 *
 * Run with `npm run check:session-death`.
 */
import { NotSignedInError } from "../src/woolworths/auth.js";
import { GraphQlCart } from "../src/woolworths/graphql-cart.js";
import { DyingGraphQlTransport, SIGNED_IN_CART_KEY } from "./cart-fixtures.js";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

console.log("a dead session answers HTTP 200 with a guest cart");
const transport = new DyingGraphQlTransport();
// A minute's TTL, so the death lands inside the window the cache would otherwise trust.
const cart = new GraphQlCart(transport, 60_000);

const alive = await cart.read();
check(
  "the first read establishes the signed-in cart",
  alive.cart.lineCount === 0 && alive.customerId === SIGNED_IN_CART_KEY,
  alive.customerId,
);

const afterDeath: unknown = await cart.read().then(
  () => undefined,
  (error: unknown) => error,
);
check(
  "a cart served to a guest is refused, not returned as empty",
  afterDeath instanceof NotSignedInError,
  afterDeath instanceof Error ? afterDeath.name : String(afterDeath),
);
check(
  "the refusal says what to do",
  afterDeath instanceof Error && afterDeath.message.includes("npm run login"),
  afterDeath instanceof Error ? `${afterDeath.message.slice(0, 54)}...` : "(none)",
);

const writesBefore = transport.writes;
const write: unknown = await cart.setQuantity("245902", 1, "EACH").then(
  () => undefined,
  (error: unknown) => error,
);
check(
  "a write after the death is refused too",
  write instanceof NotSignedInError,
  write instanceof Error ? write.name : String(write),
);
check(
  "the identity was dropped, so no write was attempted against the dead session's cart",
  transport.writes === writesBefore,
  `${transport.writes - writesBefore} writes attempted`,
);

console.log(
  failures.length === 0 ? "\nSession-death check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
