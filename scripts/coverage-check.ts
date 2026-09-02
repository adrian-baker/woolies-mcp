/**
 * Guards the completeness claim, which is the strongest statement this server makes and the one
 * that had no offline cover.
 *
 * Each case is a payload observed live. The counts the GraphQL catalogue returns are guarded
 * here too: `pageSize` echoes the rows returned rather than the size asked for, and `currentPage`
 * reads -1 on an empty result, so neither describes a page.
 *
 * Run with `npm run check:coverage`.
 */
import { toCoverage, toEmptyPageCoverage, toProductGrid } from "../src/woolworths/mappers.js";

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

// The GraphQL page envelope reports two counts that do not mean what they are named, so neither
// is used to describe a page. Guarded here because reading either would silently misreport.
const grid = toProductGrid({
  totalCount: 116,
  // The site echoes how many rows it returned, not the size asked for.
  pageSize: 38,
  totalPages: 4,
  // A sentinel on an empty result, never a page number.
  currentPage: -1,
  results: [{ __typename: "GamResultItem" }, { __typename: "ContentInGridResultItem" }],
});
check(
  "advertising in the grid is excluded from the products",
  grid.products.length === 0 && grid.advertisingExcluded === 2,
  `${grid.products.length} products, ${grid.advertisingExcluded} tiles`,
);
check(
  "a grid of nothing but advertising rejects nothing",
  grid.rejections.length === 0,
  grid.rejections.join("; ") || "(none)",
);

console.log(
  failures.length === 0 ? "\nCoverage check passed." : `\nFAILED: ${failures.join(", ")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
