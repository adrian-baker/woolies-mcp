import { z } from "zod";

/**
 * Schemas for the `/api/v1` payloads, covering only the fields this server uses. Zod strips the
 * rest, which is most of the response (DESIGN.md: "kilobytes of feature flags").
 *
 * Anything the server relies on is REQUIRED here. If Woolworths changes a shape, the parse throws
 * naming the endpoint, the field and the keys that did arrive — a loud breakage, never a quiet
 * one. `nullish` is used only where the site has been *observed* to send null and that null has a
 * definite meaning; it is never a way to keep going past a response we did not understand.
 */

const nullableString = z.string().nullish();
const nullableNumber = z.number().nullish();

export const priceSchema = z.object({
  salePrice: z.number(),
  originalPrice: z.number(),
  savePrice: nullableNumber,
  isSpecial: z.boolean(),
  isClubPrice: z.boolean().nullish(),
  canShowOriginalPrice: z.boolean().nullish(),
  promotionEndDate: nullableString,
});
export type RawPrice = Readonly<z.infer<typeof priceSchema>>;

export const sizeSchema = z.object({
  volumeSize: nullableString,
  packageType: nullableString,
  cupPrice: nullableNumber,
  cupMeasure: nullableString,
});
export type RawSize = Readonly<z.infer<typeof sizeSchema>>;

/** A `products.items` entry with `type: "Product"`. */
export const productItemSchema = z.object({
  type: z.literal("Product"),
  sku: z.string(),
  name: z.string(),
  brand: nullableString,
  variety: nullableString,
  slug: nullableString,
  barcode: nullableString,
  unit: z.string(),
  selectedPurchasingUnit: nullableString,
  supportsBothEachAndKgPricing: z.boolean(),
  departments: z.array(z.object({ id: z.number(), name: z.string() })).nullish(),
  price: priceSchema,
  size: sizeSchema.nullish(),
  stockLevel: nullableNumber,
  availabilityStatus: nullableString,
  isAgeRestricted: z.boolean().nullish(),
});
export type RawProductItem = Readonly<z.infer<typeof productItemSchema>>;

/**
 * `products.items` mixes products with ad tiles ("PromoTile") and whatever the site adds next,
 * so the list is parsed only far enough to read `type`. Each product is then parsed on its own
 * (`partitionSearchItems`); a union here would let a malformed product fall through to the tile
 * case and arrive typed but empty.
 */
export const searchListItemSchema = z.looseObject({ type: z.string() });
export type RawSearchListItem = Readonly<z.infer<typeof searchListItemSchema>>;

export const facetSchema = z.object({
  key: z.string(),
  value: z.string(),
  name: z.string(),
  productCount: z.number(),
  group: nullableString,
});
export type RawFacet = Readonly<z.infer<typeof facetSchema>>;

export const sortOptionSchema = z.object({
  value: z.string(),
  text: z.string(),
  selected: z.boolean(),
});

export const searchResponseSchema = z.object({
  products: z.object({
    items: z.array(searchListItemSchema),
    totalItems: z.number(),
  }),
  dasFacets: z.array(facetSchema),
  sortOptions: z.array(sortOptionSchema).nullish(),
  currentSortOption: nullableString,
});
export type RawSearchResponse = Readonly<z.infer<typeof searchResponseSchema>>;

const breadcrumbNodeSchema = z.object({ name: z.string(), value: nullableNumber }).nullish();

export const productDetailSchema = z.object({
  sku: z.string(),
  name: z.string(),
  brand: nullableString,
  variety: nullableString,
  unit: z.string(),
  supportsBothEachAndKgPricing: z.boolean(),
  price: priceSchema,
  size: sizeSchema.nullish(),
  availabilityStatus: nullableString,
  description: nullableString,
  isAgeRestricted: z.boolean().nullish(),
  selectedPurchasingUnit: nullableString,
  averageWeightPerUnit: nullableNumber,
  // Null on fresh produce, empty on packaged goods with nothing published; both mean not stated.
  allergens: z.array(z.string()).nullish(),
  allergenMaybePresent: nullableString,
  ingredients: z
    .object({ ingredients: z.array(z.string()), footnotes: z.array(z.string()).nullish() })
    .nullish(),
  claims: z.array(z.string()).nullish(),
  endorsements: z.array(z.string()).nullish(),
  warnings: z.array(z.string()).nullish(),
  contents: z.array(z.string()).nullish(),
  directions: nullableString,
  servingSuggestion: nullableString,
  origins: z.array(z.string()).nullish(),
  healthStarRating: nullableNumber,
  nutrition: z.unknown().nullish(),
  images: z.array(z.object({ big: z.string(), small: z.string() })).nullish(),
  breadcrumb: z
    .object({
      department: breadcrumbNodeSchema,
      aisle: breadcrumbNodeSchema,
      shelf: breadcrumbNodeSchema,
    })
    .nullish(),
});
export type RawProductDetail = Readonly<z.infer<typeof productDetailSchema>>;

const shelfSchema = z.object({ id: z.number(), label: z.string(), url: z.string() });

/**
 * `GET /products/departments`: the browse tree. Each department carries its aisles as
 * `dasFacets`, and each aisle its shelves. Aisles have no slug of their own — see
 * `aisleSlug` in the mappers.
 */
export const departmentSchema = z.object({
  id: z.number(),
  label: z.string(),
  url: z.string(),
  dasFacets: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      name: z.string(),
      productCount: z.number(),
      // Observed null for an aisle with no shelves; that null means exactly "no shelves".
      shelfResponses: z.array(shelfSchema).nullish(),
    }),
  ),
});
export const departmentsResponseSchema = z.array(departmentSchema);
export type RawDepartment = Readonly<z.infer<typeof departmentSchema>>;

const storeAreaSchema = z.object({
  id: z.number(),
  name: z.string(),
  storeAddresses: z.array(z.object({ id: z.number(), name: z.string(), address: z.string() })),
});
export type RawStoreArea = Readonly<z.infer<typeof storeAreaSchema>>;

export const pickupAddressesResponseSchema = z.object({
  storeAreas: z.array(storeAreaSchema),
});

export const suburbsResponseSchema = z.object({
  suburbResults: z.array(z.object({ text: z.string(), id: z.number() })),
});

/**
 * `/shell` and the fulfilment PUT both answer with the same envelope, so one schema serves both.
 *
 * `suburbId` reads 0 for an anonymous session even after the suburb is set — the selection shows
 * up as `address`, `areaId` and `fulfilmentStoreId` instead (DESIGN.md, "Build notes").
 */
export const fulfilmentContextSchema = z.object({
  context: z.object({
    fulfilment: z.object({
      address: nullableString,
      method: nullableString,
      areaId: nullableNumber,
      suburbId: nullableNumber,
      pickupAddressId: nullableNumber,
      fulfilmentStoreId: nullableNumber,
      isAddressInDeliveryZone: z.boolean().nullish(),
    }),
  }),
});
export type RawFulfilmentEnvelope = Readonly<z.infer<typeof fulfilmentContextSchema>>;

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
 * Account and trolley shapes (M4), from captured signed-in traffic.
 *
 * Required, like everything else: a cart is exactly the kind of thing that must never read as
 * empty because the response moved.
 */

export const shopperContextSchema = z.object({
  context: z.object({
    shopper: z.object({
      firstName: nullableString,
      isLoggedIn: z.boolean().nullish(),
      hasOnecard: z.boolean().nullish(),
      // Null when anonymous, a decimal *string* when signed in. Never observed as a number.
      orderCount: z.coerce.number().nullish(),
    }),
  }),
});
export type RawShopperEnvelope = Readonly<z.infer<typeof shopperContextSchema>>;

/**
 * The response to `POST /trolleys/my/items`, from captured signed-in traffic.
 * `itemAdded` reflects the line after the write; `totalItemQuantityInBasket` is the whole basket.
 */
/**
 * `selectedPurchasingUnit` echoed the requested `pricingUnit` in all nine captured writes;
 * `unit` disagreed in three of them, reading "Kg" for Each purchases. Only the former describes
 * how the line is priced.
 */
export const trolleyWriteResponseSchema = z.object({
  itemAdded: z.object({
    sku: z.string(),
    quantity: z.number(),
    selectedPurchasingUnit: z.string(),
  }),
  totalItemQuantityInBasket: z.number(),
  isSuccessful: z.boolean(),
});

/** A trolley line. `quantity` arrives either as a number or as `{ value }` depending on route. */
export const trolleyItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  brand: nullableString,
  quantity: z.union([z.number(), z.object({ value: z.number() })]),
  price: priceSchema,
  size: sizeSchema.nullish(),
  availabilityStatus: nullableString,
});
export type RawTrolleyItem = Readonly<z.infer<typeof trolleyItemSchema>>;

/**
 * The trolley read. Every field is required: a cart that cannot be read must fail loudly, never
 * come back looking empty. "No lines" and "the response was not understood" are different answers
 * and only one of them is safe to show.
 */
/** A trolley `items` entry: a group of lines, not a line. Observed live, four groups on a real cart. */
export const trolleyGroupSchema = z.object({
  products: z.array(trolleyItemSchema),
});

/**
 * Money arrives pre-formatted with a currency symbol. `totalItems` counts distinct lines and
 * `totalItemQuantity` sums the quantities on them; on a live cart these read 19 and 23.
 */
export const basketTotalsSchema = z.object({
  subtotal: z.string(),
  savings: z.string(),
  deliveryFees: z.string(),
  bagFees: z.string(),
  totalIncludingDeliveryFees: z.string(),
  totalItems: z.number(),
  totalItemQuantity: z.number(),
});

export const trolleyResponseSchema = z.object({
  itemCount: z.number(),
  items: z.array(trolleyGroupSchema),
  isSuccessful: z.boolean(),
  context: z.object({ basketTotals: basketTotalsSchema }),
});

export const orderListSchema = z.object({
  items: z.array(
    z.object({
      orderId: z.union([z.number(), z.string()]),
      orderDate: nullableString,
      status: nullableString,
      total: nullableNumber,
    }),
  ),
  totalItems: z.number(),
});

/**
 * `GET /products/my/forgotten`. `products` is a list of SECTIONS, not products. Observed live
 * with two: "Items previously purchased" (real history) and "Our picks this week" (advertising).
 * `itemCount` equalled the section's own length in both, so it sizes the section and says nothing
 * about how much history exists.
 */
export const purchaseSectionSchema = z.object({
  section: z.string(),
  itemCount: z.number(),
  products: z.array(productItemSchema),
});

export const forgottenProductsResponseSchema = z.object({
  products: z.array(purchaseSectionSchema),
});

/**
 * `GET /shoppers/my/past-orders`. Every field was present on all six live orders, so all are
 * required. The endpoint's own `filterList` reports "Past 180 Days" as the selected window and
 * ignores a `filter` query parameter, so this is the site's default window, not all history.
 */
export const pastOrderSchema = z.object({
  orderId: z.number(),
  prefix: z.string(),
  orderDate: z.string(),
  method: z.string(),
  total: z.number(),
  fulfilmentDate: z.string(),
  fulfilmentTime: z.string(),
  deliveryFee: z.number(),
  status: z.string(),
  isEditable: z.boolean(),
});

export const pastOrdersResponseSchema = z.object({
  items: z.array(pastOrderSchema),
  totalItems: z.number(),
});
export type RawPastOrder = Readonly<z.infer<typeof pastOrderSchema>>;
