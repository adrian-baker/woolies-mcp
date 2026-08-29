/**
 * The account verification gate: signs in, then exercises the trolley end to end and puts it
 * back as it was.
 *
 * Proves the cart contract, which needs a real signed-in session. Run `npm run login` first; this
 * loads the session that produced and finishes by removing everything it added.
 *
 * It WILL modify a real trolley. Run it deliberately:
 *
 *   npm run smoke:account
 */
import { createWoolworthsApi } from "../src/server.js";
import {
  SessionStore,
  defaultSessionFilePath,
  restoreStoredSession,
} from "../src/session-store.js";

const EACH_SKU = "958674"; // a counted item
const KG_SKU = "245902"; // a loose item priced by weight
const KG_QUANTITY = 0.3; // the "300g of limes" case decimals exist for

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const api = createWoolworthsApi();
await restoreStoredSession(
  api,
  new SessionStore(process.env["WOOLIES_SESSION_FILE"] ?? defaultSessionFilePath()),
  "smoke:account",
);

console.log("sign_in()");
const outcome = await api.signIn();
console.log(`  outcome: ${outcome.kind}`);
if (outcome.kind !== "alreadySignedIn") {
  console.error(`  detail: ${"detail" in outcome ? outcome.detail : JSON.stringify(outcome)}`);
  console.error("\nSign-in did not succeed; nothing further was attempted.");
  process.exit(1);
}
const status = await api.getAccountStatus();
check("signed in", status.signedIn, status.firstName ?? "(no name)");

console.log("\nget_cart() — before");
const before = await api.getCart();
check("cart readable", true, `${before.lineCount} lines, ${before.totalQuantity} items, subtotal ${before.totals.subtotal}`);

console.log(`\nset_cart_quantity(${EACH_SKU}, 1, Each)`);
const addedEach = await api.setCartQuantity(EACH_SKU, 1, "Each");
check("Each add succeeded", addedEach.successful, JSON.stringify(addedEach));
check("Each quantity echoed", addedEach.appliedQuantity === 1, String(addedEach.appliedQuantity));
check("Each pricingUnit echoed", addedEach.appliedPricingUnit === "Each", addedEach.appliedPricingUnit ?? "(none)");

console.log(`\nset_cart_quantity(${KG_SKU}, ${KG_QUANTITY}, Kg)`);
const addedKg = await api.setCartQuantity(KG_SKU, KG_QUANTITY, "Kg");
check("Kg add with a decimal succeeded", addedKg.successful, JSON.stringify(addedKg));
check(
  "decimal quantity preserved",
  Math.abs(addedKg.appliedQuantity - KG_QUANTITY) < 0.001,
  String(addedKg.appliedQuantity),
);
check("Kg pricingUnit echoed", addedKg.appliedPricingUnit === "Kg", addedKg.appliedPricingUnit ?? "(none)");

console.log(`\nset_cart_quantity(${EACH_SKU}, 3, Each) — update`);
const updated = await api.setCartQuantity(EACH_SKU, 3, "Each");
check("quantity is absolute, not additive", updated.appliedQuantity === 3, String(updated.appliedQuantity));

console.log("\nget_cart() — with the test items");
const during = await api.getCart();
check(
  "both test lines present",
  during.lines.some((line) => line.sku === EACH_SKU) &&
    during.lines.some((line) => line.sku === KG_SKU),
  `${during.lineCount} lines`,
);

console.log("\nremoving both test items");
const removedEach = await api.removeFromCart(EACH_SKU);
check("Each removed", removedEach.successful, `trolley quantity now ${removedEach.trolleyTotalQuantity}`);
const removedKg = await api.removeFromCart(KG_SKU);
check("Kg removed", removedKg.successful, `trolley quantity now ${removedKg.trolleyTotalQuantity}`);
check(
  "removal of a Kg line reports no adjustment",
  !removedKg.adjusted,
  removedKg.adjustment ?? "(none)",
);
check(
  "removal of an Each line reports no adjustment",
  !removedEach.adjusted,
  removedEach.adjustment ?? "(none)",
);

console.log("\nget_cart() — after");
const after = await api.getCart();
check(
  "trolley restored",
  !after.lines.some((line) => line.sku === EACH_SKU || line.sku === KG_SKU),
  `${after.lineCount} lines (started at ${before.lineCount})`,
);

console.log("\nget_past_purchases()");
const sections = await api.getPastPurchases();
const history = sections.filter((section) => section.isPurchaseHistory);
const promotional = sections.filter((section) => !section.isPurchaseHistory);
check("purchase history section present", history.length === 1, history[0]?.section ?? "(none)");
check(
  "promotional section kept separate",
  promotional.length >= 1 && history.every((section) => section.products.length > 0),
  promotional.map((section) => section.section).join(", ") || "(none)",
);

if (failures.length === 0) {
  console.log("\nAccount smoke passed.");
} else {
  console.log(`\nAccount smoke FAILED: ${failures.join(", ")}`);
  process.exitCode = 1;
}
