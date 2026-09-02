import { parse } from "graphql";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type {
  RawCartReadResponse,
  RawCartWriteResponse,
  RawOrdersResponse,
  RawPastPurchasesResponse,
  RawAddressesResponse,
  RawCategoriesResponse,
  RawLocationsResponse,
  RawProductDetailResponse,
  RawMultiSearchResponse,
  RawProductSearchResponse,
  RawPropositionsResponse,
  RawPurchaseHistoryResponse,
  RawSetShoppingModeResponse,
} from "./schemas.js";

/**
 * The GraphQL documents this server sends, and the variable shapes that go with them.
 *
 * Every field selected here was observed in a captured browser response
 * (`www.woolworths.co.nz-gql.har`). Nothing is selected on the strength of a name in the
 * bundle: an unknown field is rejected by the server, and a field whose shape was never seen
 * cannot be parsed with any confidence about its nulls.
 *
 * `me { id }` is selected alongside `customerCart` because `customerCart` alone has no
 * authentication: an unauthenticated caller receives HTTP 200 and an empty *guest* cart with a
 * different key. `me` is banned for guests and produces an `errors` entry, which is the only
 * loud signal that the cart being read is not the shopper's.
 */

const VALIDATION_RESULT = `
  validationResult {
    isValid
    failedValidations { ruleName message affectedSkus resolution title }
  }`;

const CHECKOUT = `
  checkout { amountToPayAsCents chargeableTotalAsCents loyaltySpendAsCents }`;

const PRICING = `
  pricing {
    orderSubtotal { beforeDiscountAsCents afterDiscountAsCents discountAmountAsCents }
    productSubtotal { beforeDiscountAsCents afterDiscountAsCents discountAmountAsCents }
    total { beforeDiscountAsCents afterDiscountAsCents discountAmountAsCents }
  }`;

const LINE_PRICES = `
  lineTotal { afterDiscountAsCents discountAmountAsCents }
  unitPrice { beforeDiscountAsCents afterDiscountAsCents }`;

/**
 * `variants` is a union with no shared interface in the selection the site itself sends, so each
 * member is spelled out. All five members carry the same three fields.
 */
const PURCHASING_UNITS = `purchasingUnits { unit minimumQty maximumQty incrementQty defaultQty }`;
const VARIANT_MEMBERS = [
  "GroceryVariant",
  "RegulatedVariant",
  "GeneralMerchandiseVariant",
  "MonetaryVariant",
  "NonMerchandiseVariant",
]
  .map((member) => `    ... on ${member} { key name ${PURCHASING_UNITS} }`)
  .join("\n");

export const CART_READ_OPERATION = "CustomerCart";

/**
 * The result types come from the zod schemas rather than from generated ones: the site disables
 * introspection (`INTROSPECTION_DISABLED`), so there is no schema to generate against, and a
 * hand-written one would only re-state these same observations while claiming more authority.
 * The zod parse is what actually holds at runtime; this type says what the parse expects.
 */
export const CART_READ_DOCUMENT: TypedDocumentNode<RawCartReadResponse, EmptyVariables> =
  parse(`query ${CART_READ_OPERATION} {
  me { id }
  customerCart {
    key
    cartState
    totalItemQuantity
    totalUniqueProductSku
    fees { amountAsCents description type }
    shoppingMode {
      mode
      deliveryAddress {
        id
        lines { line1 line2 line3 line4 line5 }
        locality { suburb city state }
        coordinates { latitude longitude }
      }
      pickupLocation { id name }
    }
    fulfilment {
      fulfilmentProposition { storeId method store { storeId name } }
    }
${VALIDATION_RESULT}
${CHECKOUT}
${PRICING}
    lineItems {
      sku
      productVariantSku
      quantity
      canSubstitute
${LINE_PRICES}
      product {
        slug
        brand
        variants {
${VARIANT_MEMBERS}
        }
      }
    }
  }
}`);

export const IDENTITY_OPERATION = "Me";

/**
 * The identity guard on its own, for callers that need to prove a session without reading a cart.
 * `me` is banned for guests, so resolving it is the proof; `customerCart` alone is not, because
 * the site answers an anonymous caller with a guest cart at HTTP 200.
 */
export const IDENTITY_DOCUMENT: TypedDocumentNode<
  { readonly me: { readonly id: string } | null },
  EmptyVariables
> = parse(`query ${IDENTITY_OPERATION} { me { id } }`);

export const CART_WRITE_OPERATION = "SetCartLineItemQuantity";

/**
 * `me` is a Query field and cannot be selected here, so this document carries no identity guard.
 * The write is guarded instead by the cart key: `GraphQlCart.assertSameCart` requires the key in
 * this response to match the key from a read that proved `me`, which a guest cart cannot do.
 */
export const CART_WRITE_DOCUMENT: TypedDocumentNode<RawCartWriteResponse, CartWriteVariables> =
  parse(`mutation ${CART_WRITE_OPERATION}($input: SetCartLineItemQuantitiesInput!) {
  setCartLineItemQuantity(input: $input) {
    key
    totalItemQuantity
    totalUniqueProductSku
${VALIDATION_RESULT}
${CHECKOUT}
${PRICING}
    lineItems {
      sku
      productVariantSku
      quantity
${LINE_PRICES}
    }
  }
}`);

export const PAST_PURCHASES_OPERATION = "PastPurchases";

/**
 * Previously purchased products, most frequently bought first.
 *
 * `results` mixes `ProductSummary` with ad tiles (`GamResultItem`, `ContentInGridResultItem`) that
 * carry entirely different shapes, so only the product member is selected here and the rest are
 * counted and reported rather than mapped. The baseline-filters half of the site's own query is
 * dropped: it exists to populate filter chips this server does not expose.
 */
export const PAST_PURCHASES_DOCUMENT: TypedDocumentNode<
  RawPastPurchasesResponse,
  PastPurchasesVariables
> = parse(`query ${PAST_PURCHASES_OPERATION}($searchInput: CompositeSearchInput!) {
  My {
    products(searchInput: $searchInput) {
      totalCount
      pageSize
      totalPages
      currentPage
      results {
        __typename
        ... on ProductSummary {
          sku
          productName
          brand
          slug
          categoryHierarchyNames { lvl1 }
          variants {
            variantKey
            name
            unitOfMeasure
            availabilityStatus
            variantPrice {
              sellingPrice
              wasPrice
              isSpecial
              cupPrice
              cupUnit
            }
          }
        }
      }
    }
  }
}`);

export interface PastPurchasesVariables {
  readonly searchInput: {
    readonly byBuyAgain: {
      readonly pageIndex: number;
      readonly pageSize: number;
      readonly sortBy: string;
    };
  };
}

/** `pageIndex` is zero-based upstream; every tool in this server counts pages from 1. */
export function pastPurchasesVariables(page: number, pageSize: number): PastPurchasesVariables {
  return {
    searchInput: { byBuyAgain: { pageIndex: page - 1, pageSize, sortBy: "FREQUENCY" } },
  };
}

export const ORDERS_OPERATION = "Orders";

/**
 * Past orders. `inclusiveFilter` selects which set: `PAST` returns completed orders, `ACTIVE`
 * returns those still in flight. Both values are from captured traffic; no other value is known,
 * so the tool exposes only these two.
 */
export const ORDERS_DOCUMENT: TypedDocumentNode<RawOrdersResponse, OrdersVariables> =
  parse(`query ${ORDERS_OPERATION}($input: OrdersInput!) {
  orders(input: $input) {
    totalCount
    totalPages
    pageSize
    currentPage
    results {
      orderNumber
      createdDateTime
      orderStatus
      fulfilmentStatus
      hasInvoice
      isAmendable
      total { afterDiscountInCents }
      fulfilments {
        method
        startTime
        endTime
        fulfilmentLocation { name }
        address { lines { line1 line2 line3 line4 line5 } }
      }
    }
  }
}`);

export const PURCHASE_HISTORY_OPERATION = "OrderLineItems";

/**
 * What each order actually contained.
 *
 * `lineItems` is not selected by the site's own `Orders` document — its order page renders the
 * lines server-side — so this selection was established by probing the schema, which the router
 * validates strictly: an unknown field is rejected by name. `productKey` is the sku;
 * `product` carries only `name` on this type, so nothing else about the product is available here.
 */
export const PURCHASE_HISTORY_DOCUMENT: TypedDocumentNode<
  RawPurchaseHistoryResponse,
  OrdersVariables
> = parse(`query ${PURCHASE_HISTORY_OPERATION}($input: OrdersInput!) {
  orders(input: $input) {
    totalCount
    totalPages
    currentPage
    results {
      orderNumber
      createdDateTime
      orderStatus
      total { afterDiscountInCents }
      lineItems {
        productKey
        quantity
        product { name }
      }
    }
  }
}`);

export const PRODUCT_SEARCH_OPERATION = "ProductSearch";

/**
 * The catalogue. One operation serves search, browse and specials; the input selector decides
 * which — `byKeyword`, `byCategoryKey`, `byProductPromotionSpecials`, `byBuyAgain`, `byPastShop`.
 * The site multiplexes them all under the name `ProductSearch`, so the selector is what identifies
 * the query, not the operation name.
 *
 * `results` mixes `ProductSummary` with advertising (`SponsoredProduct`, `GamResultItem`,
 * `ContentInGridResultItem`) and a `RedirectResultItem`, all with different shapes. Only the
 * product member is selected; the rest are counted and reported.
 */
/** The page selection every catalogue search shares. */
const PRODUCT_PAGE_SELECTION = `
      totalCount
      pageSize
      totalPages
      currentPage
      results {
        __typename
        ... on ProductSummary {
          sku
          productName
          brand
          slug
          storeKey
          categoryHierarchyNames { lvl1 }
          variants {
            variantKey
            name
            unitOfMeasure
            availabilityStatus
            purchaseUnit { unit minimumQty maximumQty incrementQty defaultQty }
            variantPrice { sellingPrice wasPrice savedAmount cupPrice cupUnit isSpecial isClubPrice }
          }
        }
      }`;

export const PRODUCT_SEARCH_DOCUMENT: TypedDocumentNode<
  RawProductSearchResponse,
  ProductSearchVariables
> = parse(`query ${PRODUCT_SEARCH_OPERATION}($searchInput: CompositeSearchInput!) {
  My {
    products(searchInput: $searchInput) {${PRODUCT_PAGE_SELECTION}
    }
  }
}`);

/** The alias one query in a multi-search answers under. Positional, so order is preserved. */
export function multiSearchAlias(index: number): string {
  return `q${index}`;
}

/**
 * Several keyword searches in one request, each under its own alias.
 *
 * The site's own frontend sends one request per search, but `My.products` aliases cleanly and the
 * router answers all of them together — verified against three live searches. One request for
 * twenty queries is also politer than twenty, not less: the throttle spaces requests, so the
 * sequential version cost a second per query.
 */
export function multiSearchDocument(
  count: number,
): TypedDocumentNode<
  RawMultiSearchResponse,
  Record<string, ProductSearchVariables["searchInput"]>
> {
  const aliases = Array.from({ length: count }, (_, index) => multiSearchAlias(index));
  const parameters = aliases.map((alias) => `$${alias}: CompositeSearchInput!`).join(", ");
  const fields = aliases
    .map(
      (alias) => `    ${alias}: products(searchInput: $${alias}) {${PRODUCT_PAGE_SELECTION}
    }`,
    )
    .join("\n");
  return parse(`query ${PRODUCT_SEARCH_OPERATION}(${parameters}) {
  My {
${fields}
  }
}`);
}

export function multiSearchVariables(
  queries: readonly string[],
  pageNumber: number,
  pageSize: number,
  sortBy: ProductSort,
): Record<string, ProductSearchVariables["searchInput"]> {
  const variables: Record<string, ProductSearchVariables["searchInput"]> = {};
  for (const [index, value] of queries.entries()) {
    variables[multiSearchAlias(index)] = {
      byKeyword: { ...page(pageNumber, pageSize, sortBy), value },
    };
  }
  return variables;
}

/**
 * The sorts the site's own calls use. `FREQUENCY` is accepted only on the personal
 * "Buy it again" list; keyword search, category browse and specials all reject it.
 */
export const PRODUCT_SORTS = ["RELEVANCE", "FREQUENCY", "FAVOURITES"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/** The specials filters the site sends; each narrows the promotion type. */
export const SPECIAL_FILTERS = [
  "SPECIALS",
  "HALF_PRICE",
  "MULTIBUY",
  "LOW_PRICE",
  "MEMBER_PRICE",
  "ONLINE_ONLY_SPECIALS",
] as const;

interface PageInput {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly facetFilters: readonly string[];
  readonly staticFilters: readonly string[];
  readonly sortBy: string;
}

export interface ProductSearchVariables {
  readonly searchInput:
    | { readonly byKeyword: PageInput & { readonly value: string } }
    | { readonly byCategoryKey: PageInput & { readonly value: string } }
    | { readonly byProductPromotionSpecials: PageInput }
    | { readonly byBuyAgain: Omit<PageInput, "facetFilters" | "staticFilters"> }
    | { readonly byPastShop: PageInput & { readonly skus: readonly string[] } };
}

/** `pageIndex` is zero-based upstream; every tool in this server counts pages from 1. */
function page(
  pageNumber: number,
  pageSize: number,
  sortBy: string,
  staticFilters: readonly string[] = [],
) {
  return { pageIndex: pageNumber - 1, pageSize, facetFilters: [], staticFilters, sortBy };
}

export function keywordSearchVariables(
  value: string,
  pageNumber: number,
  pageSize: number,
  sortBy: ProductSort,
): ProductSearchVariables {
  return { searchInput: { byKeyword: { ...page(pageNumber, pageSize, sortBy), value } } };
}

export function categorySearchVariables(
  categoryKey: string,
  pageNumber: number,
  pageSize: number,
  sortBy: ProductSort,
): ProductSearchVariables {
  return {
    searchInput: { byCategoryKey: { ...page(pageNumber, pageSize, sortBy), value: categoryKey } },
  };
}

export function specialsVariables(
  pageNumber: number,
  pageSize: number,
  sortBy: ProductSort,
  filters: readonly string[],
): ProductSearchVariables {
  return {
    searchInput: {
      byProductPromotionSpecials: page(pageNumber, pageSize, sortBy, filters),
    },
  };
}

export const CATEGORIES_OPERATION = "GetAllCategories";

/** The browse tree. `key` is what `byCategoryKey` takes; `displaySlug` is what a URL shows. */
export const CATEGORIES_DOCUMENT: TypedDocumentNode<RawCategoriesResponse, CategoriesVariables> =
  parse(`query ${CATEGORIES_OPERATION}($categoryKey: String) {
  My {
    categories(categoryKey: $categoryKey) {
      ...Node
      children { ...Node children { ...Node children { ...Node } } }
    }
  }
}

fragment Node on Category { name level key slug displaySlug displayOrder description }`);

export interface CategoriesVariables {
  readonly categoryKey?: string;
}

export const PRODUCT_DETAIL_OPERATION = "ProductDetail";

/**
 * A product's full detail. `storeKey` is required: price and availability are per store, so the
 * same sku answers differently depending on where it is asked about.
 *
 * The attribute fields live on the concrete variant type, not the `ProductVariant` interface.
 */
const COMMON_VARIANT_FIELDS = `
        key
        sku
        volumeSize
        richDescription
        countryOfOrigin
        directionsOfUse
        tgaWarnings
        productWarnings
        ageRestriction
        availabilityStatus
        purchasingUnits { unit minimumQty maximumQty incrementQty defaultQty }
        variantPrice { sellingPrice wasPrice savedAmount cupPrice cupUnit isSpecial isClubPrice }
        assets { name contentType url altText }`;

const FOOD_VARIANT_FIELDS = `${COMMON_VARIANT_FIELDS}
        barcode
        ingredients
        allergenContained
        servingSize
        servingsPerPack
        nutritionalInformation {
          quantityPerUnit energy protein fatTotal fatTotalSaturated
          carbohydrate carbohydrateSugars dietaryFibre sodium
        }`;

/**
 * One product in full, across every member of the variant union.
 *
 * The five members do not share a field set, and the router rejects an unknown field by name, so
 * each fragment selects exactly what its type offers. The sets below were established by sending
 * the full selection against each type and removing what the router named: `MonetaryVariant` has
 * no `barcode`; only `GroceryVariant` and `RegulatedVariant` carry ingredients, allergens,
 * serving sizes and nutrition. Selecting `GroceryVariant` alone left every liquor, gift card and
 * general-merchandise product undescribable.
 */
export const PRODUCT_DETAIL_DOCUMENT: TypedDocumentNode<
  RawProductDetailResponse,
  ProductDetailVariables
> = parse(`query ${PRODUCT_DETAIL_OPERATION}($keys: [ID!]!, $storeKey: String!) {
  products(keys: $keys, storeKey: $storeKey) {
    key
    brand
    name
    slug
    isLiquor
    isTobacco
    isOwnBrand
    variants {
      __typename
      ... on GroceryVariant {${FOOD_VARIANT_FIELDS}
      }
      ... on RegulatedVariant {${FOOD_VARIANT_FIELDS}
      }
      ... on GeneralMerchandiseVariant {${COMMON_VARIANT_FIELDS}
        barcode
        allergenContained
      }
      ... on NonMerchandiseVariant {${COMMON_VARIANT_FIELDS}
        barcode
      }
      ... on MonetaryVariant {${COMMON_VARIANT_FIELDS}
      }
    }
  }
}`);

export interface ProductDetailVariables {
  readonly keys: readonly string[];
  readonly storeKey: string;
}

export const LOCATIONS_OPERATION = "SearchLocations";

/**
 * Pick-up locations. The captured searches by name alone came back empty; the one that returned
 * results carried `geolocation`, so the coordinates are what this actually searches by.
 */
export const LOCATIONS_DOCUMENT: TypedDocumentNode<RawLocationsResponse, LocationsVariables> =
  parse(`query ${LOCATIONS_OPERATION}($input: LocationsInput!) {
  locations(input: $input) {
    locations {
      id
      name
      storeId
      description
      distance
      address {
        locality { suburb city state postcode country }
        lines { line1 line2 line3 line4 line5 }
      }
      store { storeId name }
    }
  }
}`);

export interface LocationsVariables {
  readonly input: {
    readonly search: string;
    readonly allStores: boolean;
    readonly filter: {
      readonly sortingMethod: string;
      readonly sortingOrder: string;
      readonly max: number;
    };
    readonly geolocation?: { readonly latitude: number; readonly longitude: number };
  };
}

export function locationsVariables(
  search: string,
  max: number,
  geolocation: { readonly latitude: number; readonly longitude: number } | undefined,
): LocationsVariables {
  return {
    input: {
      search,
      allStores: false,
      filter: { sortingMethod: "DISTANCE", sortingOrder: "ASCENDING", max },
      ...(geolocation === undefined ? {} : { geolocation }),
    },
  };
}

export const ADDRESSES_OPERATION = "GetMeAddresses";

/** The account's saved delivery addresses — the only places the cart can be moved to. */
export const ADDRESSES_DOCUMENT: TypedDocumentNode<RawAddressesResponse, EmptyVariables> =
  parse(`query ${ADDRESSES_OPERATION} {
  me {
    id
    addresses { id lines { line1 line2 line3 line4 line5 } }
  }
}`);

export const SET_SHOPPING_MODE_OPERATION = "SetCartShoppingMode";

/**
 * Moves the cart to one of the account's saved delivery addresses.
 *
 * This does not book anything: the captured response came back with `fulfilmentProposition: null`
 * and "Please select a time slot to continue", which is why it is bound while `setCartFulfilment`
 * is not. Only `Delivery` has been observed as a `shoppingMode`; the value for pick-up has not, so
 * only delivery is offered rather than guessing an enum.
 */
export const SET_SHOPPING_MODE_DOCUMENT: TypedDocumentNode<
  RawSetShoppingModeResponse,
  SetShoppingModeVariables
> = parse(`mutation ${SET_SHOPPING_MODE_OPERATION}($input: SetCartShoppingModeInput!) {
  setCartShoppingMode(input: $input) {
    key
    shoppingMode {
      mode
      deliveryAddress {
        id
        lines { line1 line2 line3 line4 line5 }
        locality { suburb city state }
        coordinates { latitude longitude }
      }
      pickupLocation { id name }
    }
    fulfilment {
      fulfilmentProposition { storeId method store { storeId name } }
    }
${VALIDATION_RESULT}
  }
}`);

export const DELIVERY_MODE = "Delivery";

export interface SetShoppingModeVariables {
  readonly input: {
    readonly deliveryAddressId: string;
    readonly shoppingMode: string;
  };
}

export function setShoppingModeVariables(deliveryAddressId: string): SetShoppingModeVariables {
  return { input: { deliveryAddressId, shoppingMode: DELIVERY_MODE } };
}

export const DELIVERY_WINDOWS_OPERATION = "Propositions";

/**
 * The delivery and pick-up windows offered for a location.
 *
 * A read. Choosing one is `setCartFulfilment`, which this server deliberately does not bind — no
 * tool here books a slot — so the window's own id is not selected either: it is the token a
 * booking would use and nothing here has any use for it.
 */
export const DELIVERY_WINDOWS_DOCUMENT: TypedDocumentNode<
  RawPropositionsResponse,
  DeliveryWindowsVariables
> = parse(`query ${DELIVERY_WINDOWS_OPERATION}($input: PropositionsInput!) {
  propositions(input: $input) {
    propositions {
      name
      method
      type
      kind
      available
      startTime
      endTime
      storeId
      store { storeId name }
      tags
      fees {
        type
        currency
        amountInCents
        rateCard { orderValueMinInCents orderValueMaxInCents amountInCents }
      }
    }
  }
}`);

/** Either the coordinates a delivery goes to, or the id of a pick-up location. */
export type DeliveryWindowsVariables =
  | {
      readonly input: {
        readonly coordinates: { readonly latitude: number; readonly longitude: number };
      };
    }
  | { readonly input: { readonly locationId: string } };

export const ORDER_FILTERS = ["PAST", "ACTIVE"] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

export interface OrdersVariables {
  readonly input: {
    readonly pageIndex: number;
    readonly pageSize: number;
    readonly inclusiveFilter: OrderFilter;
  };
}

/** `pageIndex` is zero-based upstream; every tool in this server counts pages from 1. */
export function ordersVariables(
  page: number,
  pageSize: number,
  filter: OrderFilter,
): OrdersVariables {
  return { input: { pageIndex: page - 1, pageSize, inclusiveFilter: filter } };
}

/** How a line is priced. The site's cart offers exactly these two variants of a product. */
/**
 * The pricing units, spelled as the catalogue spells them. `purchasingUnit` on a product reads
 * `EACH` or `KG`, and the cart tools tell the caller to pass that value through, so the two
 * vocabularies have to be the same one.
 */
export const PRICING_UNITS = ["EACH", "KG"] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

/**
 * A cart write targets a `variantKey`, not a sku: a product sold both ways has one variant key
 * per way, and writing to the wrong one leaves the line it was meant to change untouched.
 *
 * The encoding is `<sku>-EA` / `<sku>-KG`. All 171 variants across the six captured
 * `ProductSearch` responses use it, and the site rejects a key it does not know rather than
 * ignoring it, so a key built here is either right or loud.
 */
const VARIANT_SUFFIXES: Readonly<Record<PricingUnit, string>> = { EACH: "EA", KG: "KG" };

export function variantKeyFor(sku: string, pricingUnit: PricingUnit): string {
  return `${sku}-${VARIANT_SUFFIXES[pricingUnit]}`;
}

/** Every variant key of a sku, so a write can clear the other pricing of the same product. */
export function variantKeysFor(sku: string): readonly string[] {
  return PRICING_UNITS.map((unit) => variantKeyFor(sku, unit));
}

/** The pricing unit a returned `productVariantSku` describes, or undefined for an unknown suffix. */
export function pricingUnitFromVariantKey(variantKey: string): PricingUnit | undefined {
  return PRICING_UNITS.find((unit) => variantKey.endsWith(`-${VARIANT_SUFFIXES[unit]}`));
}

export interface CartLineItemQuantityUpdate {
  readonly variantKey: string;
  readonly quantity: number;
}

/** The read takes no variables; `graphql-request` still wants a type for them. */
export type EmptyVariables = Readonly<Record<string, never>>;

export interface CartWriteVariables {
  readonly input: {
    readonly cartLineItemQuantityUpdates: readonly CartLineItemQuantityUpdate[];
  };
}

export function cartWriteVariables(
  updates: readonly CartLineItemQuantityUpdate[],
): CartWriteVariables {
  return { input: { cartLineItemQuantityUpdates: updates } };
}
