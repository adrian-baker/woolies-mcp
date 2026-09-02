import { NotSignedInError } from "./auth.js";
import {
  CART_READ_DOCUMENT,
  CART_READ_OPERATION,
  CART_WRITE_DOCUMENT,
  CART_WRITE_OPERATION,
  ADDRESSES_DOCUMENT,
  CATEGORIES_DOCUMENT,
  CATEGORIES_OPERATION,
  LOCATIONS_DOCUMENT,
  LOCATIONS_OPERATION,
  PRODUCT_DETAIL_DOCUMENT,
  PRODUCT_DETAIL_OPERATION,
  PRODUCT_SEARCH_DOCUMENT,
  PRODUCT_SEARCH_OPERATION,
  ADDRESSES_OPERATION,
  DELIVERY_WINDOWS_DOCUMENT,
  DELIVERY_WINDOWS_OPERATION,
  ORDERS_DOCUMENT,
  ORDERS_OPERATION,
  SET_SHOPPING_MODE_DOCUMENT,
  SET_SHOPPING_MODE_OPERATION,
  PAST_PURCHASES_DOCUMENT,
  PAST_PURCHASES_OPERATION,
  PURCHASE_HISTORY_DOCUMENT,
  PURCHASE_HISTORY_OPERATION,
  cartWriteVariables,
  locationsVariables,
  ordersVariables,
  setShoppingModeVariables,
  multiSearchDocument,
  multiSearchVariables,
  pastPurchasesVariables,
  pricingUnitFromVariantKey,
  variantKeyFor,
  variantKeysFor,
  type CartLineItemQuantityUpdate,
  type DeliveryWindowsVariables,
  type OrderFilter,
  type ProductSearchVariables,
  type ProductSort,
  type PricingUnit,
} from "./graphql-documents.js";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { GRAPHQL_ENDPOINT, type GraphQlTransport } from "./graphql-client.js";
import { z } from "zod";
import {
  addressesResponseSchema,
  cartReadResponseSchema,
  cartWriteResponseSchema,
  categoriesResponseSchema,
  locationsResponseSchema,
  ordersResponseSchema,
  pastPurchasesResponseSchema,
  productDetailResponseSchema,
  multiSearchResponseSchema,
  productSearchResponseSchema,
  propositionsResponseSchema,
  purchaseHistoryResponseSchema,
  setShoppingModeResponseSchema,
  parseResponse,
  type RawCartWriteLineItem,
  type RawAddressesResponse,
  type RawCategoriesResponse,
  type RawLocationsResponse,
  type RawProductDetailResponse,
  type RawProductSearchResponse,
  type RawCustomerCart,
  type RawOrdersResponse,
  type RawPropositionsResponse,
  type RawSetShoppingModeResponse,
  type RawMultiSearchResponse,
  type RawPastPurchasesResponse,
  type RawPurchaseHistoryResponse,
} from "./schemas.js";
import { toCart, toCartBlockers, type Cart, type CartValidationFailure } from "./mappers.js";

/** The signed-in cart, established by a read that proved `me`. */
interface CartIdentity {
  readonly customerId: string;
  readonly cartKey: string;
  readonly establishedAtMs: number;
}

/** What a write did, before the wording that describes an adjustment is applied. */
export interface CartWriteFacts {
  readonly sku: string;
  readonly variantKey: string;
  /** The line the write left, or undefined when the cart holds no line for that variant. */
  readonly appliedQuantity: number | undefined;
  readonly appliedPricingUnit: PricingUnit | undefined;
  readonly cartTotalQuantity: number;
  readonly cartLineCount: number;
  readonly checkoutBlocked: boolean;
  readonly blockers: readonly CartValidationFailure[];
}

export interface CartReadResult {
  readonly cart: Cart;
  /** The parsed payload, for callers that read a part of it the compact shape does not carry. */
  readonly raw: RawCustomerCart;
  readonly customerId: string;
}

/**
 * Raised when the site cannot resolve a product key. The site answers with a null payload rather
 * than an error, so without this the caller is told the response shape had moved.
 */
export class UnknownProductError extends Error {
  constructor(keys: readonly string[], storeKey: string) {
    super(
      `Woolworths returned no product for ${keys.join(", ")} at store ${storeKey}. Check the sku: ` +
        "the site answers an unresolvable key with an empty payload.",
    );
    this.name = "UnknownProductError";
  }
}

/**
 * Raised when a write's response names a different cart from the one the identity check
 * established. A write that lands in another cart is the failure this whole module exists to
 * prevent, so it is never reported as a successful write.
 */
export class WrongCartError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `The cart write was applied to cart ${actual}, not the signed-in cart ${expected}. ` +
        "Nothing about this write can be trusted: re-check auth_status and re-read the cart.",
    );
    this.name = "WrongCartError";
  }
}

/**
 * The cart, over `/api/graphql`.
 *
 * Two hazards shape this class, both of which return HTTP 200:
 *
 * - `customerCart` has no authentication of its own. An unauthenticated caller is served an empty
 *   *guest* cart under a different key, with no error. Every read therefore selects `me`, which is
 *   banned for guests, and the transport raises that as `NotSignedInError`.
 * - A mutation cannot select `me`. Writes are guarded by the cart key instead: it must match the
 *   key from a read that proved `me`, within `identityTtlMs`.
 */
export class GraphQlCart {
  private readonly transport: GraphQlTransport;
  private readonly now: () => number;
  private readonly identityTtlMs: number;
  private identity: CartIdentity | undefined;

  constructor(transport: GraphQlTransport, identityTtlMs: number, now: () => number = Date.now) {
    this.transport = transport;
    this.identityTtlMs = identityTtlMs;
    this.now = now;
  }

  forgetIdentity(): void {
    this.identity = undefined;
  }

  /**
   * Previously purchased products, most frequent first.
   *
   * `My` is the personalised namespace and is refused to guests, so this read carries the same
   * proof of identity a cart read does and cannot quietly answer with a stranger's history.
   */
  searchPastPurchases(page: number, pageSize: number): Promise<RawPastPurchasesResponse> {
    return this.query(
      PAST_PURCHASES_OPERATION,
      PAST_PURCHASES_DOCUMENT,
      pastPurchasesVariables(page, pageSize),
      pastPurchasesResponseSchema,
    );
  }

  /**
   * The catalogue. `My.products` is session-scoped, so it answers for the store this session is
   * shopping from without being told which.
   */
  searchProducts(variables: ProductSearchVariables): Promise<RawProductSearchResponse> {
    return this.query(
      PRODUCT_SEARCH_OPERATION,
      PRODUCT_SEARCH_DOCUMENT,
      variables,
      productSearchResponseSchema,
    );
  }

  /**
   * Several keyword searches in one request, answered under generated aliases.
   *
   * One request rather than one per query: the throttle spaces requests a second apart, so the
   * sequential form cost a second per query and twenty of them timed clients out.
   */
  searchManyProducts(
    queries: readonly string[],
    page: number,
    pageSize: number,
    sort: ProductSort,
  ): Promise<RawMultiSearchResponse> {
    return this.query(
      PRODUCT_SEARCH_OPERATION,
      multiSearchDocument(queries.length),
      multiSearchVariables(queries, page, pageSize, sort),
      multiSearchResponseSchema,
    );
  }

  /** The browse tree. With no key, the whole tree; with one, that node's subtree. */
  listCategories(categoryKey: string | undefined): Promise<RawCategoriesResponse> {
    return this.query(
      CATEGORIES_OPERATION,
      CATEGORIES_DOCUMENT,
      categoryKey === undefined ? {} : { categoryKey },
      categoriesResponseSchema,
    );
  }

  /**
   * One or more products in full. Price and availability are per store, hence `storeKey`.
   *
   * A key the site cannot resolve is answered with a null payload and no `errors` array — the
   * nulls are named under `extensions.valueCompletion` instead, because `[Product!]!` is
   * non-nullable and one missing entry collapses the whole field. That is "no such product", a
   * normal answer, so it is raised as one rather than as a shape the server could not read.
   */
  async getProductDetail(
    keys: readonly string[],
    storeKey: string,
  ): Promise<RawProductDetailResponse> {
    const data = await this.send(PRODUCT_DETAIL_OPERATION, PRODUCT_DETAIL_DOCUMENT, {
      keys,
      storeKey,
    });
    if (data === null) throw new UnknownProductError(keys, storeKey);
    return parseResponse(
      productDetailResponseSchema,
      data,
      `${GRAPHQL_ENDPOINT} ${PRODUCT_DETAIL_OPERATION}`,
    );
  }

  /** Pick-up locations near a point. */
  searchLocations(
    search: string,
    max: number,
    geolocation: { readonly latitude: number; readonly longitude: number },
  ): Promise<RawLocationsResponse> {
    return this.query(
      LOCATIONS_OPERATION,
      LOCATIONS_DOCUMENT,
      locationsVariables(search, max, geolocation),
      locationsResponseSchema,
    );
  }

  /** The account's saved delivery addresses. `me` is refused to guests, so this proves the session. */
  async listAddresses(): Promise<RawAddressesResponse> {
    const parsed = await this.query(
      ADDRESSES_OPERATION,
      ADDRESSES_DOCUMENT,
      {},
      addressesResponseSchema,
    );
    if (parsed.me === null) {
      this.forgetIdentity();
      throw new NotSignedInError();
    }
    return parsed;
  }

  /**
   * Moves the cart to one of the account's saved delivery addresses.
   *
   * Guarded by the cart key like every other write: the response must name the cart a proven read
   * established, so a move cannot land in a guest's cart.
   */
  async setShoppingMode(deliveryAddressId: string): Promise<RawSetShoppingModeResponse> {
    const identity = await this.requireIdentity();
    const parsed = await this.query(
      SET_SHOPPING_MODE_OPERATION,
      SET_SHOPPING_MODE_DOCUMENT,
      setShoppingModeVariables(deliveryAddressId),
      setShoppingModeResponseSchema,
    );
    if (parsed.setCartShoppingMode.key !== identity.cartKey) {
      this.forgetIdentity();
      throw new WrongCartError(identity.cartKey, parsed.setCartShoppingMode.key);
    }
    return parsed;
  }

  /** The delivery and pick-up windows offered for a location. A read; nothing here books one. */
  searchDeliveryWindows(variables: DeliveryWindowsVariables): Promise<RawPropositionsResponse> {
    return this.query(
      DELIVERY_WINDOWS_OPERATION,
      DELIVERY_WINDOWS_DOCUMENT,
      variables,
      propositionsResponseSchema,
    );
  }

  /** What each order contained. Selects `lineItems`, which the site's own `Orders` does not. */
  searchOrderLineItems(
    page: number,
    pageSize: number,
    filter: OrderFilter,
  ): Promise<RawPurchaseHistoryResponse> {
    return this.query(
      PURCHASE_HISTORY_OPERATION,
      PURCHASE_HISTORY_DOCUMENT,
      ordersVariables(page, pageSize, filter),
      purchaseHistoryResponseSchema,
    );
  }

  /** The account's orders. `orders` is refused to guests, as `me` is. */
  searchOrders(page: number, pageSize: number, filter: OrderFilter): Promise<RawOrdersResponse> {
    return this.query(
      ORDERS_OPERATION,
      ORDERS_DOCUMENT,
      ordersVariables(page, pageSize, filter),
      ordersResponseSchema,
    );
  }

  /** Reads the cart, proving on the same request that it is the signed-in shopper's. */
  async read(): Promise<CartReadResult> {
    const raw = await this.readRaw();
    return { cart: toCart(raw.cart), raw: raw.cart, customerId: raw.customerId };
  }

  /**
   * Whether the cart tools will work right now, demonstrated by reading the cart rather than by
   * reading a proxy for it.
   */
  async isUsable(): Promise<boolean> {
    try {
      await this.readRaw();
      return true;
    } catch (error: unknown) {
      if (error instanceof NotSignedInError) return false;
      throw error;
    }
  }

  /**
   * Sets one product's line to an absolute quantity in the given pricing unit.
   *
   * The other pricing of the same product is zeroed in the same mutation. A product sold both by
   * weight and by the item has one line per pricing, and without this "2 Each" of something the
   * cart holds by weight would add a second line rather than change the one that is there.
   */
  setQuantity(sku: string, quantity: number, pricingUnit: PricingUnit): Promise<CartWriteFacts> {
    const target = variantKeyFor(sku, pricingUnit);
    const updates = variantKeysFor(sku).map((variantKey) => ({
      variantKey,
      quantity: variantKey === target ? quantity : 0,
    }));
    return this.applyOne(sku, target, updates);
  }

  /** Removes every line for a sku, whichever pricing it is held under. */
  remove(sku: string, pricingUnit: PricingUnit): Promise<CartWriteFacts> {
    const updates = variantKeysFor(sku).map((variantKey) => ({ variantKey, quantity: 0 }));
    return this.applyOne(sku, variantKeyFor(sku, pricingUnit), updates);
  }

  /**
   * Sets several products' lines in one mutation, which is how the site's own frontend batches.
   *
   * Returns the facts for each requested sku in the order asked. The whole batch shares one
   * outcome: if the mutation is rejected, nothing here reports a write.
   */
  async setQuantities(
    items: readonly {
      readonly sku: string;
      readonly quantity: number;
      readonly pricingUnit: PricingUnit;
    }[],
  ): Promise<readonly CartWriteFacts[]> {
    const updates = items.flatMap((item) => {
      const target = variantKeyFor(item.sku, item.pricingUnit);
      return variantKeysFor(item.sku).map((variantKey) => ({
        variantKey,
        quantity: variantKey === target ? item.quantity : 0,
      }));
    });
    const result = await this.apply(updates);
    return items.map((item) =>
      readFacts(item.sku, variantKeyFor(item.sku, item.pricingUnit), result),
    );
  }

  private async applyOne(
    sku: string,
    variantKey: string,
    updates: readonly CartLineItemQuantityUpdate[],
  ): Promise<CartWriteFacts> {
    return readFacts(sku, variantKey, await this.apply(updates));
  }

  private async apply(updates: readonly CartLineItemQuantityUpdate[]): Promise<WriteResponse> {
    const identity = await this.requireIdentity();
    const parsed = await this.query(
      CART_WRITE_OPERATION,
      CART_WRITE_DOCUMENT,
      cartWriteVariables(updates),
      cartWriteResponseSchema,
    );
    const cart = parsed.setCartLineItemQuantity;
    if (cart.key !== identity.cartKey) {
      this.forgetIdentity();
      throw new WrongCartError(identity.cartKey, cart.key);
    }
    return cart;
  }

  /** A read that proves `me`, refreshed when the cached proof is older than the TTL. */
  private async requireIdentity(): Promise<CartIdentity> {
    const cached = this.identity;
    if (cached !== undefined && this.now() - cached.establishedAtMs < this.identityTtlMs) {
      return cached;
    }
    await this.readRaw();
    const established = this.identity;
    // readRaw sets it or throws; this narrows the type without asserting.
    if (established === undefined) {
      throw new Error("The cart read did not establish an identity.");
    }
    return established;
  }

  /**
   * Sends an operation, dropping the cached identity if the site stops recognising the session.
   *
   * Returns `unknown`. The document's type parameter says what the selection asks for, which is
   * not the same claim as what arrived: the site answers an unresolvable product key with a null
   * payload and no error, so a typed return here would assert a shape over data nothing has
   * checked. Only `parseResponse` establishes the shape.
   *
   * Dropping the identity matters because a read that failed as a guest would otherwise leave the
   * identity from the previous read in place, and the next write would be attempted against a
   * cart the session no longer owns.
   */
  private async send<TResult, TVariables extends object>(
    operation: string,
    document: TypedDocumentNode<TResult, TVariables>,
    variables: TVariables,
  ): Promise<unknown> {
    try {
      return await this.transport.send(operation, document, variables);
    } catch (error: unknown) {
      if (error instanceof NotSignedInError) this.forgetIdentity();
      throw error;
    }
  }

  /**
   * Sends an operation and validates what came back before any other code sees it.
   *
   * The document's type parameter describes what the selection asks for; only this parse
   * establishes that the site sent it. Nothing in this class returns an unvalidated payload.
   */
  private async query<TResult, TVariables extends object>(
    operation: string,
    document: TypedDocumentNode<TResult, TVariables>,
    variables: TVariables,
    schema: Readonly<z.ZodType<TResult>>,
  ): Promise<TResult> {
    const data = await this.send(operation, document, variables);
    return parseResponse(schema, data, `${GRAPHQL_ENDPOINT} ${operation}`);
  }

  private async readRaw(): Promise<{
    readonly cart: RawCustomerCart;
    readonly customerId: string;
  }> {
    const parsed = await this.query(
      CART_READ_OPERATION,
      CART_READ_DOCUMENT,
      {},
      cartReadResponseSchema,
    );
    if (parsed.me === null) {
      this.forgetIdentity();
      // The site answers a guest with an empty cart under a different key and no error; without
      // this the caller would be told the shopper's cart is empty.
      throw new NotSignedInError();
    }
    this.identity = {
      customerId: parsed.me.id,
      cartKey: parsed.customerCart.key,
      establishedAtMs: this.now(),
    };
    return { cart: parsed.customerCart, customerId: parsed.me.id };
  }
}

interface WriteResponse {
  readonly key: string;
  readonly totalItemQuantity: number;
  readonly totalUniqueProductSku: number;
  readonly validationResult: Parameters<typeof toCartBlockers>[0];
  readonly lineItems: readonly RawCartWriteLineItem[];
}

/**
 * What the cart holds for one product after a write.
 *
 * The line is looked for under the key the write asked for and, failing that, under the sku's
 * other pricing. Reading the unit back off the requested key instead would make
 * `appliedPricingUnit` a copy of the request, incapable of ever reporting a substitution — and a
 * line the site put under the other pricing would read as no line at all.
 *
 * An absent line is `undefined`, not zero: the cart holding no line and the site not reporting one
 * are the same observation here — the mutation returns every line, so a variant missing from the
 * list is a variant the cart does not hold. That is a quantity of zero and is reported as such by
 * the caller, which knows whether zero was what it asked for.
 */
function readFacts(sku: string, variantKey: string, cart: WriteResponse): CartWriteFacts {
  const requested = cart.lineItems.find((item) => item.productVariantSku === variantKey);
  const substituted = cart.lineItems.find(
    (item) =>
      item.productVariantSku !== variantKey &&
      variantKeysFor(sku).includes(item.productVariantSku) &&
      item.quantity > 0,
  );
  const held = requested ?? substituted;
  return {
    sku,
    variantKey,
    appliedQuantity: held?.quantity,
    appliedPricingUnit:
      held === undefined ? undefined : pricingUnitFromVariantKey(held.productVariantSku),
    cartTotalQuantity: cart.totalItemQuantity,
    cartLineCount: cart.totalUniqueProductSku,
    checkoutBlocked: !cart.validationResult.isValid,
    blockers: toCartBlockers(cart.validationResult),
  };
}
