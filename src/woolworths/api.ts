import { Authenticator, type SignInOutcome } from "./auth.js";
import { GraphQlCart, UnknownProductError, type CartWriteFacts } from "./graphql-cart.js";
import { multiSearchAlias } from "./graphql-documents.js";
import { GraphQlError, SessionGraphQlTransport } from "./graphql-client.js";
import type { Session } from "./session.js";
import { Throttle } from "./throttle.js";
import {
  categorySearchVariables,
  keywordSearchVariables,
  specialsVariables,
  ORDER_FILTERS,
  PRODUCT_SORTS,
  SPECIAL_FILTERS,
  PRICING_UNITS,
  type DeliveryWindowsVariables,
  type OrderFilter,
  type PricingUnit,
  type ProductSearchVariables,
  type ProductSort,
} from "./graphql-documents.js";
import type { ImportedCookie } from "./session.js";
import {
  toFulfilment,
  type CatalogueProduct,
  type Cart,
  type DeliveryWindows,
  type CategoryNode,
  type ProductDetail,
  type SavedAddress,
  type Store,
  type CartValidationFailure,
  toCartAdjustment,
  toCategoryNode,
  toProductDetail,
  toProductGrid,
  toStore,
  toDeliveryWindows,
  toSavedAddresses,
  toOrderHistory,
  toPurchaseHistory,
  toCoverage,
  toPastPurchases,
  type Coverage,
  type OrderHistory,
  type PurchaseHistory,
  type PastPurchases,
  type Fulfilment,
} from "./mappers.js";
import { detailVariantSchema, type RawDetailVariant, type RawProductPage } from "./schemas.js";

export { PRODUCT_SORTS, SPECIAL_FILTERS };
export type { ProductSort };

/** Kept as the tools' argument name; the values are the site's own sort enum. */
/**
 * The sorts a catalogue tool may be asked for.
 *
 * `FREQUENCY` is not among them: the site rejects it on keyword search, category browse and
 * specials alike with `invalid input value at $searchInput`, so offering it is offering a value
 * that can only ever fail. It remains valid on the personal "Buy it again" list, which sends it
 * itself. `FAVOURITES` is accepted everywhere but was observed to change the order only on
 * specials.
 */
export const SORT_OPTIONS = ["RELEVANCE", "FAVOURITES"] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE = 40;

/**
 * How many orders to ask for. The site ignores `pageIndex`, so this is the whole history it will
 * hand over in one response; anything beyond it is reported as unreachable rather than paged for.
 */
const ORDER_PAGE_SIZE = 100;

/**
 * How many fulfilment windows to list. The site answers a delivery address with every pick-up
 * slot at the nearest store too — 306 windows, 139 KB, observed — which no caller can read.
 */
const DEFAULT_WINDOW_LIMIT = 40;

/** Long enough to cover a burst of cart writes, short enough that a dropped session surfaces fast. */
const SIGNED_IN_TTL_MS = 60_000;

export { PRICING_UNITS, ORDER_FILTERS };
export type { PricingUnit, OrderFilter };

/**
 * Raised when nothing about a product could be read, naming why each variant failed.
 *
 * The two causes are different and the message says which: the site offered no variant at all —
 * a product not ranged at this store — or it offered one whose shape this server does not
 * understand. Reporting either as "no variants" would hide a schema change behind a plausible
 * answer.
 */
export class UndescribableProductError extends Error {
  constructor(sku: string, storeKey: string, rejected: readonly string[]) {
    super(
      rejected.length === 0
        ? `Woolworths returned product ${sku} at store ${storeKey} with no variants, so it states ` +
            "no price, availability or key for it. It is most likely not ranged at that store."
        : `No variant of product ${sku} at store ${storeKey} could be read. The site offered: ` +
            rejected.join(" | "),
    );
    this.name = "UndescribableProductError";
  }
}

/** Raised when the site returns no product for a sku, rather than an empty detail. */
/**
 * One shopper, roughly one request a second. Enforced in the transport so no tool can bypass it.
 */
const MIN_REQUEST_INTERVAL_MS = 1_000;

/** A term certain to match something, used only to read which store the catalogue answers for. */
const STORE_KEY_PROBE = "milk";

/** Raised when a move names an address the account does not hold, rather than moving nowhere. */
export class UnknownAddressError extends Error {
  constructor(addressId: string, known: readonly SavedAddress[]) {
    super(
      `This account has no saved address ${addressId}. It holds: ` +
        `${known.map((address) => `${address.id} (${address.address})`).join("; ") || "(none)"}.`,
    );
    this.name = "UnknownAddressError";
  }
}

/**
 * What this session actually grants, demonstrated rather than inferred.
 *
 * `usable` comes from making a real account call. Nothing here reads a session-state endpoint:
 * such an endpoint has been observed disagreeing with account access in both directions, so only
 * a call that actually needs the account describes whether the account tools work.
 */
export interface AccountAccess {
  readonly usable: boolean;
}

export type CartWriteOutcome =
  | { readonly kind: "written"; readonly result: CartWriteResult }
  | { readonly kind: "failed"; readonly sku: string; readonly reason: string };

export interface CartWriteResult {
  readonly sku: string;
  /** The line a write targets. A product sold both ways has one variant key per pricing. */
  readonly variantKey: string;
  /** What was asked for. */
  readonly requestedQuantity: number;
  /** Absent on a removal: setting a line to 0 has no pricing unit. */
  readonly requestedPricingUnit: PricingUnit | undefined;
  /** What the site actually put in the cart. May differ from the request. */
  readonly appliedQuantity: number;
  /**
   * The unit of the line the cart holds, read from the line itself. Differs from the request when
   * the site put the product under its other pricing. Absent on a removal.
   */
  readonly appliedPricingUnit: string | undefined;
  /** True when the site did not honour the request exactly; `adjustment` then says how. */
  readonly adjusted: boolean;
  readonly adjustment: string | undefined;
  /** Whether the variant has a line in the cart after the write. */
  readonly lineInCart: boolean;
  /**
   * The site's own item count for the whole cart. A weighed line counts once however many
   * kilograms it holds, so this is not a sum of the quantities.
   */
  readonly cartTotalQuantity: number;
  /** Distinct product variants in the cart after the write. */
  readonly cartLineCount: number;
  /** True when the cart cannot be checked out as it stands; `blockers` says why. */
  readonly checkoutBlocked: boolean;
  readonly blockers: readonly CartValidationFailure[];
}

/**
 * Slug form of a department name, matching the slugs `list_categories` returns: "Fruit & Veg"
 * becomes "fruit-veg". Products name their department; the browse tree names both, and the
 * caller is given slugs, so the two are compared in slug form.
 */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Keeps only the products in one department, and says what that cost.
 *
 * The site's search takes no category argument, so this runs over the page already fetched. The
 * report is not optional decoration: without it a filtered page is indistinguishable from a
 * search that genuinely found little, and `matchesAvailable` still counts the unfiltered query.
 */
function filterToDepartment(found: SearchResult, department: string): SearchResult {
  const wanted = toSlug(department);
  const seen = new Set<string>();
  for (const product of found.products) {
    if (product.department !== undefined) seen.add(toSlug(product.department));
  }
  const kept = found.products.filter(
    (product) => product.department !== undefined && toSlug(product.department) === wanted,
  );
  const departmentsSeen = [...seen].sort();
  return {
    ...found,
    products: kept,
    returned: kept.length,
    complete: false,
    coverage:
      `Showing ${kept.length} products in '${department}', kept from the ${found.products.length} ` +
      `on page ${found.page} of an unfiltered search. The site's search takes no category ` +
      `argument, so only this page was examined: matchesAvailable (${found.matchesAvailable ?? "not reported"}) ` +
      `counts the whole unfiltered query, and other pages may hold more in this department. ` +
      `This is NOT the full set. Departments on this page: ` +
      `${departmentsSeen.length === 0 ? "none stated" : departmentsSeen.join(", ")}. ` +
      `To walk a department exhaustively use browse_category with a key from list_categories.`,
    departmentFilter: {
      department,
      examined: found.products.length,
      matched: kept.length,
      departmentsSeen,
    },
  };
}

/** The host Woolworths serves product imagery from, as observed in product detail responses. */
const IMAGE_HOSTS = new Set(["assets.woolworths.com.au"]);

const REFINE_PRODUCTS =
  "request further pages until one comes back short, or use browse_category with a key from " +
  "list_categories, which walks a category exhaustively.";

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

/** Shared by every product listing: search, browse and specials differ only in what they select. */
interface ListingRequest {
  readonly page: number;
  readonly sort: SortOption;
  readonly size?: number | undefined;
}

export interface StoreSearchResult {
  readonly stores: readonly Store[];
  readonly returned: number;
  /**
   * Always false. The site offers no national store list: this is a proximity search around the
   * cart's delivery address, capped at `max`, so no result of it is ever the full set.
   */
  readonly complete: false;
  readonly coverage: string;
}

export interface SearchRequest extends ListingRequest {
  readonly query: string;
  /**
   * Department slug to keep. The site's search accepts no category argument, so this is applied
   * to the fetched page after the fact and the coverage sentence says so.
   */
  readonly department?: string | undefined;
}

/** A category is addressed by the key `list_categories` returns, not by a slug. */
export interface BrowseRequest extends ListingRequest {
  readonly categoryKey: string;
}

export interface SpecialsRequest extends ListingRequest {
  /** Promotion types to include. Defaults to every special. */
  readonly filters?: readonly string[] | undefined;
}

/**
 * `matchesAvailable` is the site's count for the whole query; `products` holds only this page.
 * `categoryCounts[].productCount` is the site's own facet count and does not have to agree with
 * `matchesAvailable` — the two are computed differently upstream — so coverage is always built
 * from `matchesAvailable`, which is what paging actually walks.
 */
export interface SearchResult extends Coverage {
  readonly products: readonly CatalogueProduct[];
  /**
   * Undefined when the site returned a count it could not resolve. The sentinel it uses for that
   * is a negative number, and passing it on as a count would read as a real total.
   */
  readonly matchesAvailable: number | undefined;
  /** Advertising tiles the site mixed into the grid and this server dropped. */
  readonly advertisingExcluded: number;
  /**
   * Products the site returned that this server could not describe. Reported, never hidden: a
   * short page must be distinguishable from a page the site had nothing more on.
   */
  readonly unparsed: readonly string[];
  /** Present only when a `department` was asked for. */
  readonly departmentFilter?: DepartmentFilterReport;
}

export interface DepartmentFilterReport {
  readonly department: string;
  /** Products on this page before the filter ran. */
  readonly examined: number;
  /** Products the filter kept. */
  readonly matched: number;
  /** Department slugs seen on this page, so a slug that matches nothing can be corrected. */
  readonly departmentsSeen: readonly string[];
}

/**
 * The Woolworths operations this server exposes, in domain terms. Everything above this layer
 * deals in compact shapes; everything below it deals in the site's raw JSON.
 */
export class WoolworthsApi {
  private readonly session: Session;
  private readonly authenticator: Authenticator;

  /** Every GraphQL operation. One session, one cookie jar, one request at a time. */
  private readonly cart: GraphQlCart;

  constructor(
    session: Session,
    authenticator: Authenticator,
    now: () => number = Date.now,
    cart?: GraphQlCart,
  ) {
    this.session = session;
    this.authenticator = authenticator;
    this.cart =
      cart ??
      new GraphQlCart(
        new SessionGraphQlTransport(session, new Throttle(MIN_REQUEST_INTERVAL_MS)),
        SIGNED_IN_TTL_MS,
        now,
      );
  }

  /** Signs in if the session is anonymous, and reports the outcome either way. */
  async signIn(): Promise<SignInOutcome> {
    return this.authenticator.signIn((await this.checkAccountAccess()).usable);
  }

  /**
   * Adopts a session captured by a real browser sign-in (`npm run login`).
   *
   * This is how the server becomes signed in: Auth0 challenges non-browser clients with Turnstile,
   * so a person signs in and hands the result over. Returns the signed-in state afterwards, so the
   * caller learns whether the handover actually worked rather than assuming it did.
   */
  async importSession(cookies: readonly ImportedCookie[]): Promise<AccountAccess> {
    await this.session.importCookies(cookies);
    this.invalidateSignedIn();
    return this.checkAccountAccess();
  }

  /**
   * Whether the account tools will actually work, established by making an account call rather
   * than by reading any session-state endpoint.
   *
   * The probe is the GraphQL cart read: it is the access every account tool needs, and the one
   * call that also proves the site is not answering as a guest.
   */
  async checkAccountAccess(): Promise<AccountAccess> {
    const usable = await this.cart.isUsable();
    return { usable };
  }

  /** The session cookie's stated `Expires` date: an upper bound, not proof the session works. */
  cookieExpiry(): Promise<Date | undefined> {
    return this.session.cookieExpiry();
  }

  /**
   * Searches the catalogue. One upstream operation serves search, browse and specials; the input
   * selector distinguishes them, not the operation name the site tags them all with.
   */
  async searchProducts(request: SearchRequest): Promise<SearchResult> {
    const found = await this.productQuery(
      keywordSearchVariables(
        request.query,
        request.page,
        request.size ?? DEFAULT_PAGE_SIZE,
        request.sort,
      ),
      request.page,
    );
    const wanted = request.department?.trim();
    if (wanted === undefined || wanted === "") return found;
    return filterToDepartment(found, wanted);
  }

  /** Browses a category by the key `list_categories` returns. */
  async browseCategory(request: BrowseRequest): Promise<SearchResult> {
    return this.productQuery(
      categorySearchVariables(
        request.categoryKey,
        request.page,
        request.size ?? DEFAULT_PAGE_SIZE,
        request.sort,
      ),
      request.page,
    );
  }

  /**
   * What is on special, optionally narrowed to a promotion type.
   *
   * With no filter every promotion type is sent, which is what the site's own "Specials" page
   * does. `SPECIALS` is a sibling type, not a superset: asking for it alone reported 5132 of the
   * 6644 the full set reported, so defaulting to it would drop every half-price, multibuy,
   * member-price and online-only item not also tagged `SPECIALS`.
   */
  async getSpecials(request: SpecialsRequest): Promise<SearchResult> {
    return this.productQuery(
      specialsVariables(
        request.page,
        request.size ?? DEFAULT_PAGE_SIZE,
        request.sort,
        request.filters ?? SPECIAL_FILTERS,
      ),
      request.page,
    );
  }

  /**
   * Runs one catalogue query and describes what came back.
   *
   * Neither `pageSize` nor `currentPage` is used to describe the page: the site echoes the number
   * of rows returned rather than the size asked for, and `currentPage` reads -1 on an empty
   * result. The requested page is passed in instead.
   */
  private async productQuery(
    variables: ProductSearchVariables,
    page: number,
  ): Promise<SearchResult> {
    return this.describeGrid((await this.cart.searchProducts(variables)).My.products, page);
  }

  /** Turns one page envelope into a described result. Shared by the single and batched searches. */
  private describeGrid(raw: RawProductPage, page: number): SearchResult {
    const grid = toProductGrid(raw);
    if (grid.rejections.length > 0) {
      console.error(
        `[woolies-mcp] ${grid.rejections.length} catalogue product(s) did not parse: ` +
          grid.rejections.join(" | "),
      );
    }
    return {
      ...toCoverage({
        returned: grid.products.length,
        matchesAvailable: raw.totalCount,
        page,
        noun: "products",
        refinement: REFINE_PRODUCTS,
        unparsed: grid.rejections.length,
      }),
      products: grid.products,
      advertisingExcluded: grid.advertisingExcluded,
      unparsed: grid.rejections,
    };
  }

  /**
   * Runs several searches, each reported with its own coverage.
   *
   * One request carrying every query, not one request per query. `My.products` aliases, so the
   * router answers them together; the throttle spaces requests a second apart, which made the
   * sequential form cost a second per query.
   */
  async searchMany(
    queries: readonly string[],
    request: Omit<SearchRequest, "query">,
  ): Promise<readonly { readonly query: string; readonly result: SearchResult }[]> {
    if (queries.length === 0) return [];
    const data = await this.cart.searchManyProducts(
      queries,
      request.page,
      request.size ?? DEFAULT_PAGE_SIZE,
      request.sort,
    );
    return queries.map((query, index) => {
      const page = data.My[multiSearchAlias(index)];
      // The aliases are generated from this same list, so one missing is the site answering a
      // query it was asked and this server not seeing it — never quietly an empty result.
      if (page === undefined) {
        throw new Error(
          `Woolworths answered ${Object.keys(data.My).length} of the ${queries.length} searches ` +
            `sent in one request; nothing came back under '${multiSearchAlias(index)}' for ` +
            `"${query}". None of these results can be trusted to match their query.`,
        );
      }
      return { query, result: this.describeGrid(page, request.page) };
    });
  }

  /**
   * The browse tree.
   *
   * One node comes back — the root with no key, or the node named by one — and `depth` bounds how
   * far below it is listed. The site always sends all four levels, 773 nodes of them, so the
   * bound is applied here; a node whose children were cut reports how many it has.
   */
  async listCategories(categoryKey?: string, depth = 1): Promise<CategoryNode> {
    const data = await this.cart.listCategories(categoryKey);
    return toCategoryNode(data.My.categories, depth);
  }

  /**
   * Pick-up locations near where the cart is being delivered, nearest first.
   *
   * The site's own search by name alone returned nothing; the one that worked carried
   * coordinates, so this searches by position and filters by name afterwards.
   */
  async findStores(query: string | undefined, max = 20): Promise<StoreSearchResult> {
    const coordinates = await this.deliveryCoordinates();
    const data = await this.cart.searchLocations(query ?? "", max, coordinates);
    const stores = data.locations.locations.map(toStore);
    const wanted = query?.trim().toLowerCase();
    const matched =
      wanted === undefined || wanted === ""
        ? stores
        : stores.filter((store) =>
            `${store.name} ${store.address ?? ""} ${store.suburb ?? ""}`
              .toLowerCase()
              .includes(wanted),
          );
    return {
      stores: matched,
      returned: matched.length,
      complete: false,
      coverage:
        `Showing ${matched.length} of the ${stores.length} pick-up locations the site returned ` +
        `nearest this cart's delivery address, at most ${max}. A proximity search, not the full ` +
        `list of stores: a location's absence here is not evidence it does not exist.`,
    };
  }

  /**
   * One product in full.
   *
   * `storeKey` is required upstream because price and availability are per store. It is read from
   * a catalogue result rather than assumed.
   */
  async getProduct(sku: string): Promise<ProductDetail> {
    const storeKey = await this.storeKey();
    const data = await this.cart.getProductDetail([sku], storeKey);
    const product = data.products[0];
    // The transport raises UnknownProductError for a key the site cannot resolve, so an empty
    // list here would be the site answering with a product-shaped nothing.
    if (product === undefined) throw new UnknownProductError([sku], storeKey);

    // A variant that does not parse is described, never dropped in silence: skipping it quietly
    // turns a shape change into "this product has no variants", which reads as a real answer.
    const variants: RawDetailVariant[] = [];
    const rejected: string[] = [];
    for (const raw of product.variants) {
      const parsed = detailVariantSchema.safeParse(raw);
      if (parsed.success) {
        variants.push(parsed.data);
        continue;
      }
      const typename = typeof raw.__typename === "string" ? raw.__typename : "<no __typename>";
      rejected.push(
        `${typename}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
          .join("; ")}`,
      );
    }
    if (variants.length === 0) throw new UndescribableProductError(sku, storeKey, rejected);
    if (rejected.length > 0) {
      console.error(
        `[woolies-mcp] ${rejected.length} variant(s) of ${sku} did not parse: ${rejected.join(" | ")}`,
      );
    }
    return toProductDetail(product, variants, storeKey);
  }

  /**
   * Fetches one product image so it can be shown rather than linked.
   *
   * Restricted to the site's own asset hosts: the URL comes from a site response, and a server
   * that will fetch any URL a response names is a server that can be pointed anywhere.
   */
  async fetchImage(url: string): Promise<{ readonly base64: string; readonly mimeType: string }> {
    const target = new URL(url);
    if (!IMAGE_HOSTS.has(target.hostname)) {
      throw new Error(
        `Refusing to fetch ${target.hostname}: product images are only fetched from ` +
          `${[...IMAGE_HOSTS].join(", ")}.`,
      );
    }
    const response = await this.session.fetch(target);
    if (!response.ok) {
      throw new Error(`Woolworths returned HTTP ${response.status} for the image at ${url}.`);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (mimeType === undefined || mimeType === "" || !mimeType.startsWith("image/")) {
      throw new Error(
        `The asset at ${url} is not an image: the site served it as ` +
          `${mimeType ?? "no content type at all"}.`,
      );
    }
    return {
      base64: Buffer.from(await response.arrayBuffer()).toString("base64"),
      mimeType,
    };
  }

  /**
   * The store the catalogue answers for.
   *
   * Discovered from a catalogue result rather than assumed: it is absent from the cart until a
   * delivery window is chosen, and guessing it would price against the wrong store in silence.
   */
  private cachedStoreKey: string | undefined;

  /**
   * Discards the cached store key. Moving the cart moves the store that prices it, and a key held
   * across the move would price every later product detail against the store just left.
   */
  private forgetStoreKey(): void {
    this.cachedStoreKey = undefined;
  }

  private async storeKey(): Promise<string> {
    const cached = this.cachedStoreKey;
    if (cached !== undefined) return cached;
    const data = await this.cart.searchProducts(
      keywordSearchVariables(STORE_KEY_PROBE, 1, 1, "RELEVANCE"),
    );
    const found = toProductGrid(data.My.products).products[0]?.storeKey;
    if (found === undefined) {
      throw new Error(
        `Could not establish which store the catalogue answers for: a search for ` +
          `"${STORE_KEY_PROBE}" returned no product to read it from. Product detail is per store, ` +
          "so it is not fetched without one.",
      );
    }
    this.cachedStoreKey = found;
    return found;
  }

  private async deliveryCoordinates(): Promise<{
    readonly latitude: number;
    readonly longitude: number;
  }> {
    const coordinates = (await this.cart.read()).raw.shoppingMode.deliveryAddress?.coordinates;
    if (coordinates === null || coordinates === undefined) {
      throw new Error(
        "The cart has no delivery address, so there is nowhere to search near. Set one with set_location.",
      );
    }
    return coordinates;
  }

  /**
   * The delivery location this session is shopping from; every price answer is for it.
   *
   * Read from the cart, which proves whose session it is on the same request.
   */
  async getFulfilment(): Promise<Fulfilment> {
    return toFulfilment((await this.cart.read()).raw, await this.storeKey());
  }

  /** Drops the cached proof of identity, so the next account call re-establishes it. */
  invalidateSignedIn(): void {
    this.cart.forgetIdentity();
  }

  /**
   * Reads the signed-in cart.
   *
   * The read proves on the same request that the cart belongs to the signed-in shopper.
   * `/api/graphql` answers an unauthenticated caller with an empty *guest* cart at HTTP 200 and no
   * error, so without that proof an expired session reads as "your cart is empty".
   */
  async getCart(): Promise<Cart> {
    return (await this.cart.read()).cart;
  }

  /**
   * Sets one product's line to an absolute quantity; zero removes it.
   *
   * The write targets a variant key (`<sku>-EA` or `<sku>-KG`), not a sku, and zeroes the other
   * pricing of the same product in the same mutation: a product sold both by weight and by the
   * item has one line per pricing, so without that a switch between them would leave both.
   */
  async setCartQuantity(
    sku: string,
    quantity: number,
    pricingUnit: PricingUnit,
  ): Promise<CartWriteResult> {
    return await this.describeWrite(
      quantity,
      pricingUnit,
      await this.cart.setQuantity(sku, quantity, pricingUnit),
    );
  }

  /** Removes every line for a sku, whichever pricing the cart holds it under. */
  async removeFromCart(sku: string): Promise<CartWriteResult> {
    return await this.describeWrite(0, "EACH", await this.cart.remove(sku, "EACH"));
  }

  /**
   * Sets several products' lines in one mutation, which is how the site's own frontend batches
   * them.
   *
   * The batch shares one outcome: the site applies the whole list or rejects it, so a rejection is
   * reported against every requested sku rather than leaving the caller to guess which landed.
   */
  async setCartQuantities(
    items: readonly { sku: string; quantity: number; pricingUnit: PricingUnit }[],
  ): Promise<readonly CartWriteOutcome[]> {
    let written: readonly CartWriteFacts[];
    try {
      written = await this.cart.setQuantities(items);
    } catch (error: unknown) {
      // Only a rejection of the mutation itself means the cart is untouched. Anything else — a
      // dead session, a cart key that did not match, a response this server could not read —
      // happens around a write that may already have landed, and saying "nothing was changed"
      // about it would invite the caller to send it again.
      if (!(error instanceof GraphQlError)) throw error;
      const reason =
        `The batch was rejected as a whole, so no item in it was written. The site gave one ` +
        `reason for the batch, which does not name which item caused it: ${error.message}`;
      return items.map((item) => ({ kind: "failed" as const, sku: item.sku, reason }));
    }
    const outcomes: CartWriteOutcome[] = [];
    for (const [index, facts] of written.entries()) {
      const item = items[index];
      // Both lists are built from the same array, so an index always has an item.
      if (item === undefined) throw new Error("Cart write results did not match the request.");
      outcomes.push({
        kind: "written",
        result: await this.describeWrite(item.quantity, item.pricingUnit, facts),
      });
    }
    return outcomes;
  }

  /**
   * Turns what the site did into what the caller is told, naming any substitution.
   *
   * A variant the cart does not hold after the write is a quantity of zero: the mutation returns
   * every line, so its absence from that list is the cart's answer, not a gap in reporting.
   */
  private async describeWrite(
    requestedQuantity: number,
    requestedPricingUnit: PricingUnit,
    facts: CartWriteFacts,
  ): Promise<CartWriteResult> {
    const appliedQuantity = facts.appliedQuantity ?? 0;
    // With no line in the cart there is no unit to observe, so the request's own unit is used to
    // word the comparison. That cannot invent a substitution: with nothing held, the only
    // difference the note can report is the quantity, which is the zero above.
    const appliedPricingUnit = facts.appliedPricingUnit ?? requestedPricingUnit;
    const adjustment = toCartAdjustment(
      requestedQuantity,
      appliedQuantity,
      requestedPricingUnit,
      appliedPricingUnit,
      // Only fetched when the site changed something, so the common path stays one call.
      adjustmentDiffers(
        requestedQuantity,
        appliedQuantity,
        requestedPricingUnit,
        appliedPricingUnit,
      )
        ? await this.quantityIncrementOf(facts.sku)
        : undefined,
    );
    const isRemoval = requestedQuantity === 0;
    return {
      sku: facts.sku,
      variantKey: facts.variantKey,
      requestedQuantity,
      requestedPricingUnit: isRemoval ? undefined : requestedPricingUnit,
      appliedQuantity,
      appliedPricingUnit: isRemoval ? undefined : appliedPricingUnit,
      adjusted: adjustment.adjusted,
      adjustment: adjustment.note,
      lineInCart: appliedQuantity > 0,
      cartTotalQuantity: facts.cartTotalQuantity,
      cartLineCount: facts.cartLineCount,
      checkoutBlocked: facts.checkoutBlocked,
      blockers: facts.blockers,
    };
  }

  /**
   * The step this product is sold in, used only to word an adjustment note.
   *
   * A failure here must not fail the write, which has already happened upstream: the quantity is
   * in the cart either way, and throwing would report a completed write as a failed one. The note
   * loses its explanation and the adjustment itself is still reported in full.
   */
  private async quantityIncrementOf(sku: string): Promise<number | undefined> {
    try {
      return (await this.getProduct(sku)).quantityIncrement;
    } catch (error: unknown) {
      console.error(`[woolies-mcp] could not read the quantity step for ${sku}:`, error);
      // eslint-disable-next-line no-restricted-syntax -- throwing would fail an already-applied write.
      return undefined;
    }
  }

  /**
   * The shopper's previously purchased products, returned as the site's own labelled sections.
   * The sections are never merged: one is real history and one is advertising.
   */
  async getBuyItAgain(page = 1, pageSize = DEFAULT_PAGE_SIZE): Promise<PastPurchases> {
    const data = await this.cart.searchPastPurchases(page, pageSize);
    const mapped = toPastPurchases(data.My.products, page);
    if (mapped.rejections.length > 0) {
      console.error(
        `[woolies-mcp] ${mapped.rejections.length} previously purchased product(s) did not parse: ` +
          mapped.rejections.join(" | "),
      );
    }
    // The mapper's own coverage is kept: it refuses the completeness claim the generic builder
    // would make, because this list is the retailer's selection rather than the full history.
    // `rejections` is for the server log above, not for the caller.
    return {
      returned: mapped.returned,
      matchesAvailable: mapped.matchesAvailable,
      page: mapped.page,
      complete: mapped.complete,
      coverage: mapped.coverage,
      products: mapped.products,
      advertisingExcluded: mapped.advertisingExcluded,
    };
  }

  /** The account's saved delivery addresses, and which one the cart is using. */
  async listAddresses(): Promise<readonly SavedAddress[]> {
    return toSavedAddresses((await this.cart.listAddresses()).me?.addresses ?? []);
  }

  /**
   * Moves the cart to one of the account's saved delivery addresses.
   *
   * Only an address the account already holds: this cannot invent a location, and it books
   * nothing — the site clears any chosen window and asks for a new one, which the returned
   * fulfilment reports.
   */
  async setLocation(deliveryAddressId: string): Promise<Fulfilment> {
    const known = await this.listAddresses();
    if (!known.some((address) => address.id === deliveryAddressId)) {
      throw new UnknownAddressError(deliveryAddressId, known);
    }
    const moved = (await this.cart.setShoppingMode(deliveryAddressId)).setCartShoppingMode;
    this.forgetStoreKey();
    return toFulfilment(moved, await this.storeKey());
  }

  /**
   * The delivery and pick-up windows offered where the cart is being delivered, or at a pick-up
   * location.
   *
   * A read. Choosing a window is `setCartFulfilment`, which is deliberately unbound: this server
   * fills a cart and a person finishes the shop.
   */
  async getDeliveryWindows(
    options: {
      readonly locationId?: string;
      readonly availableOnly?: boolean;
      readonly method?: string;
      readonly limit?: number;
    } = {},
  ): Promise<DeliveryWindows> {
    const variables = await this.deliveryWindowsFor(options.locationId);
    const data = await this.cart.searchDeliveryWindows(variables);
    return toDeliveryWindows(
      data.propositions.propositions,
      options.availableOnly ?? true,
      options.method,
      options.limit ?? DEFAULT_WINDOW_LIMIT,
    );
  }

  /**
   * Where to ask about windows. With no pick-up location the cart's own delivery coordinates are
   * used, so the answer is for where this shop is actually going.
   */
  private async deliveryWindowsFor(
    locationId: string | undefined,
  ): Promise<DeliveryWindowsVariables> {
    if (locationId !== undefined) return { input: { locationId } };
    const coordinates = (await this.cart.read()).raw.shoppingMode.deliveryAddress?.coordinates;
    if (coordinates === null || coordinates === undefined) {
      throw new Error(
        "The cart has no delivery address, so there is nowhere to ask about delivery windows. " +
          "Pass a pick-up locationId, or set a delivery address on the website.",
      );
    }
    return { input: { coordinates } };
  }

  /**
   * The account's orders. `PAST` is completed orders, `ACTIVE` those still in flight; the site
   * offers no other filter value in captured traffic, so no other is exposed.
   *
   * No page is accepted. The site ignores `pageIndex`: asking for page 2 or 3 of a seven-order
   * history returns the same seven orders, so a page argument could only ever mislabel one page
   * as another. What the site will not hand over is reported as unreachable, not paged for.
   */
  async getOrderHistory(
    filter: OrderFilter = "PAST",
    pageSize = ORDER_PAGE_SIZE,
  ): Promise<OrderHistory> {
    const data = await this.cart.searchOrders(1, pageSize, filter);
    return toOrderHistory(data.orders, filter);
  }

  /**
   * What each past order actually contained.
   *
   * Distinct from `getBuyItAgain`: that is a list the retailer curates and orders by frequency,
   * this is the orders themselves. Paged the same way orders are, which is to say not at all.
   */
  async getPurchaseHistory(
    filter: OrderFilter = "PAST",
    pageSize = ORDER_PAGE_SIZE,
  ): Promise<PurchaseHistory> {
    const data = await this.cart.searchOrderLineItems(1, pageSize, filter);
    return toPurchaseHistory(data.orders, filter);
  }
}

/** Raised when an account operation is asked for without a usable account. */
export class NotConfiguredError extends Error {}
