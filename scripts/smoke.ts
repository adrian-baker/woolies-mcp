/**
 * The catalogue verification gate: search, browse, specials, categories, product detail and
 * stores, against the live site.
 *
 * Read-only — nothing here writes to the cart — but signed in, because `My.products` answers
 * for the store the session is shopping from. Run anonymously this gate passed against a guest's
 * store, checking prices and ranging the shopper will never be shown. Signing out is not a mode
 * this server supports, so it is not a mode its catalogue gate runs in.
 *
 *   npm run smoke
 */
import { createWoolworthsApi } from "../src/server.js";
import {
  SessionStore,
  defaultSessionFilePath,
  restoreStoredSession,
} from "../src/session-store.js";

const SEARCH_QUERY = "oat milk";
const KNOWN_SKU = "133211"; // loose bananas: sold by weight and by the item
const LIQUOR_SKU = "324433"; // a RegulatedVariant, not a GroceryVariant

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const api = createWoolworthsApi();
await restoreStoredSession(
  api,
  new SessionStore(process.env["WOOLIES_SESSION_FILE"] ?? defaultSessionFilePath()),
  "smoke",
);
// The catalogue answers per store, so a gate that cannot prove which store it asked is not a
// gate. Without a session it would silently check a guest's prices instead of the shopper's.
if (!(await api.checkAccountAccess()).usable) {
  console.error(
    "\nNo usable session, so this gate would run against a guest's store rather than the " +
      "shopper's. Run `npm run login` first.",
  );
  process.exit(1);
}

const location = await api.getFulfilment();
console.log(
  `Signed in, shopping ${location.mode} to ${location.suburb ?? "(no suburb stated)"} ` +
    `from store ${location.catalogueStoreKey ?? "(not reported)"}.`,
);
check(
  "the gate states which store it is checking",
  location.catalogueStoreKey !== undefined,
  location.catalogueStoreKey ?? "not reported",
);

console.log(`\nsearch_products("${SEARCH_QUERY}")`);
const results = await api.searchProducts({ query: SEARCH_QUERY, page: 1, sort: "RELEVANCE" });
check(
  "products returned",
  results.products.length > 0,
  `${results.products.length} of ${results.matchesAvailable}`,
);
check(
  "every product carries the key a cart write targets",
  results.products.every((product) => product.variantKey.startsWith(`${product.sku}-`)),
  results.products[0]?.variantKey ?? "(none)",
);
check(
  "a product not on special has no was-price, rather than a zero",
  results.products
    .filter((product) => !product.isSpecial)
    .every((product) => product.wasPrice === undefined),
  `${results.products.filter((product) => product.isSpecial).length} on special`,
);
check("coverage is stated", results.coverage.length > 0, results.coverage.slice(0, 64));
check(
  "every product is priced for the store the session is shopping",
  results.products.every((product) => product.storeKey === location.catalogueStoreKey),
  [...new Set(results.products.map((product) => product.storeKey))].join(", "),
);

console.log("\nlist_categories()");
const root = await api.listCategories();
check("the tree root returned", root.children.length > 0, `${root.name} → ${root.children.length}`);
check(
  "a level not asked for is counted, not shown as childless",
  root.children.every((node) => node.children.length === 0) &&
    root.children.some((node) => (node.childrenNotListed ?? 0) > 0),
  `${root.children.filter((node) => (node.childrenNotListed ?? 0) > 0).length} of ${root.children.length} report unlisted children`,
);

const deeper = await api.listCategories(undefined, 2);
const department = deeper.children.find((node) => node.children.length > 0);
check(
  "the tree carries children with their own keys at depth 2",
  department?.children.every((child) => child.key !== "") === true,
  department === undefined ? "(no children)" : `${department.name} → ${department.children.length}`,
);

if (department !== undefined) {
  console.log(`\nbrowse_category(${department.key})`);
  const browsed = await api.browseCategory({
    categoryKey: department.key,
    page: 1,
    sort: "RELEVANCE",
  });
  check(
    "category products returned",
    browsed.products.length > 0,
    `${browsed.products.length} of ${browsed.matchesAvailable} in ${department.name}`,
  );
}

console.log("\nget_specials()");
const specials = await api.getSpecials({ page: 1, sort: "RELEVANCE" });
check("specials returned", specials.products.length > 0, `${specials.products.length}`);
check(
  "every special states what it was and what it saves",
  specials.products
    .filter((product) => product.isSpecial)
    .every((product) => product.wasPrice !== undefined),
  `${specials.products.filter((product) => product.isSpecial).length} flagged special`,
);

console.log(`\nget_product(${KNOWN_SKU})`);
const product = await api.getProduct(KNOWN_SKU);
check("product returned", product.sku === KNOWN_SKU, `${product.name} — ${product.price}`);
check(
  "a dual-priced product reports both ways to buy it",
  product.canBuyByWeight && product.variants.length > 1,
  product.variants.map((variant) => `${variant.variantKey} ${variant.unit}`).join(", "),
);
check(
  "the quantity step the site sells in is reported",
  product.quantityIncrement > 0,
  `min ${product.minimumQuantity}, step ${product.quantityIncrement}`,
);
check(
  "an unstated allergen list is not an assurance",
  product.allergens.status === "stated" || product.allergens.warning.length > 0,
  product.allergens.status,
);

console.log(`\nget_product(${LIQUOR_SKU}) — a variant type other than GroceryVariant`);
const liquor = await api.getProduct(LIQUOR_SKU);
check(
  "a liquor product is describable, not rejected as unreadable",
  liquor.name !== "" && liquor.rangedAtStore,
  `${liquor.name} — ${liquor.price ?? "not priced"}`,
);
check(
  "an age restriction is reported as stated, not as a zero",
  liquor.ageRestriction === "18",
  liquor.ageRestriction ?? "not stated",
);
check(
  "a product with no ingredients field says so, never 'contains none'",
  liquor.ingredients.status === "notStated",
  liquor.ingredients.status,
);

console.log("\nsearch_products_batch — several queries, one request");
// That the queries travel in one request is pinned offline by check:graphql-cart, which reads
// the document's aliases. It cannot be shown by timing here: the site's own latency varies by
// seconds, so a slow single request is indistinguishable from several fast ones. What this
// checks is that the answers come back correctly attributed.
const batchQueries = ["paneer", "limes", "oat milk", "weetbix", "bananas", "tea", "rice", "flour"];
const batched = await api.searchMany(batchQueries, { page: 1, sort: "RELEVANCE", size: 3 });
check(
  "every query gets its own group, in the order asked",
  batched.length === batchQueries.length &&
    batched.every((entry, index) => entry.query === batchQueries[index]),
  batched.map((entry) => entry.query).join(", "),
);
check(
  "each group answers its own query rather than repeating one",
  new Set(batched.map((entry) => entry.result.products[0]?.sku)).size === batchQueries.length,
  batched.map((entry) => entry.result.products[0]?.sku ?? "(none)").join(", "),
);

console.log(failures.length === 0 ? "\nSmoke passed." : `\nFAILED: ${failures.join(", ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
