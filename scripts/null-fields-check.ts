/**
 * Guards the two shapes where the site sends null and an earlier schema demanded a value.
 *
 * Both were reported by users of the public repo against payloads neither of us had: a trolley
 * holding no specials, and a removal that changes nothing. The checks below assert the parse
 * succeeds AND that the null never becomes an invented value — absent savings must not read as
 * $0.00, and an unreported trolley total must not read as an empty trolley.
 *
 * Run with `npm run check:null-fields`.
 */
import { toCartAdjustment, toCartTotals } from "../src/woolworths/mappers.js";
import { basketTotalsSchema, trolleyWriteResponseSchema } from "../src/woolworths/schemas.js";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

console.log("a trolley holding no specials");
const noSavings = basketTotalsSchema.safeParse({
  subtotal: "$12.00",
  savings: null,
  deliveryFees: "$14.00",
  bagFees: "$1.50",
  totalIncludingDeliveryFees: "$27.50",
  totalItems: 1,
  totalItemQuantity: 1,
});
check(
  "basket totals parse with a null savings",
  noSavings.success,
  noSavings.success ? "parsed" : "threw",
);

if (noSavings.success) {
  const totals = toCartTotals(noSavings.data);
  check("savings is absent, not zero", totals.savings === undefined, String(totals.savings));
  check(
    "no $0.00 was invented anywhere",
    !JSON.stringify(totals).includes("$0.00"),
    JSON.stringify(totals),
  );
  check(
    "the omission is named rather than left silent",
    totals.notReported.includes("savings"),
    totals.notReported.join(", ") || "(none)",
  );
  check(
    "reported money still comes through",
    totals.subtotal === "$12.00",
    String(totals.subtotal),
  );
}

console.log("\na removal that changes nothing");
// Captured live: removing a sku the trolley does not hold, isSuccessful true throughout.
const noLine = trolleyWriteResponseSchema.safeParse({
  itemAdded: null,
  totalItemQuantityInBasket: null,
  isSuccessful: true,
});
check(
  "write response parses with a null line",
  noLine.success,
  noLine.success ? "parsed" : "threw",
);
if (noLine.success) {
  check(
    "the site still reports success",
    noLine.data.isSuccessful,
    String(noLine.data.isSuccessful),
  );
}

// A removal on a Kg line: the site reports no purchasing unit, which must not read as a change.
const removalAdjustment = toCartAdjustment(0, 0, "Kg", "Kg", undefined);
check(
  "removing a weight-priced line reports no adjustment",
  !removalAdjustment.adjusted,
  removalAdjustment.note ?? "(none)",
);

// The earlier bug, still guarded: a removal must not report a unit change it did not make.
const removalUnitMismatch = toCartAdjustment(0, 0, "Each", "Kg", undefined);
check(
  "a removal never reports a unit adjustment",
  !removalUnitMismatch.adjusted,
  removalUnitMismatch.note ?? "(none)",
);

// A request that asked for stock and got no line is a real surprise and must still be reported.
const addedNothing = toCartAdjustment(2, 0, "Each", "Each", undefined);
check(
  "an add that produced no line is still reported",
  addedNothing.adjusted,
  addedNothing.note?.slice(0, 58) ?? "(none)",
);

console.log(
  failures.length === 0 ? "\nNull-field check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
