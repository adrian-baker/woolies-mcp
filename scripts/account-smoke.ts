/**
 * The account verification gate: signs in, then exercises the cart end to end and puts it back
 * as it was.
 *
 * Proves the cart contract, which needs a real signed-in session. Run `npm run login` first; it
 * loads the stored session and finishes by removing everything it added.
 *
 * It WILL modify a real cart. Run it deliberately:
 *
 *   npm run smoke:account
 */
import { createWoolworthsApi } from "../src/server.js";
import {
  SessionStore,
  defaultSessionFilePath,
  restoreStoredSession,
} from "../src/session-store.js";
import type { Cart } from "../src/woolworths/mappers.js";

const EACH_SKU = "958674"; // a counted item
const KG_SKU = "149885"; // a loose item priced by weight, average 0.2 kg per orange
const KG_QUANTITY = 0.3; // the "300g of limes" case decimals exist for

const failures: string[] = [];

/** The money fields the site actually stated. A field named in `notReported` must not be here. */
function reportedTotals(totals: Cart["totals"]): ReadonlySet<string> {
  const stated = new Set<string>();
  for (const [field, value] of Object.entries(totals)) {
    if (field !== "notReported" && typeof value === "string") stated.add(field);
  }
  return stated;
}

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

console.log("auth_status()");
const access = await api.checkAccountAccess();
console.log(`  account tools usable: ${access.usable}`);
// Gated on a demonstrated account call. There is no second signal to disagree with it: the
// storefront's session shell went with the REST API.
if (!access.usable) {
  console.error(
    "\nAccount access is not usable, so nothing further was attempted. Run `npm run login`.",
  );
  process.exit(1);
}
check("account access demonstrated", access.usable, String(access.usable));

console.log("\nget_location()");
const where = await api.getFulfilment();
check(
  "the location comes from the cart, not the storefront shell",
  where.suburb !== undefined || where.pickupLocation !== undefined,
  JSON.stringify(where),
);
check(
  "anything the cart did not state is named rather than guessed",
  where.notReported.every((field) => !JSON.stringify(where).includes(`"${field}":"`)),
  where.notReported.join(", ") || "(everything reported)",
);

console.log("\nfind_stores()");
const stores = await api.findStores(undefined, 10);
check("stores returned", stores.stores.length > 0, `${stores.returned} nearest`);
check(
  "each store states how far away it is",
  stores.stores.every((store) => store.distanceKm !== undefined),
  stores.stores
    .slice(0, 3)
    .map((store) => `${store.name} ${String(store.distanceKm)}km`)
    .join(", "),
);
check("coverage refuses a completeness claim", stores.coverage.includes("not the full"), "stated");

console.log("\nget_delivery_windows()");
const windows = await api.getDeliveryWindows();
check(
  "windows returned",
  windows.returned > 0,
  `${windows.returned} of ${windows.available} available`,
);
check(
  "every listed window is bookable",
  windows.windows.every((w) => w.available),
  `${windows.windows.filter((w) => !w.available).length} unavailable listed`,
);
check(
  "a delivery fee is banded, never a single amount",
  windows.windows
    .flatMap((w) => w.fees)
    .every((fee) => fee.amount === undefined && fee.bands.length > 0),
  JSON.stringify(windows.windows[0]?.fees[0]?.bands ?? "(no fees)"),
);
check(
  "the coverage refuses booking in words",
  windows.coverage.includes("cannot book"),
  windows.coverage.slice(0, 60),
);

console.log("\nget_cart() — before");
const before = await api.getCart();
// The test skus are set to absolute quantities and removed at the end, which would destroy a line
// the shopper already had. Refuse rather than restore something that was never snapshotted.
const collisions = before.lines.filter((line) => line.sku === EACH_SKU || line.sku === KG_SKU);
if (collisions.length > 0) {
  console.error(
    `\nThe cart already holds ${collisions.map((line) => `${line.sku} (${line.name})`).join(" and ")}. ` +
      "This smoke would set and then remove those lines. Nothing was changed; pick different test " +
      "skus or empty those lines first.",
  );
  process.exit(1);
}
check(
  "cart readable",
  true,
  `${before.lineCount} lines, ${before.totalQuantity} items, subtotal ${before.totals.subtotal}`,
);
check(
  "a fee the site has not determined is absent, never $0.00",
  !before.totals.notReported.some((field) => reportedTotals(before.totals).has(field)),
  before.totals.notReported.join(", ") || "(everything reported)",
);

console.log(`\nset_cart_quantity(${EACH_SKU}, 1, Each)`);
const addedEach = await api.setCartQuantity(EACH_SKU, 1, "EACH");
check("Each add landed a line", addedEach.lineInCart, JSON.stringify(addedEach));
check("Each quantity echoed", addedEach.appliedQuantity === 1, String(addedEach.appliedQuantity));
check(
  "Each pricingUnit echoed",
  addedEach.appliedPricingUnit === "EACH",
  addedEach.appliedPricingUnit ?? "(none)",
);
check(
  "the write targeted the Each variant",
  addedEach.variantKey === `${EACH_SKU}-EA`,
  addedEach.variantKey,
);

console.log(`\nset_cart_quantity(${KG_SKU}, ${KG_QUANTITY}, Kg)`);
const addedKg = await api.setCartQuantity(KG_SKU, KG_QUANTITY, "KG");
check("Kg add with a decimal landed a line", addedKg.lineInCart, JSON.stringify(addedKg));
// Woolworths substitutes its own quantity on some weight-priced products, rounding up to a whole
// number of items. Either outcome is correct; reporting one as the other is not.
const kgPreserved = Math.abs(addedKg.appliedQuantity - KG_QUANTITY) < 0.001;
check(
  "a decimal quantity is either honoured or reported as adjusted, never silently changed",
  kgPreserved ? !addedKg.adjusted : addedKg.adjusted && addedKg.adjustment !== undefined,
  `requested ${KG_QUANTITY}, applied ${addedKg.appliedQuantity}: ${addedKg.adjustment ?? "no adjustment"}`,
);
check(
  "Kg pricingUnit echoed",
  addedKg.appliedPricingUnit === "KG",
  addedKg.appliedPricingUnit ?? "(none)",
);

console.log(`\nset_cart_quantity(${EACH_SKU}, 3, Each) — update`);
const updated = await api.setCartQuantity(EACH_SKU, 3, "EACH");
check(
  "quantity is absolute, not additive",
  updated.appliedQuantity === 3,
  String(updated.appliedQuantity),
);

console.log(`\nset_cart_quantity(${KG_SKU}, 1, Each) — switching the pricing of a line`);
const switched = await api.setCartQuantity(KG_SKU, 1, "EACH");
check(
  "the Each variant now holds the line",
  switched.appliedQuantity === 1,
  JSON.stringify(switched),
);
const afterSwitch = await api.getCart();
check(
  "switching pricing leaves exactly one line for the sku",
  afterSwitch.lines.filter((line) => line.sku === KG_SKU).length === 1,
  afterSwitch.lines
    .filter((line) => line.sku === KG_SKU)
    .map((line) => `${line.variantKey}=${line.quantity}`)
    .join(", ") || "(no line)",
);

console.log("\nget_cart() — with the test items");
const during = await api.getCart();
check(
  "both test lines present",
  during.lines.some((line) => line.sku === EACH_SKU) &&
    during.lines.some((line) => line.sku === KG_SKU),
  `${during.lineCount} lines`,
);
check(
  "every line names the variant a write would target",
  during.lines.every((line) => line.variantKey.startsWith(`${line.sku}-`)),
  during.lines.map((line) => line.variantKey).join(", "),
);

console.log("\nset_cart_quantities([...]) — one mutation for both");
const batch = await api.setCartQuantities([
  { sku: EACH_SKU, quantity: 2, pricingUnit: "EACH" },
  { sku: KG_SKU, quantity: KG_QUANTITY, pricingUnit: "KG" },
]);
check(
  "every requested sku is reported",
  batch.length === 2 && batch.every((outcome) => outcome.kind === "written"),
  JSON.stringify(batch.map((outcome) => outcome.kind)),
);

console.log("\nremoving both test items");
const removedEach = await api.removeFromCart(EACH_SKU);
check(
  "Each removed",
  !removedEach.lineInCart,
  `cart quantity now ${removedEach.cartTotalQuantity}`,
);
const removedKg = await api.removeFromCart(KG_SKU);
check("Kg removed", !removedKg.lineInCart, `cart quantity now ${removedKg.cartTotalQuantity}`);
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
  "cart restored",
  !after.lines.some((line) => line.sku === EACH_SKU || line.sku === KG_SKU),
  `${after.lineCount} lines (started at ${before.lineCount})`,
);
check(
  "the cart is back to the line count it started at",
  after.lineCount === before.lineCount,
  `${after.lineCount} vs ${before.lineCount}`,
);

// Recorded like any other failure rather than thrown, so the cart results above are still
// reported even when the history half breaks.
try {
  console.log("\nget_buy_it_again()");
  const purchases = await api.getBuyItAgain();
  check(
    "previously purchased products returned",
    purchases.products.length > 0,
    `${purchases.products.length} of ${purchases.matchesAvailable ?? "?"}`,
  );
  check(
    "advertising is excluded from the shopper's own history",
    purchases.advertisingExcluded >= 0 && purchases.products.every((p) => p.sku !== ""),
    `${purchases.advertisingExcluded} advertising tiles dropped`,
  );
  check(
    "each product carries the key a cart write targets",
    purchases.products.every((p) => p.variantKey.startsWith(`${p.sku}-`)),
    purchases.products[0]?.variantKey ?? "(none)",
  );
  check("coverage is stated", purchases.coverage.length > 0, purchases.coverage.slice(0, 70));

  console.log("\nget_order_history()");
  const orderHistory = await api.getOrderHistory();
  check(
    "order history returned",
    orderHistory.orders.length > 0,
    `${orderHistory.orders.length} of ${orderHistory.matchesAvailable}, most recent total ${orderHistory.orders[0]?.total ?? "?"}`,
  );
  check(
    "orders carry a reference, status and total",
    orderHistory.orders.every(
      (order) => order.reference !== "" && order.status !== "" && order.total.startsWith("$"),
    ),
    orderHistory.orders[0]?.status ?? "(none)",
  );
  check(
    "orders carry their fulfilment slot",
    orderHistory.orders.every((order) => order.fulfilments.length > 0),
    orderHistory.orders[0]?.fulfilments[0]
      ? `${orderHistory.orders[0].fulfilments[0].method} from ${orderHistory.orders[0].fulfilments[0].location}`
      : "(none)",
  );
  check(
    "order history states its coverage",
    orderHistory.coverage.length > 0,
    orderHistory.coverage.slice(0, 58),
  );

  console.log("\nget_purchase_history()");
  const purchaseHistory = await api.getPurchaseHistory();
  check(
    "purchase history returned with the products in each order",
    purchaseHistory.orders.length > 0 && (purchaseHistory.orders[0]?.items.length ?? 0) > 0,
    `${purchaseHistory.orders.length} orders, ${purchaseHistory.orders[0]?.items.length ?? 0} items in the most recent`,
  );
  check(
    "every line carries a sku a cart write can target",
    purchaseHistory.orders.every((order) => order.items.every((item) => item.sku !== "")),
    purchaseHistory.orders[0]?.items[0]?.sku ?? "(none)",
  );
  check(
    "a zero-quantity line is set aside, never counted as a purchase",
    purchaseHistory.orders.every((order) => order.items.every((item) => item.quantity > 0)),
    `${purchaseHistory.orders.reduce((total, order) => total + order.zeroQuantityLines.length, 0)} zero lines held apart`,
  );
  check(
    "purchase history states its coverage",
    purchaseHistory.coverage.includes("recent window"),
    purchaseHistory.coverage.slice(0, 58),
  );
} catch (error: unknown) {
  check(
    "the history tools work",
    false,
    error instanceof Error ? error.message.slice(0, 80) : String(error),
  );
}

if (failures.length === 0) {
  console.log("\nAccount smoke passed.");
} else {
  console.log(`\nAccount smoke FAILED: ${failures.join(", ")}`);
  process.exitCode = 1;
}
