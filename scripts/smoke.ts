/**
 * Live smoke test against woolworths.co.nz, exercising the same session, client and mappers the
 * MCP tools use. Roughly a dozen requests, throttled to one per second (DESIGN.md, "Politeness").
 *
 * Runs against its own anonymous session, not a stored sign-in and not a deployed server, so the
 * `set_location` below cannot move where anyone else is shopping.
 *
 * Run with `npm run smoke`. Exits non-zero on the first failed check.
 */
import { createWoolworthsApi } from "../src/server.js";
import type { SearchResult } from "../src/woolworths/api.js";

const SUBURB = "Ponsonby";
const EXPECTED_SUBURB_ID = 102;
const EXPECTED_STORE_ID = 9250;
const EXPECTED_AREA_ID = 78;
const SEARCH_QUERY = "rose wine";
const NEAREST_STORE_SUBURB = "Henderson";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  const mark = passed ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

async function main(): Promise<void> {
  const api = createWoolworthsApi();

  console.log(`set_location("${SUBURB}")`);
  const located = await api.setLocation(SUBURB);
  if (located.kind !== "set") {
    console.log(`  [FAIL] resolved to a single suburb: got ${located.kind}`);
    failures.push("set_location resolved to a single suburb");
    reportAndExit();
    return;
  }
  check(
    "suburb id",
    located.suburb.id === EXPECTED_SUBURB_ID,
    `${located.suburb.name} = ${located.suburb.id}`,
  );
  check("shell address", located.fulfilment.address.includes(SUBURB), located.fulfilment.address);
  check(
    "fulfilment area id",
    located.fulfilment.areaId === EXPECTED_AREA_ID,
    String(located.fulfilment.areaId),
  );
  check(
    "fulfilment store id",
    located.fulfilment.fulfilmentStoreId === EXPECTED_STORE_ID,
    String(located.fulfilment.fulfilmentStoreId),
  );
  check(
    "interpretation reported",
    located.interpretedAs !== undefined,
    located.interpretedAs ?? "(exact match, no note)",
  );

  console.log(`\nsearch_products("${SEARCH_QUERY}")`);
  const results = await api.searchProducts({
    query: SEARCH_QUERY,
    page: 1,
    sort: "Relevance",
    inStockOnly: true,
    size: 10,
  });
  check("in-stock items returned", results.products.length > 0, `${results.products.length} items`);
  check("total match count", results.matchesAvailable > 0, String(results.matchesAvailable));
  check(
    "category counts",
    results.categoryCounts.length > 0,
    `${results.categoryCounts.length} facets, first: ${describeFacet(results)}`,
  );
  const browsable = results.categoryCounts.filter((facet) => facet.department !== undefined);
  check(
    "category counts carry browse slugs",
    browsable.length > 0,
    `${browsable.length}/${results.categoryCounts.length} resolved, e.g. ${JSON.stringify(browsable[0])}`,
  );
  const first = results.products[0];
  if (first === undefined) {
    reportAndExit();
    return;
  }
  console.log(`  first item: ${JSON.stringify(first)}`);

  console.log(`\nget_product("${first.sku}")`);
  const product = await api.getProduct(first.sku);
  check("sku round-trips", product.sku === first.sku, product.sku);
  check("breadcrumb present", product.breadcrumb.length > 0, product.breadcrumb.join(" > "));
  check(
    "description present",
    product.description !== undefined,
    `${product.description?.slice(0, 60) ?? "(none)"}…`,
  );
  console.log(`  detail: ${JSON.stringify({ ...product, description: undefined }, null, 0)}`);

  console.log("\nlist_categories()");
  const departments = await api.listCategories();
  check("departments listed", departments.length > 0, `${departments.length} departments`);
  const beerWine = departments.find((department) => department.slug === "beer-wine");
  check("beer-wine department present", beerWine !== undefined, beerWine?.name ?? "(missing)");

  console.log("\nbrowse_category(beer-wine)");
  const browsed = await api.browseCategory({
    department: "beer-wine",
    page: 1,
    sort: "PriceAsc",
    inStockOnly: true,
    size: 10,
  });
  check(
    "shelf browse returned products",
    browsed.products.length > 0,
    `${browsed.products.length} items`,
  );
  console.log(`  cheapest: ${JSON.stringify(browsed.products[0])}`);

  console.log("\nget_specials(meat-poultry)");
  const specials = await api.getSpecials({
    department: "meat-poultry",
    page: 1,
    sort: "Relevance",
    inStockOnly: true,
    size: 10,
  });
  check("specials returned", specials.products.length > 0, `${specials.products.length} items`);
  check(
    "specials really are specials",
    specials.products.every((item) => item.isSpecial),
    `${specials.products.filter((item) => item.isSpecial).length}/${specials.products.length} flagged`,
  );

  // Named separately from SUBURB: not every delivery suburb has a pick-up store.
  console.log(`\nfind_stores('${NEAREST_STORE_SUBURB}')`);
  const stores = (await api.findStores(NEAREST_STORE_SUBURB)).stores;
  check(
    "store match",
    stores.length > 0,
    stores
      .map((store) => store.name)
      .slice(0, 3)
      .join(", "),
  );
  const allStores = (await api.findStores(undefined)).stores;
  check("full store list", allStores.length > 100, `${allStores.length} pick-up locations`);

  console.log("\nget_location()");
  const fulfilment = await api.getFulfilment();
  check("still at the set location", fulfilment.address.includes(SUBURB), fulfilment.address);

  reportAndExit();
}

function describeFacet(results: SearchResult): string {
  const facet = results.categoryCounts[0];
  return facet === undefined ? "(none)" : `${facet.group}/${facet.name}=${facet.productCount}`;
}

function reportAndExit(): void {
  if (failures.length === 0) {
    console.log("\nSmoke passed.");
    return;
  }
  console.log(`\nSmoke FAILED: ${failures.join(", ")}`);
  process.exitCode = 1;
}

await main();
