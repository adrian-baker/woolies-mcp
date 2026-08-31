import { Authenticator, NotSignedInError, type SignInOutcome } from "./auth.js";
import { WoolworthsApiError, WoolworthsClient, type QueryValue } from "./client.js";
import type { ImportedCookie } from "./session.js";
import {
  buildCategoryIndex,
  toCartLines,
  partitionSearchItems,
  toAccountStatus,
  toCategoryCounts,
  toCompactProduct,
  toDepartment,
  toFulfilment,
  toProductDetail,
  toStores,
  type AccountStatus,
  type Cart,
  slugify,
  optionalText,
  toCartAdjustment,
  toCartTotals,
  toOrderHistory,
  toCoverage,
  toEmptyPageCoverage,
  toPurchaseSection,
  type CategoryCount,
  type CategoryIndex,
  type Coverage,
  type OrderHistory,
  type PurchaseSection,
  type CompactProduct,
  type Department,
  type Fulfilment,
  type ProductDetail,
  type Store,
} from "./mappers.js";
import {
  departmentsResponseSchema,
  fulfilmentContextSchema,
  parseResponse,
  pastOrdersResponseSchema,
  pickupAddressesResponseSchema,
  forgottenProductsResponseSchema,
  productDetailSchema,
  searchResponseSchema,
  shopperContextSchema,
  suburbsResponseSchema,
  trolleyResponseSchema,
  trolleyWriteResponseSchema,
} from "./schemas.js";

/** The site's four sort keys, read from `sortOptions` in a live search response. */
export const SORT_OPTIONS = ["Relevance", "PriceAsc", "PriceDesc", "CUPAsc"] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE = 40;

/** Long enough to cover a burst of cart writes, short enough that a dropped session surfaces fast. */
const SIGNED_IN_TTL_MS = 60_000;

/** What every account endpoint returns once the session is no longer honoured. */
const UNAUTHORIZED = 401;

/** How a line is priced. Captured traffic sends exactly these two values. */
export const PRICING_UNITS = ["Each", "Kg"] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

export type CartWriteOutcome =
  | { readonly kind: "written"; readonly result: CartWriteResult }
  | { readonly kind: "failed"; readonly sku: string; readonly reason: string };

export interface CartWriteResult {
  readonly sku: string;
  /** What was asked for. */
  readonly requestedQuantity: number;
  /** Absent on a removal: setting a line to 0 has no pricing unit. */
  readonly requestedPricingUnit: PricingUnit | undefined;
  /** What the site actually put in the trolley. May differ from the request. */
  readonly appliedQuantity: number;
  /** Absent on a removal, for the same reason. */
  readonly appliedPricingUnit: string | undefined;
  /** True when the site did not honour the request exactly; `adjustment` then says how. */
  readonly adjusted: boolean;
  readonly adjustment: string | undefined;
  /** Whether the sku has a line in the trolley after the write. */
  readonly lineInTrolley: boolean;
  /**
   * Sum of quantities across the whole trolley, not a count of lines. Undefined when the site
   * did not report it, which it does not on a write that left no line — never read as zero.
   */
  readonly trolleyTotalQuantity: number | undefined;
  readonly successful: boolean;
}

const REFINE_PRODUCTS =
  "request further pages until one comes back short, or use browse_category with the slugs from " +
  "categoryCounts, which lists a category exhaustively.";

/**
 * Narrows a search result to one department in this process.
 *
 * `dasFilter` is inert on `target=search` — verified live, every form returns zero — so the
 * upstream cannot do it. Filtering here covers only the page that was fetched, and the coverage
 * sentence says so rather than implying the department was searched exhaustively.
 */
function narrowToDepartment(result: SearchResult, department: string): SearchResult {
  const wanted = department.trim().toLowerCase();
  const kept = result.products.filter(
    (product) => product.department !== undefined && slugify(product.department) === wanted,
  );
  const facet = result.categoryCounts.find(
    (count) => count.group === "Department" && count.department === wanted,
  );
  const inDepartment = facet?.productCount;

  return {
    ...result,
    products: kept,
    returned: kept.length,
    complete: false,
    coverage:
      `Showing ${kept.length} products in '${department}', filtered from the ${result.returned} ` +
      `fetched on page ${result.page} of ${result.matchesAvailable} total matches` +
      (inDepartment === undefined
        ? ". The site does not report how many matches that department holds, so this is NOT known to be all of them."
        : `. The site reports ${inDepartment} matches in that department, so this is NOT all of them unless those numbers agree.`) +
      " Request further pages before making any cheapest/only/none-available claim.",
  };
}

function adjustmentDiffers(
  requestedQuantity: number,
  appliedQuantity: number,
  requestedPricingUnit: string,
  appliedPricingUnit: string,
): boolean {
  return toCartAdjustment(
    requestedQuantity,
    appliedQuantity,
    requestedPricingUnit,
    appliedPricingUnit,
    undefined,
  ).adjusted;
}

function toDasFilters(filter: CategoryFilter): readonly string[] {
  const levels: string[] = [];
  if (filter.department !== undefined) levels.push(`Department;;${filter.department};false`);
  if (filter.aisle !== undefined) levels.push(`Aisle;;${filter.aisle};false`);
  if (filter.shelf !== undefined) levels.push(`Shelf;;${filter.shelf};false`);
  return levels;
}

/** Non-product tiles the listings are known to mix in. Anything else is logged as unrecognised. */
const KNOWN_TILE_TYPES = new Set(["PromoTile", "PromotionalCarousel"]);

/** Shared by every product listing: search, browse and specials differ only in what they select. */
interface ListingRequest {
  readonly page: number;
  readonly sort: SortOption;
  readonly inStockOnly: boolean;
  readonly size?: number;
}

export interface StoreSearchResult extends Coverage {
  readonly stores: readonly Store[];
}

export interface CategoryFilter {
  readonly department?: string;
  readonly aisle?: string;
  readonly shelf?: string;
}

export interface SearchRequest extends ListingRequest, CategoryFilter {
  readonly query: string;
}

export interface BrowseRequest extends ListingRequest {
  readonly department: string;
  readonly aisle?: string;
  readonly shelf?: string;
}

export interface SpecialsRequest extends ListingRequest {
  readonly department?: string;
}

/**
 * `matchesAvailable` is the site's count for the whole query; `products` holds only this page.
 * `categoryCounts[].productCount` is the site's own facet count and does not have to agree with
 * `matchesAvailable` — the two are computed differently upstream — so coverage is always built
 * from `matchesAvailable`, which is what paging actually walks.
 */
export interface SearchResult extends Coverage {
  readonly products: readonly CompactProduct[];
  readonly matchesAvailable: number;
  readonly sort: string;
  readonly categoryCounts: readonly CategoryCount[];
}

export interface SuburbMatch {
  readonly id: number;
  readonly name: string;
}

/** What `setLocation` did. Ambiguity is an outcome, not an error: the caller must ask. */
export type SetLocationOutcome =
  | {
      readonly kind: "set";
      readonly suburb: SuburbMatch;
      readonly fulfilment: Fulfilment;
      /** Set when the requested name was not what the site actually matched. */
      readonly interpretedAs: string | undefined;
    }
  | { readonly kind: "ambiguous"; readonly matches: readonly SuburbMatch[] }
  | { readonly kind: "notFound" };

/**
 * The Woolworths operations this server exposes, in domain terms. Everything above this layer
 * deals in compact shapes; everything below it deals in the site's raw JSON.
 */
export class WoolworthsApi {
  private readonly client: WoolworthsClient;
  private readonly authenticator: Authenticator;
  private departments: readonly Department[] | undefined;

  private categoryIndex: CategoryIndex | undefined;
  private readonly now: () => number;

  constructor(
    client: WoolworthsClient,
    authenticator: Authenticator,
    now: () => number = Date.now,
  ) {
    this.client = client;
    this.authenticator = authenticator;
    this.now = now;
  }

  /** Signs in if the session is anonymous, and reports the outcome either way. */
  async signIn(): Promise<SignInOutcome> {
    const status = await this.getAccountStatus();
    return this.authenticator.signIn(status.signedIn);
  }

  /**
   * Adopts a session captured by a real browser sign-in (`npm run login`).
   *
   * This is how the server becomes signed in: Auth0 challenges non-browser clients with Turnstile,
   * so a person signs in and hands the result over. Returns the signed-in state afterwards, so the
   * caller learns whether the handover actually worked rather than assuming it did.
   */
  async importSession(cookies: readonly ImportedCookie[]): Promise<AccountStatus> {
    await this.client.shopperSession.importCookies(cookies);
    return this.getAccountStatus();
  }

  /** The session cookie's stated `Expires` date: an upper bound, not proof the session works. */
  cookieExpiry(): Promise<Date | undefined> {
    return this.client.shopperSession.cookieExpiry();
  }

  async searchProducts(request: SearchRequest): Promise<SearchResult> {
    const result = await this.productQuery("/products?target=search", request.page, request.sort, {
      target: "search",
      search: request.query,
      size: request.size ?? DEFAULT_PAGE_SIZE,
      page: request.page,
      sort: request.sort,
      inStockProductsOnly: request.inStockOnly,
    });
    if (request.department === undefined) return result;
    return narrowToDepartment(result, request.department);
  }

  /** Runs several searches in one call so discovering N products costs one round trip. */
  async searchMany(
    queries: readonly string[],
    request: Omit<SearchRequest, "query">,
  ): Promise<readonly { query: string; result: SearchResult }[]> {
    const results: { query: string; result: SearchResult }[] = [];
    for (const query of queries) {
      results.push({ query, result: await this.searchProducts({ ...request, query }) });
    }
    return results;
  }

  /**
   * Browses one branch of the tree. `dasFilter` repeats once per level and takes slugs, not ids
   * (DESIGN.md, "Build notes"); a shelf without its department returns nothing.
   */
  browseCategory(request: BrowseRequest): Promise<SearchResult> {
    const levels = toDasFilters(request);
    return this.productQuery("/products?target=browse", request.page, request.sort, {
      target: "browse",
      dasFilter: levels,
      size: request.size ?? DEFAULT_PAGE_SIZE,
      page: request.page,
      sort: request.sort,
      inStockProductsOnly: request.inStockOnly,
    });
  }

  getSpecials(request: SpecialsRequest): Promise<SearchResult> {
    const department = request.department;
    return this.productQuery("/products?target=specials", request.page, request.sort, {
      target: "specials",
      useRankedSpecials: true,
      ...(department === undefined ? {} : { dasFilter: [`Department;;${department};false`] }),
      size: request.size ?? DEFAULT_PAGE_SIZE,
      page: request.page,
      sort: request.sort,
      inStockProductsOnly: request.inStockOnly,
    });
  }

  /**
   * The browse tree, fetched once per process. It changes on the scale of weeks, and a server
   * restart is the refresh; an empty tree is not cached, so a bad fetch retries next call.
   */
  async listCategories(): Promise<readonly Department[]> {
    const cached = this.departments;
    if (cached !== undefined) return cached;

    const payload = await this.client.get("products/departments");
    const parsed = parseResponse(departmentsResponseSchema, payload, "/products/departments");
    const departments = parsed.map(toDepartment);
    if (departments.length > 0) {
      this.departments = departments;
      this.categoryIndex = buildCategoryIndex(departments);
    }
    return departments;
  }

  async findStores(query: string | undefined): Promise<StoreSearchResult> {
    const payload = await this.client.get("addresses/pickup-addresses");
    const parsed = parseResponse(
      pickupAddressesResponseSchema,
      payload,
      "/addresses/pickup-addresses",
    );
    const stores = toStores(parsed.storeAreas);
    const needle = query?.trim().toLowerCase();
    const matched =
      needle === undefined
        ? stores
        : stores.filter(
            (store) =>
              store.name.toLowerCase().includes(needle) ||
              store.address.toLowerCase().includes(needle),
          );
    return {
      stores: matched,
      ...toCoverage(matched.length, matched.length, 1, "pick-up locations", ""),
    };
  }

  private async productQuery(
    endpoint: string,
    page: number,
    sort: SortOption,
    query: Readonly<Record<string, QueryValue>>,
    path = "products",
  ): Promise<SearchResult> {
    const payload = await this.client.get(path, query);
    const parsed = parseResponse(searchResponseSchema, payload, endpoint);
    const { products, skippedTypes, rejections } = partitionSearchItems(parsed.products.items);

    for (const rejection of rejections) {
      console.error(`[woolies-mcp] dropped an unparseable product from ${endpoint} — ${rejection}`);
    }
    const unknownTiles = skippedTypes.filter((type) => !KNOWN_TILE_TYPES.has(type));
    if (unknownTiles.length > 0) {
      console.error(`[woolies-mcp] unrecognised result tile types: ${unknownTiles.join(", ")}`);
    }

    const mapped = products.map(toCompactProduct);
    const matchesAvailable = parsed.products.totalItems;
    const coverage =
      mapped.length === 0 && page > 1 && matchesAvailable > 0
        ? toEmptyPageCoverage(page, matchesAvailable, "products")
        : toCoverage(mapped.length, matchesAvailable, page, "products", REFINE_PRODUCTS);

    return {
      ...coverage,
      products: mapped,
      matchesAvailable,
      sort: parsed.currentSortOption ?? sort,
      categoryCounts: toCategoryCounts(parsed.dasFacets, await this.readCategoryIndex()),
    };
  }

  /**
   * The index that turns facet ids into browse slugs. Built from the department tree, which is
   * fetched once; if that fetch fails the counts are still returned, just without slugs.
   */
  private async readCategoryIndex(): Promise<CategoryIndex | undefined> {
    const cached = this.categoryIndex;
    if (cached !== undefined) return cached;
    try {
      await this.listCategories();
    } catch (error: unknown) {
      console.error("[woolies-mcp] category slugs unavailable for this result:", error);
      return undefined;
    }
    return this.categoryIndex;
  }

  /**
   * Fetches a product's label photo as raw bytes. The image host is a CDN outside the API, so it
   * takes no API headers; it still goes through the session for the throttle.
   */
  async getProductImage(sku: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const detail = await this.getProduct(sku);
    const url = detail.imageUrls[0];
    if (url === undefined) {
      throw new Error(`Woolworths publishes no image for SKU ${sku}.`);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`Label image for SKU ${sku} returned HTTP ${response.status}.`);
    }
    const mimeType = response.headers.get("content-type") ?? "image/jpeg";
    return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType };
  }

  async getProduct(sku: string): Promise<ProductDetail> {
    const payload = await this.client.get(`products/${encodeURIComponent(sku)}`);
    return toProductDetail(parseResponse(productDetailSchema, payload, `/products/${sku}`));
  }

  async findSuburbs(query: string): Promise<readonly SuburbMatch[]> {
    const payload = await this.client.get("suburbs", { query });
    const parsed = parseResponse(suburbsResponseSchema, payload, "/suburbs");
    return parsed.suburbResults.map((result) => ({ id: result.id, name: result.text }));
  }

  async getFulfilment(): Promise<Fulfilment> {
    const payload = await this.client.get("shell");
    return toFulfilment(parseResponse(fulfilmentContextSchema, payload, "/shell"));
  }

  /**
   * Resolves a suburb name and, when it is unambiguous, switches the session to it.
   *
   * The PUT answers with the new fulfilment context, but the confirmation reads `/shell`
   * afterwards so the reported location is the one a later search will actually use.
   */
  async setLocation(suburb: string): Promise<SetLocationOutcome> {
    const matches = await this.findSuburbs(suburb);
    if (matches.length === 0) return { kind: "notFound" };

    const chosen = matches.length === 1 ? matches[0] : exactMatch(matches, suburb);
    if (chosen === undefined) return { kind: "ambiguous", matches };

    await this.client.put(`fulfilment/my/suburbs/${chosen.id}`);
    const requested = suburb.trim().toLowerCase();
    return {
      kind: "set",
      suburb: chosen,
      fulfilment: await this.getFulfilment(),
      interpretedAs: chosen.name.trim().toLowerCase() === requested ? undefined : chosen.name,
    };
  }

  async getAccountStatus(): Promise<AccountStatus> {
    const payload = await this.client.get("shell");
    return toAccountStatus(parseResponse(shopperContextSchema, payload, "/shell"));
  }

  /**
   * Confirmed sign-in is cached briefly so a burst of cart writes costs one /shell call rather
   * than one per write. The window is safe because `onAccountEndpoint` drops the cache on the
   * first 401: a session that dies mid-window costs one failed call, which reports correctly,
   * rather than a minute of wrong answers.
   */
  private signedInUntilMs = Number.NEGATIVE_INFINITY;
  private cachedStatus: AccountStatus | undefined;

  invalidateSignedIn(): void {
    this.signedInUntilMs = Number.NEGATIVE_INFINITY;
    this.cachedStatus = undefined;
  }

  async requireSignedIn(): Promise<AccountStatus> {
    const cached = this.cachedStatus;
    if (cached !== undefined && this.now() < this.signedInUntilMs) return cached;
    const status = await this.confirmSignedIn();
    this.cachedStatus = status;
    this.signedInUntilMs = this.now() + SIGNED_IN_TTL_MS;
    return status;
  }

  /**
   * Runs an account operation, turning the site's 401 into the message that says what to do.
   *
   * A 401 means this session is no longer honoured. The cached status is dropped so the next
   * call re-checks instead of trusting the window, and the raw "Ooops looks like you cant
   * perform that action" is replaced by the sign-in instructions. Not a session rejection in the
   * `client.ts` sense: re-bootstrapping produces an anonymous session, which is what 401s.
   */
  private async accountGet(path: string, query: Readonly<Record<string, QueryValue>> = {}) {
    return this.onAccountEndpoint(() => this.client.get(path, query));
  }

  private async accountPost(path: string, body: unknown) {
    return this.onAccountEndpoint(() => this.client.post(path, body));
  }

  private async onAccountEndpoint<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error: unknown) {
      if (error instanceof WoolworthsApiError && error.status === UNAUTHORIZED) {
        this.invalidateSignedIn();
        throw new NotSignedInError({ cause: error });
      }
      throw error;
    }
  }

  private async confirmSignedIn(): Promise<AccountStatus> {
    const status = await this.getAccountStatus();
    if (status.signedIn) return status;

    const outcome = await this.authenticator.signIn(false);
    if (outcome.kind !== "alreadySignedIn") throw new NotSignedInError();
    return status;
  }

  async getCart(): Promise<Cart> {
    await this.requireSignedIn();
    const payload = await this.accountGet("trolleys/my");
    const parsed = parseResponse(trolleyResponseSchema, payload, "/trolleys/my");
    const lines = toCartLines(parsed.items.flatMap((group) => group.products));
    const totals = parsed.context.basketTotals;
    return {
      lines,
      lineCount: totals.totalItems,
      totalQuantity: totals.totalItemQuantity,
      totals: toCartTotals(totals),
    };
  }

  /**
   * Sets one line to an absolute quantity; zero removes it. Add, update and remove are the same
   * upstream call, so they cannot drift apart.
   *
   * Payload shape is from captured signed-in traffic: a single object, not a list, carrying
   * `pricingUnit` ("Each" or "Kg") and `adId`. Decimal quantities are legal for Kg lines.
   */
  async setCartQuantity(
    sku: string,
    quantity: number,
    pricingUnit: PricingUnit,
  ): Promise<CartWriteResult> {
    await this.requireSignedIn();
    const payload = await this.accountPost("trolleys/my/items", {
      sku,
      quantity,
      pricingUnit,
      adId: null,
    });
    const parsed = parseResponse(trolleyWriteResponseSchema, payload, "/trolleys/my/items");
    if (!parsed.isSuccessful) this.invalidateSignedIn();

    // A null line means the write left no line for this sku, which is zero of it in the trolley.
    // The site reports that with isSuccessful true, so it is an outcome, not a failure.
    const line = parsed.itemAdded ?? undefined;
    const appliedQuantity = line?.quantity ?? 0;
    const appliedPricingUnit = optionalText(line?.selectedPurchasingUnit);
    // Falls back to what was asked so an unreported unit cannot read as the site overriding it.
    const comparedPricingUnit = appliedPricingUnit ?? pricingUnit;
    const adjustment = toCartAdjustment(
      quantity,
      appliedQuantity,
      pricingUnit,
      comparedPricingUnit,
      // Only fetched when the site changed something, so the common path stays one call.
      adjustmentDiffers(quantity, appliedQuantity, pricingUnit, comparedPricingUnit)
        ? await this.averageWeightOf(sku)
        : undefined,
    );

    const isRemoval = quantity === 0;
    return {
      sku,
      requestedQuantity: quantity,
      requestedPricingUnit: isRemoval ? undefined : pricingUnit,
      appliedQuantity,
      appliedPricingUnit: isRemoval ? undefined : appliedPricingUnit,
      // Absent, not zero: a null here says the site did not report the trolley's total.
      lineInTrolley: appliedQuantity > 0,
      adjusted: adjustment.adjusted,
      adjustment: adjustment.note,
      trolleyTotalQuantity: parsed.totalItemQuantityInBasket ?? undefined,
      successful: parsed.isSuccessful,
    };
  }

  /** A failure here must not fail the write, which already succeeded; the note degrades instead. */
  private async averageWeightOf(sku: string): Promise<number | undefined> {
    try {
      return (await this.getProduct(sku)).averageWeightPerUnit;
    } catch (error: unknown) {
      console.error(`[woolies-mcp] could not read average unit weight for ${sku}:`, error);
      return undefined;
    }
  }

  /** A removal needs no pricing unit; the site ignores it when the quantity is 0. */
  removeFromCart(sku: string): Promise<CartWriteResult> {
    return this.setCartQuantity(sku, 0, "Each");
  }

  /**
   * Writes several lines in one call. Each is reported separately; a failure on one is returned
   * as a failure for that sku and never removes it from the results.
   */
  async setCartQuantities(
    items: readonly { sku: string; quantity: number; pricingUnit: PricingUnit }[],
  ): Promise<readonly CartWriteOutcome[]> {
    await this.requireSignedIn();
    const outcomes: CartWriteOutcome[] = [];
    for (const item of items) {
      try {
        outcomes.push({
          kind: "written",
          result: await this.setCartQuantity(item.sku, item.quantity, item.pricingUnit),
        });
      } catch (error: unknown) {
        outcomes.push({
          kind: "failed",
          sku: item.sku,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  }

  /**
   * The shopper's previously purchased products, returned as the site's own labelled sections.
   * The sections are never merged: one is real history and one is advertising.
   */
  async getPastPurchases(): Promise<readonly PurchaseSection[]> {
    await this.requireSignedIn();
    const payload = await this.accountGet("products/my/forgotten");
    const parsed = parseResponse(
      forgottenProductsResponseSchema,
      payload,
      "/products/my/forgotten",
    );
    return parsed.products.map(toPurchaseSection);
  }

  /**
   * `orders/my/past` is the base for order-change actions and 404s on GET; the list lives at
   * `shoppers/my/past-orders`.
   */
  async getOrderHistory(): Promise<OrderHistory> {
    await this.requireSignedIn();
    const payload = await this.accountGet("shoppers/my/past-orders");
    const parsed = parseResponse(pastOrdersResponseSchema, payload, "/shoppers/my/past-orders");
    return toOrderHistory(parsed.items, parsed.totalItems);
  }
}

function exactMatch(matches: readonly SuburbMatch[], suburb: string): SuburbMatch | undefined {
  const wanted = suburb.trim().toLowerCase();
  return matches.find((match) => match.name.trim().toLowerCase() === wanted);
}

/** Raised when an account operation is asked for without a usable account. */
export class NotConfiguredError extends Error {}
