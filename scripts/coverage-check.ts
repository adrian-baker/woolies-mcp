/**
 * Guards the completeness claim, which is the strongest statement this server makes and the one
 * that had no offline cover.
 *
 * Each case is a payload observed live. `-1` is what the site returns for a category slug it
 * cannot resolve; the off-by-one is recorded in DESIGN; the emptied-by-filter case is a real
 * `browse_category` result.
 *
 * Run with `npm run check:coverage`.
 */
import { toCoverage, toEmptyPageCoverage } from "../src/woolworths/mappers.js";
import { UnknownCategoryError, WoolworthsApi } from "../src/woolworths/api.js";
import { Authenticator } from "../src/woolworths/auth.js";
import { WoolworthsClient } from "../src/woolworths/client.js";
import { Session } from "../src/woolworths/session.js";

const DEPARTMENTS = [
  {
    id: 8,
    label: "Beer & Wine",
    url: "beer-wine",
    dasFacets: [
      { key: "8", value: "140", name: "Red Wine", productCount: 401, shelfResponses: [] },
      { key: "8", value: "141", name: "Ignored By The Site", productCount: 1, shelfResponses: [] },
    ],
  },
];

/** Applies a level only when the tree knows it, exactly as the site does. */
class BrowseClient extends WoolworthsClient {
  constructor() {
    super(new Session(), {});
  }

  override get(path: string, query: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (path === "products/departments") return Promise.resolve(DEPARTMENTS);
    const filters = (query["dasFilter"] as readonly string[] | undefined) ?? [];
    const askedAisle = filters.some((f) => f.startsWith("Aisle;;"));
    const applied = filters.some((f) => f.startsWith("Aisle;;red-wine;"));
    return Promise.resolve({
      products: { items: [], totalItems: applied ? 401 : 1323 },
      breadcrumb: {
        department: { name: "Beer & Wine", value: 8 },
        aisle: applied ? { name: "Red Wine", value: 140 } : null,
        shelf: null,
      },
      dasFacets: [],
      currentSortOption: "Relevance",
      ...(askedAisle ? {} : {}),
    });
  }
}

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const SAFE = "Safe to compare";

// An unresolved slug: 0 returned, -1 available. Previously "Complete: all 0 ... Safe to compare".
const unresolved = toCoverage({
  returned: 0,
  matchesAvailable: -1,
  page: 1,
  noun: "products",
  refinement: "check the arguments.",
});
check("an unresolved count is never complete", !unresolved.complete, String(unresolved.complete));
check(
  "and never claims safety",
  !unresolved.coverage.includes(SAFE),
  unresolved.coverage.slice(0, 72),
);
check(
  "and says the count was unusable",
  unresolved.coverage.includes("-1"),
  unresolved.coverage.includes("-1") ? "names the sentinel" : "silent",
);

// The site's own off-by-one, recorded in DESIGN: 40 returned against 39 reported.
const offByOne = toCoverage({
  returned: 40,
  matchesAvailable: 39,
  page: 1,
  noun: "products",
  refinement: "page further.",
});
check("an incoherent count is never complete", !offByOne.complete, String(offByOne.complete));
check("and never claims safety", !offByOne.coverage.includes(SAFE), offByOne.coverage.slice(0, 72));

// A genuinely complete page must still say so, or the guarantee is worthless.
const complete = toCoverage({
  returned: 18,
  matchesAvailable: 18,
  page: 1,
  noun: "products",
  refinement: "page further.",
});
check("a coherent full page is still complete", complete.complete, complete.coverage.slice(0, 58));

// Zero matches with the in-stock filter on: "none" must not be reported as settled.
const emptied = toCoverage({
  returned: 0,
  matchesAvailable: 0,
  page: 1,
  noun: "products",
  refinement: "page further.",
  filteredToInStock: true,
});
check(
  "an empty filtered result names the filter",
  emptied.coverage.includes("includeOutOfStock"),
  emptied.coverage.slice(-96),
);

// A partial page must never read as complete.
const partial = toCoverage({
  returned: 40,
  matchesAvailable: 136,
  page: 1,
  noun: "products",
  refinement: "page further.",
});
check("a partial page is not complete", !partial.complete, String(partial.complete));

// Past the end: an empty list must not read as "no matches exist".
const pastEnd = toEmptyPageCoverage(9, 18, "products");
check(
  "a page past the end says matches exist",
  !pastEnd.complete && pastEnd.coverage.includes("18"),
  pastEnd.coverage.slice(0, 66),
);

// --- a browse level the site ignored must never pass as the narrower set ---------------------
// Live: an aisle slug that does not exist returns the whole department with a null breadcrumb.
const api = new WoolworthsApi(new BrowseClient(), new Authenticator());

const applied = await api
  .browseCategory({
    department: "beer-wine",
    aisle: "red-wine",
    page: 1,
    sort: "Relevance",
    inStockOnly: false,
  })
  .then(
    (result) => `narrowed to ${result.matchesAvailable}`,
    (error: unknown) => `threw: ${(error as Error).message.slice(0, 44)}`,
  );
check("a level the site applied is returned", applied.startsWith("narrowed"), applied);

const ignored: unknown = await api
  .browseCategory({
    department: "beer-wine",
    aisle: "ignored-by-the-site",
    page: 1,
    sort: "Relevance",
    inStockOnly: false,
  })
  .then(
    () => undefined,
    (error: unknown) => error,
  );
check(
  "a level the site ignored is refused, not returned as the aisle",
  ignored instanceof UnknownCategoryError,
  ignored instanceof Error ? ignored.message.slice(0, 72) : "returned the wider set",
);

console.log(
  failures.length === 0 ? "\nCoverage check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
