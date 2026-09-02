import { z } from "zod";

/**
 * Schemas for the `/api/graphql` payloads, covering only the fields this server selects.
 *
 * Anything the server relies on is REQUIRED here. If Woolworths changes a shape, the parse throws
 * naming the endpoint, the field and the keys that did arrive — a loud breakage, never a quiet
 * one. `nullish` is used only where the site has been *observed* to send null and that null has a
 * definite meaning; it is never a way to keep going past a response we did not understand.
 */

const nullableString = z.string().nullish();
const nullableNumber = z.number().nullish();

/** Parses at the boundary, naming the endpoint and the offending field when the shape has moved. */
export function parseResponse<T>(
  schema: Readonly<z.ZodType<T>>,
  payload: unknown,
  endpoint: string,
): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  // The whole payload is traced, not a summary of it: a shape change is diagnosed from what
  // actually arrived. It goes to the server's own log, which is where the full record belongs.
  const trace = safeStringify(payload);
  console.error(`[woolies-mcp] ${endpoint} did not match its schema. Full payload:\n${trace}`);
  throw new Error(
    `Unexpected response shape from ${endpoint} — ${issues}. Payload carried: ${describeKeys(payload)}` +
      `${describeFailingObjects(payload, result.error.issues)}. Full payload traced to the server log.`,
  );
}

/** JSON, or a description of why it could not be rendered. Never silently empty. */
function safeStringify(payload: unknown): string {
  try {
    // JSON.stringify is typed as returning string but returns undefined for undefined input.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch (error: unknown) {
    return `<unserialisable payload: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

/** Names the keys of the objects the failures point at, so nested shape changes are visible. */
function describeFailingObjects(
  payload: unknown,
  issues: readonly { path: PropertyKey[] }[],
): string {
  const parents = new Set<string>();
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    parents.add(issue.path.slice(0, -1).join("."));
  }

  const described: string[] = [];
  for (const parent of [...parents].slice(0, 3)) {
    if (parent === "") continue;
    const value = resolvePath(payload, parent.split("."));
    if (value === undefined) continue;
    described.push(`${parent} carried: ${describeKeys(value)}`);
  }
  return described.length === 0 ? "" : `. ${described.join(". ")}`;
}

function resolvePath(payload: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, step) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[step];
  }, payload);
}

/** Top-level key names of a payload, for diagnostics. Never includes values. */
function describeKeys(payload: unknown): string {
  if (payload === null || payload === undefined) return String(payload);
  if (Array.isArray(payload)) return `array(${payload.length})`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload);
  const shown = keys.slice(0, 40).join(", ");
  return keys.length > 40 ? `${shown}, …(${keys.length} keys)` : shown;
}

/**
 * The `/api/graphql` cart shapes, from `www.woolworths.co.nz-gql.har` and from live reads of a
 * populated and an empty cart.
 *
 * Money is in cents on the cart, unlike the plain numbers the catalogue sends. Every count and amount
 * the cart reports is a number the site actually sent: `savings: 0` on this API means "reported as
 * zero", which is a different answer from a fee the site did not report at all, and the mappers
 * keep the two apart.
 */

/** Selected on `EvaluatedPrice` and `EvaluatedDetailedPrice`; both carry all three. */
const evaluatedPriceSchema = z.object({
  beforeDiscountAsCents: z.number(),
  afterDiscountAsCents: z.number(),
  discountAmountAsCents: z.number(),
});

const lineTotalSchema = z.object({
  afterDiscountAsCents: z.number(),
  discountAmountAsCents: z.number(),
});

const unitPriceSchema = z.object({
  beforeDiscountAsCents: z.number(),
  afterDiscountAsCents: z.number(),
});

/**
 * `resolution` and `title` are each null on one of the two observed failures
 * (`ValidateMinimumDeliveryValue` carries a title and no resolution; `ValidateHasFulfilmentProposition`
 * the reverse). Null means the site stated no such text for that rule.
 */
export const cartValidationSchema = z.object({
  isValid: z.boolean(),
  failedValidations: z.array(
    z.object({
      ruleName: z.string(),
      message: z.string(),
      affectedSkus: z.array(z.string()),
      resolution: nullableString,
      title: nullableString,
    }),
  ),
});

export type RawCartValidation = Readonly<z.infer<typeof cartValidationSchema>>;

export const cartCheckoutSchema = z.object({
  amountToPayAsCents: z.number(),
  chargeableTotalAsCents: z.number(),
  loyaltySpendAsCents: z.number(),
});

export const cartPricingSchema = z.object({
  orderSubtotal: evaluatedPriceSchema,
  productSubtotal: evaluatedPriceSchema,
  total: evaluatedPriceSchema,
});

/** `fees` is `[]` on a cart with no fulfilment window: no fee has been determined, not a fee of zero. */
export const cartFeeSchema = z.object({
  amountAsCents: z.number(),
  description: z.string(),
  type: z.string(),
});

/**
 * A variant of the product on a line. `key` is what a cart write targets, and the only place the
 * server can read one authoritatively.
 */
export type RawCartFee = Readonly<z.infer<typeof cartFeeSchema>>;

export const cartVariantSchema = z.object({
  key: z.string(),
  name: z.string(),
  purchasingUnits: z.object({
    unit: z.string(),
    minimumQty: z.number(),
    maximumQty: z.number(),
    incrementQty: z.number(),
    defaultQty: z.number(),
  }),
});
export type RawCartVariant = Readonly<z.infer<typeof cartVariantSchema>>;

export const cartLineItemSchema = z.object({
  sku: z.string(),
  productVariantSku: z.string(),
  quantity: z.number(),
  canSubstitute: z.boolean(),
  lineTotal: lineTotalSchema,
  unitPrice: unitPriceSchema,
  product: z.object({
    slug: z.string(),
    variants: z.array(cartVariantSchema),
  }),
});
export type RawCartLineItem = Readonly<z.infer<typeof cartLineItemSchema>>;

/**
 * Where the cart is being shopped from. This is the location every price and stock answer is for.
 *
 * `deliveryAddress` and `pickupLocation` are each null when the other is in use; `mode` says which.
 * The empty cart observed on 2 September 2026 had both null and `mode: "Delivery"`, which is a
 * session that has chosen a method but no address yet.
 */
export const shoppingModeSchema = z.object({
  mode: z.string(),
  deliveryAddress: z
    .object({
      id: z.string(),
      lines: z.object({
        line1: nullableString,
        line2: nullableString,
        line3: nullableString,
        line4: nullableString,
        line5: nullableString,
      }),
      locality: z.object({
        suburb: nullableString,
        city: nullableString,
        // Null on the observed address even though the suburb and city are set.
        state: nullableString,
      }),
      // Where delivery windows are asked about, so they are for the address this cart uses.
      coordinates: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
    })
    .nullable(),
  pickupLocation: z.object({ id: z.string(), name: z.string() }).nullable(),
});

/**
 * The chosen fulfilment window, and with it the serving store. Null before a window is chosen —
 * the store is then not established and must not be reported as one.
 */
export const cartFulfilmentSchema = z.object({
  fulfilmentProposition: z
    .object({
      storeId: z.string(),
      method: z.string(),
      store: z.object({ storeId: z.string(), name: z.string() }).nullable(),
    })
    .nullable(),
});

export const customerCartSchema = z.object({
  key: z.string(),
  cartState: z.string(),
  totalItemQuantity: z.number(),
  totalUniqueProductSku: z.number(),
  fees: z.array(cartFeeSchema),
  shoppingMode: shoppingModeSchema,
  fulfilment: cartFulfilmentSchema,
  validationResult: cartValidationSchema,
  checkout: cartCheckoutSchema,
  pricing: cartPricingSchema,
  lineItems: z.array(cartLineItemSchema),
});
export type RawCustomerCart = Readonly<z.infer<typeof customerCartSchema>>;

/**
 * `me` is null exactly when the request was served as a guest. The transport raises that from the
 * accompanying `BANNED_OPERATION` error before this parses, so a null arriving here means the site
 * answered as a guest without saying so — which the cart client refuses just as loudly.
 */
export const cartReadResponseSchema = z.object({
  me: z.object({ id: z.string() }).nullable(),
  customerCart: customerCartSchema,
});
export type RawCartReadResponse = Readonly<z.infer<typeof cartReadResponseSchema>>;

/** The write returns the cart, minus the fields the mutation does not select. */
export const cartWriteLineItemSchema = z.object({
  sku: z.string(),
  productVariantSku: z.string(),
  quantity: z.number(),
  lineTotal: lineTotalSchema,
  unitPrice: unitPriceSchema,
});
export type RawCartWriteLineItem = Readonly<z.infer<typeof cartWriteLineItemSchema>>;

export const cartWriteResponseSchema = z.object({
  setCartLineItemQuantity: z.object({
    key: z.string(),
    totalItemQuantity: z.number(),
    totalUniqueProductSku: z.number(),
    validationResult: cartValidationSchema,
    checkout: cartCheckoutSchema,
    pricing: cartPricingSchema,
    lineItems: z.array(cartWriteLineItemSchema),
  }),
});
export type RawCartWriteResponse = Readonly<z.infer<typeof cartWriteResponseSchema>>;

/**
 * `byBuyAgain`: the products this shopper has bought before, most frequent first.
 *
 * `results` mixes product summaries with ad tiles, so it is parsed only far enough to read
 * `__typename`; each product is then parsed on its own. A union here would let a malformed product
 * fall through to the tile case and arrive typed but empty.
 */
export const productSummarySchema = z.object({
  __typename: z.literal("ProductSummary"),
  sku: z.string(),
  productName: z.string(),
  brand: nullableString,
  slug: z.string(),
  // Every level is an array; `lvl1` is the department. Observed with exactly one entry.
  categoryHierarchyNames: z.object({ lvl1: z.array(z.string()) }),
  variants: z.array(
    z.object({
      variantKey: z.string(),
      name: z.string(),
      unitOfMeasure: z.string(),
      availabilityStatus: z.string(),
      // Null when the variant is not ranged at the store this answered for, as elsewhere.
      variantPrice: z
        .object({
          sellingPrice: z.number(),
          // Null unless the product is on special; never read as a price of zero.
          wasPrice: nullableNumber,
          isSpecial: z.boolean(),
          // Null on products the site publishes no cup price for.
          cupPrice: nullableNumber,
          cupUnit: nullableString,
        })
        .nullable(),
    }),
  ),
});
export type RawProductSummary = Readonly<z.infer<typeof productSummarySchema>>;

/** A `results` entry, parsed only far enough to tell a product from an ad tile. */
export const searchResultItemSchema = z.looseObject({ __typename: z.string() });

export const pastPurchasesResponseSchema = z.object({
  My: z.object({
    products: z.object({
      totalCount: z.number(),
      pageSize: z.number(),
      totalPages: z.number(),
      // Zero-based upstream.
      currentPage: z.number(),
      results: z.array(searchResultItemSchema),
    }),
  }),
});
export type RawPastPurchasesResponse = Readonly<z.infer<typeof pastPurchasesResponseSchema>>;

/**
 * `orders`: the account's orders, filtered to `PAST` or `ACTIVE`.
 *
 * Two counts here are not what their names suggest. `pageSize` echoes how many rows came back,
 * not the size that was asked for — a request for 20 that returned 7 reports 7. `currentPage`
 * reads -1 on an empty result, which is a sentinel and never a page number.
 */
export const orderSchema = z.object({
  orderNumber: z.string(),
  createdDateTime: z.string(),
  orderStatus: z.string(),
  fulfilmentStatus: z.string(),
  hasInvoice: z.boolean(),
  isAmendable: z.boolean(),
  total: z.object({ afterDiscountInCents: z.number() }),
  fulfilments: z.array(
    z.object({
      method: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      fulfilmentLocation: z.object({ name: z.string() }),
      address: z.object({
        lines: z.object({
          line1: nullableString,
          line2: nullableString,
          line3: nullableString,
          line4: nullableString,
          line5: nullableString,
        }),
      }),
    }),
  ),
});
export type RawOrder = Readonly<z.infer<typeof orderSchema>>;

export const ordersResponseSchema = z.object({
  orders: z.object({
    totalCount: z.number(),
    totalPages: z.number(),
    pageSize: z.number(),
    currentPage: z.number(),
    results: z.array(orderSchema),
  }),
});
export type RawOrdersResponse = Readonly<z.infer<typeof ordersResponseSchema>>;

/**
 * What each order contained. `productKey` is the sku; `product` carries only a name on this type.
 *
 * `quantity` is 0 on some lines — 14 of 237 across seven real orders. What a zero means is not
 * stated by the API, so it is carried through verbatim and never counted as a purchase.
 */
export const orderLineItemSchema = z.object({
  productKey: z.string(),
  quantity: z.number(),
  product: z.object({ name: z.string() }),
});
export type RawOrderLineItem = Readonly<z.infer<typeof orderLineItemSchema>>;

export const purchaseHistoryResponseSchema = z.object({
  orders: z.object({
    totalCount: z.number(),
    totalPages: z.number(),
    currentPage: z.number(),
    results: z.array(
      z.object({
        orderNumber: z.string(),
        createdDateTime: z.string(),
        orderStatus: z.string(),
        total: z.object({ afterDiscountInCents: z.number() }),
        lineItems: z.array(orderLineItemSchema),
      }),
    ),
  }),
});
export type RawPurchaseHistoryResponse = Readonly<z.infer<typeof purchaseHistoryResponseSchema>>;

/**
 * A delivery or pick-up window.
 *
 * `fees[].amountInCents` was null on all 415 windows in captured traffic: the fee is banded by
 * order value in `rateCard` ($14.00 under $200, $9.00 above it), so there is no single amount and
 * a null here means "see the bands", not "free".
 *
 * `tags` carries both capability flags (`perishability:AllAllowed`, `liquor-allowed:true`) and,
 * on an unavailable window, why (`unavailableReason:cutoff-start-time-passed`). The site repeats
 * entries, so they are deduplicated when mapped.
 */
export const fulfilmentPropositionSchema = z.object({
  name: z.string(),
  method: z.string(),
  type: z.string(),
  kind: z.string(),
  available: z.boolean(),
  startTime: z.string(),
  endTime: z.string(),
  storeId: z.string(),
  // The fulfilling store, which is not always the one `storeId` names.
  store: z.object({ storeId: z.string(), name: z.string() }).nullable(),
  tags: z.array(z.string()),
  fees: z.array(
    z.object({
      type: z.string(),
      currency: z.string(),
      amountInCents: nullableNumber,
      rateCard: z.array(
        z.object({
          orderValueMinInCents: z.number(),
          // Null on the top band: it has no upper bound.
          orderValueMaxInCents: nullableNumber,
          amountInCents: z.number(),
        }),
      ),
    }),
  ),
});
export type RawFulfilmentProposition = Readonly<z.infer<typeof fulfilmentPropositionSchema>>;

export const propositionsResponseSchema = z.object({
  propositions: z.object({ propositions: z.array(fulfilmentPropositionSchema) }),
});
export type RawPropositionsResponse = Readonly<z.infer<typeof propositionsResponseSchema>>;

/** The account's saved addresses. `me` is refused to guests, so this read proves the session. */
export const addressesResponseSchema = z.object({
  me: z
    .object({
      id: z.string(),
      addresses: z.array(
        z.object({
          id: z.string(),
          lines: z.object({
            line1: nullableString,
            line2: nullableString,
            line3: nullableString,
            line4: nullableString,
            line5: nullableString,
          }),
        }),
      ),
    })
    .nullable(),
});
export type RawAddressesResponse = Readonly<z.infer<typeof addressesResponseSchema>>;

/**
 * The cart after its shopping mode moved. Carries the same `shoppingMode` and `fulfilment` the
 * read does, so the caller is told where the cart ended up rather than that a request succeeded.
 */
export const setShoppingModeResponseSchema = z.object({
  setCartShoppingMode: z.object({
    key: z.string(),
    shoppingMode: shoppingModeSchema,
    fulfilment: cartFulfilmentSchema,
    validationResult: cartValidationSchema,
  }),
});
export type RawSetShoppingModeResponse = Readonly<z.infer<typeof setShoppingModeResponseSchema>>;

/**
 * The catalogue shapes on `/api/graphql`.
 *
 * Prices are plain numbers here, not the cents the cart uses and not the formatted strings the
 * old REST API sent. `wasPrice` and `savedAmount` are null unless the product is on special, and
 * a null there means "not on special", never a price of zero.
 */
export const variantPriceSchema = z.object({
  sellingPrice: z.number(),
  wasPrice: nullableNumber,
  savedAmount: nullableNumber,
  cupPrice: nullableNumber,
  cupUnit: nullableString,
  isSpecial: z.boolean(),
  isClubPrice: z.boolean(),
});

export const purchaseUnitSchema = z.object({
  unit: z.string(),
  minimumQty: z.number(),
  maximumQty: z.number(),
  incrementQty: z.number(),
  defaultQty: z.number(),
});

export const searchVariantSchema = z.object({
  variantKey: z.string(),
  name: z.string(),
  unitOfMeasure: z.string(),
  availabilityStatus: z.string(),
  purchaseUnit: purchaseUnitSchema,
  // Null when the variant is not ranged at the store the search answered for, the same null
  // product detail returns. Required here would reject the product outright and drop it from
  // the list, so "not sold here" would leave the results silently.
  variantPrice: variantPriceSchema.nullable(),
});

export const searchProductSchema = z.object({
  __typename: z.literal("ProductSummary"),
  sku: z.string(),
  productName: z.string(),
  brand: nullableString,
  slug: z.string(),
  // The store the price and availability are for.
  storeKey: z.string(),
  categoryHierarchyNames: z.object({ lvl1: z.array(z.string()) }),
  variants: z.array(searchVariantSchema),
});
export type RawSearchProduct = Readonly<z.infer<typeof searchProductSchema>>;

/**
 * The page envelope. Two counts do not mean what their names suggest: `pageSize` echoes how many
 * rows came back rather than the size asked for, and `currentPage` reads -1 on an empty result,
 * which is a sentinel and never a page number. Neither is used to describe a page.
 */
export const productPageSchema = z.object({
  totalCount: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
  currentPage: z.number(),
  results: z.array(searchResultItemSchema),
});

/**
 * Several searches answered in one request, keyed by alias. A record rather than a fixed shape
 * because the aliases are generated from however many queries were asked for.
 */
export const multiSearchResponseSchema = z.object({
  My: z.record(z.string(), productPageSchema),
});
export type RawMultiSearchResponse = Readonly<z.infer<typeof multiSearchResponseSchema>>;

export const productSearchResponseSchema = z.object({
  My: z.object({ products: productPageSchema }),
});
export type RawProductSearchResponse = Readonly<z.infer<typeof productSearchResponseSchema>>;
export type RawProductPage = Readonly<z.infer<typeof productPageSchema>>;

/** A node of the browse tree. `key` is what a category search takes. */
const categoryNodeSchema = z.object({
  name: z.string(),
  level: z.number(),
  key: z.string(),
  slug: z.string(),
  displaySlug: z.string(),
  displayOrder: z.number(),
  description: nullableString,
});
export type RawCategoryNode = Readonly<z.infer<typeof categoryNodeSchema>> & {
  readonly children?: readonly RawCategoryNode[] | null | undefined;
};

/** Four levels deep, which is what the site's own query asks for. */
export const categoryTreeSchema: z.ZodType<RawCategoryNode> = categoryNodeSchema.extend({
  children: z.lazy(() => z.array(categoryTreeSchema)).nullish(),
});

/** `categories` is one node — the root, or the one named by `categoryKey` — not a list. */
export const categoriesResponseSchema = z.object({
  My: z.object({ categories: categoryTreeSchema }),
});
export type RawCategoriesResponse = Readonly<z.infer<typeof categoriesResponseSchema>>;

/** One nutrition panel. The site returns one per basis, e.g. "Per 100g" and "Per Serve". */
export const nutritionalInformationSchema = z.object({
  quantityPerUnit: z.string(),
  energy: nullableString,
  protein: nullableString,
  fatTotal: nullableString,
  fatTotalSaturated: nullableString,
  carbohydrate: nullableString,
  carbohydrateSugars: nullableString,
  dietaryFibre: nullableString,
  sodium: nullableString,
});

/**
 * A product's full detail, on the concrete variant type.
 *
 * Every attribute is nullable and every null means the same thing: the site states nothing.
 * `allergenContained` null is "not stated", never "contains no allergens" — the distinction the
 * whole product-detail tool exists to preserve.
 */
/**
 * The fields every member of the variant union carries.
 *
 * `ageRestriction` is a number: 18 was observed on wine. It was previously typed as a string,
 * which no liquor variant would have satisfied.
 */
const commonVariantFields = {
  key: z.string(),
  sku: z.string(),
  volumeSize: nullableString,
  richDescription: nullableString,
  countryOfOrigin: nullableString,
  directionsOfUse: nullableString,
  tgaWarnings: nullableString,
  productWarnings: nullableString,
  ageRestriction: z.number().nullish(),
  availabilityStatus: z.string(),
  purchasingUnits: purchaseUnitSchema,
  // Null when the product is not ranged at the store asked about — observed for green chillies at
  // store 9171 while store 9583 priced them. "Not sold here" is an answer, not a price of zero.
  variantPrice: variantPriceSchema.nullable(),
  assets: z.array(
    z.object({
      name: nullableString,
      contentType: nullableString,
      url: z.string(),
      altText: nullableString,
    }),
  ),
};

/** Only these two types carry ingredients, allergens, serving sizes and nutrition. */
const edibleVariantFields = {
  ...commonVariantFields,
  barcode: nullableString,
  ingredients: nullableString,
  allergenContained: nullableString,
  servingSize: nullableString,
  servingsPerPack: nullableString,
  nutritionalInformation: z.array(nutritionalInformationSchema).nullish(),
};

/**
 * A variant, discriminated by its type.
 *
 * The members are modelled separately rather than as one loose shape because they genuinely
 * differ: a gift card has no barcode and no ingredients, and a schema that made those optional
 * everywhere would report "the site stated no ingredients" for a product that cannot have any.
 */
export const detailVariantSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("GroceryVariant"), ...edibleVariantFields }),
  z.object({ __typename: z.literal("RegulatedVariant"), ...edibleVariantFields }),
  z.object({
    __typename: z.literal("GeneralMerchandiseVariant"),
    ...commonVariantFields,
    barcode: nullableString,
    allergenContained: nullableString,
  }),
  z.object({
    __typename: z.literal("NonMerchandiseVariant"),
    ...commonVariantFields,
    barcode: nullableString,
  }),
  z.object({ __typename: z.literal("MonetaryVariant"), ...commonVariantFields }),
]);
export type RawDetailVariant = Readonly<z.infer<typeof detailVariantSchema>>;

export const detailProductSchema = z.object({
  key: z.string(),
  brand: nullableString,
  name: z.string(),
  slug: z.string(),
  isLiquor: z.boolean(),
  isTobacco: z.boolean(),
  isOwnBrand: z.boolean(),
  // A variant of a type this server does not select comes back as `{ __typename }` alone and is
  // skipped rather than parsed into an empty product.
  variants: z.array(z.looseObject({ __typename: z.string() })),
});
export type RawDetailProduct = Readonly<z.infer<typeof detailProductSchema>>;

export const productDetailResponseSchema = z.object({
  products: z.array(detailProductSchema),
});
export type RawProductDetailResponse = Readonly<z.infer<typeof productDetailResponseSchema>>;

/** A pick-up location. `distance` is kilometres from the coordinates searched by. */
export const locationSchema = z.object({
  id: z.string(),
  name: z.string(),
  storeId: nullableString,
  description: nullableString,
  distance: nullableNumber,
  address: z.object({
    locality: z.object({
      suburb: nullableString,
      // Null on every observed location even where the suburb is set.
      city: nullableString,
      state: nullableString,
      postcode: nullableString,
      country: nullableString,
    }),
    lines: z.object({
      line1: nullableString,
      line2: nullableString,
      line3: nullableString,
      line4: nullableString,
      line5: nullableString,
    }),
  }),
  store: z.object({ storeId: z.string(), name: z.string() }).nullable(),
});
export type RawLocation = Readonly<z.infer<typeof locationSchema>>;

export const locationsResponseSchema = z.object({
  locations: z.object({ locations: z.array(locationSchema) }),
});
export type RawLocationsResponse = Readonly<z.infer<typeof locationsResponseSchema>>;
