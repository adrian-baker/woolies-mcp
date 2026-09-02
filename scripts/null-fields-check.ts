/**
 * Guards the wordings that must never turn a null into an invented value.
 *
 * Both cases were reported by users of the public repo against payloads neither of us had: a
 * trolley holding no specials, and a removal that changes nothing. The cart itself has since moved
 * to `/api/graphql`, and the shape half of these guards moved with it into
 * `check:graphql-cart` — a fee the site has not determined must stay absent rather than become
 * $0.00. What remains here is the wording that describes a write: a removal must not report a
 * change it did not make, and an add that produced no line must still be reported.
 *
 * Run with `npm run check:null-fields`.
 */
import { toCartAdjustment } from "../src/woolworths/mappers.js";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

console.log("a removal that changes nothing");
// A removal on a Kg line: the site reports no purchasing unit, which must not read as a change.
const removalAdjustment = toCartAdjustment(0, 0, "KG", "KG", undefined);
check(
  "removing a weight-priced line reports no adjustment",
  !removalAdjustment.adjusted,
  removalAdjustment.note ?? "(none)",
);

// The earlier bug, still guarded: a removal must not report a unit change it did not make.
const removalUnitMismatch = toCartAdjustment(0, 0, "EACH", "KG", undefined);
check(
  "a removal never reports a unit adjustment",
  !removalUnitMismatch.adjusted,
  removalUnitMismatch.note ?? "(none)",
);

// A request that asked for stock and got no line is a real surprise and must still be reported.
const addedNothing = toCartAdjustment(2, 0, "EACH", "EACH", undefined);
check(
  "an add that produced no line is still reported",
  addedNothing.adjusted,
  addedNothing.note?.slice(0, 58) ?? "(none)",
);

console.log(
  failures.length === 0 ? "\nNull-field check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
