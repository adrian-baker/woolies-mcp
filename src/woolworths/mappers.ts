import type { ZodError } from "zod";
import { productSummarySchema, searchProductSchema } from "./schemas.js";
import type {
  RawOrder,
  RawPurchaseHistoryResponse,
  RawCartFee,
  RawFulfilmentProposition,
  RawCategoryNode,
  RawDetailProduct,
  RawDetailVariant,
  RawLocation,
  RawProductPage,
  RawSearchProduct,
  RawPastPurchasesResponse,
  RawProductSummary,
  RawCartLineItem,
  RawCartValidation,
  RawCustomerCart,
} from "./schemas.js";

/**
 * The shape the model sees (DESIGN.md, "Compact product shape"). Absent fields are `undefined`
 * and drop out of the JSON, so the model is never handed a field it cannot use.
 */
export type PurchasingUnit = "EACH" | "KG";

/**
 * The delivery context a price is quoted against.
 *
 * `suburbId` is deliberately absent: the shell reports it as 0 even after a successful suburb
 * change, so surfacing it only invited the reader to think the change had failed. `address` and
 * `fulfilmentStoreId` are what actually move.
 */
/**
 * Where the cart is being shopped from: the location every price and stock answer is for.
 *
 * Read from the cart rather than from the storefront's session shell. The shell describes the
 * legacy session, which the site's migration leaves anonymous, and it was observed reporting a
 * default store (Glenfield, 9171) while the cart was really being served from Northwest (9583).
 * A wrong location here silently misprices everything, so it comes from the cart itself.
 *
 * `store` is absent until a fulfilment window is chosen — the serving store is genuinely not
 * established before then, and must not be reported as one.
 */
export interface Fulfilment {
  readonly mode: string;
  readonly address: string | undefined;
  readonly suburb: string | undefined;
  /**
   * The pick-up store held on the account. Absent while the cart is on Delivery, where it is a
   * standing preference for a different mode and not where this shop comes from — reporting it
   * beside a delivery address invites it to be read as the store serving the cart.
   */
  readonly pickupLocation: string | undefined;
  /** The store fulfilling this cart, stated only once a window is chosen. */
  readonly store: string | undefined;
  readonly storeId: string | undefined;
  readonly method: string | undefined;
  /**
   * The store the catalogue prices against, discovered from a catalogue result. This is the one
   * that decides every price and every in-stock answer, and it is available before a window is
   * chosen — which `store` and `storeId` are not.
   */
  readonly catalogueStoreKey: string | undefined;
  /** Names anything the cart did not state, so an absence is never read as a fact. */
  readonly notReported: readonly string[];
}

/**
 * A delivery or pick-up window.
 *
 * `fee` is a set of bands, not an amount: the site charges by order value and never states a
 * single figure. `unavailableReasons` is what the site said about a closed window, not a guess.
 */
/**
 * A product as a client sees it, from the GraphQL catalogue.
 *
 * `variantKey` is what a cart write targets and comes from the site rather than being built from
 * the sku. Prices are the numbers the site sends; `wasPrice` and `savedAmount` are absent unless
 * the product is on special, never zero.
 */
export interface CatalogueProduct {
  readonly sku: string;
  readonly variantKey: string;
  readonly name: string;
  readonly brand: string | undefined;
  readonly department: string | undefined;
  /**
   * False when the store this result answered for does not sell the product. The price fields
   * are then absent: "not sold here" is an answer, and zero would read as free.
   */
  readonly rangedAtStore: boolean;
  readonly price: number | undefined;
  readonly unitPrice: string | undefined;
  readonly isSpecial: boolean | undefined;
  readonly isClubPrice: boolean | undefined;
  readonly wasPrice: number | undefined;
  readonly savedAmount: number | undefined;
  readonly availability: string;
  readonly purchasingUnit: string;
  readonly canBuyByWeight: boolean;
  readonly minimumQuantity: number;
  readonly quantityIncrement: number;
  readonly slug: string;
  readonly storeKey: string;
}

export function toCatalogueProduct(product: RawSearchProduct): CatalogueProduct {
  // The site lists variants in the order its own UI offers them; the first is the default.
  const variant = product.variants[0];
  if (variant === undefined) throw new UnbuyableProductError(product.sku);
  const price = variant.variantPrice;
  return {
    sku: product.sku,
    variantKey: variant.variantKey,
    name: tidy(product.productName),
    brand: optionalText(product.brand),
    department: optionalText(product.categoryHierarchyNames.lvl1[0]),
    rangedAtStore: price !== null,
    price: price?.sellingPrice,
    unitPrice: price === null ? undefined : describeCupPrice(price.cupPrice, price.cupUnit),
    isSpecial: price?.isSpecial,
    isClubPrice: price?.isClubPrice,
    wasPrice: price?.wasPrice ?? undefined,
    savedAmount: price?.savedAmount ?? undefined,
    availability: variant.availabilityStatus,
    purchasingUnit: variant.unitOfMeasure,
    canBuyByWeight: product.variants.some((entry) => entry.unitOfMeasure === "KG"),
    minimumQuantity: variant.purchaseUnit.minimumQty,
    quantityIncrement: variant.purchaseUnit.incrementQty,
    slug: product.slug,
    storeKey: product.storeKey,
  };
}

/**
 * Splits a results grid into products and everything else.
 *
 * The grid mixes products with advertising (`SponsoredProduct`, `GamResultItem`,
 * `ContentInGridResultItem`), which is why `pageSize` can exceed the number of products. A product
 * that does not parse is described rather than dropped silently.
 */
export interface ProductGrid {
  readonly products: readonly CatalogueProduct[];
  readonly advertisingExcluded: number;
  readonly rejections: readonly string[];
}

function describeIssues(error: Readonly<ZodError>): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

export function toProductGrid(page: Readonly<RawProductPage>): ProductGrid {
  const products: CatalogueProduct[] = [];
  const rejections: string[] = [];
  const advertising: string[] = [];

  for (const item of page.results) {
    if (item.__typename !== "ProductSummary") {
      advertising.push(item.__typename);
      continue;
    }
    const parsed = searchProductSchema.safeParse(item);
    if (!parsed.success) {
      rejections.push(describeIssues(parsed.error));
      continue;
    }
    try {
      products.push(toCatalogueProduct(parsed.data));
    } catch (error: unknown) {
      rejections.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { products, advertisingExcluded: advertising.length, rejections };
}

/** One of the account's saved delivery addresses: somewhere the cart can be moved to. */
/**
 * Everything the site states about one product.
 *
 * Every attribute is present or explicitly absent: a null from the site means it stated nothing,
 * which is never the same as stating none. `allergens` and `ingredients` keep that distinction in
 * their own types rather than as empty strings.
 */
export interface ProductDetail {
  readonly sku: string;
  readonly variantKey: string;
  readonly name: string;
  readonly brand: string | undefined;
  readonly slug: string;
  readonly storeKey: string;
  /**
   * False when the store asked about does not sell this product. Everything about price is then
   * absent rather than zero, and the product is not buyable there at all.
   */
  readonly rangedAtStore: boolean;
  readonly price: number | undefined;
  readonly unitPrice: string | undefined;
  readonly isSpecial: boolean | undefined;
  readonly isClubPrice: boolean | undefined;
  readonly wasPrice: number | undefined;
  readonly savedAmount: number | undefined;
  readonly availability: string;
  readonly purchasingUnit: string;
  readonly canBuyByWeight: boolean;
  readonly minimumQuantity: number;
  readonly quantityIncrement: number;
  readonly barcode: string | undefined;
  readonly size: string | undefined;
  readonly description: string | undefined;
  readonly countryOfOrigin: string | undefined;
  readonly ingredients: IngredientInfo;
  readonly allergens: AllergenInfo;
  readonly servingSize: string | undefined;
  readonly servingsPerPack: string | undefined;
  readonly directions: string | undefined;
  readonly warnings: readonly string[];
  readonly ageRestriction: string | undefined;
  readonly isLiquor: boolean;
  readonly isTobacco: boolean;
  readonly isOwnBrand: boolean;
  readonly nutrition: readonly NutritionPanel[];
  readonly images: readonly ProductImage[];
  /** Every variant the product is sold as, with the key each one is bought by. */
  readonly variants: readonly ProductVariantSummary[];
}

export interface ProductImage {
  readonly url: string;
  /** Absent when the site did not state one; not assumed to be an image. */
  readonly contentType: string | undefined;
  readonly name: string | undefined;
  readonly altText: string | undefined;
}

export interface ProductVariantSummary {
  readonly variantKey: string;
  readonly unit: string;
  /** Absent when this variant is not sold at the store asked about. */
  readonly price: number | undefined;
  readonly minimumQuantity: number;
  readonly quantityIncrement: number;
  readonly availability: string;
}

/** One nutrition panel, kept whole: mixing "Per 100g" with "Per Serve" figures would misreport. */
export interface NutritionPanel {
  readonly basis: string;
  readonly energy: string | undefined;
  readonly protein: string | undefined;
  readonly fatTotal: string | undefined;
  readonly fatSaturated: string | undefined;
  readonly carbohydrate: string | undefined;
  readonly sugars: string | undefined;
  readonly dietaryFibre: string | undefined;
  readonly sodium: string | undefined;
}

export function toProductDetail(
  product: RawDetailProduct,
  variants: readonly RawDetailVariant[],
  storeKey: string,
): ProductDetail {
  // The site lists variants in the order its own UI offers them, so the first is the product's
  // default. Picking a differently-priced one instead would also swap the size, ingredients,
  // allergens and nutrition to a variant the shopper did not ask about.
  const variant = variants[0];
  if (variant === undefined) throw new UnbuyableProductError(product.key);
  const price = variant.variantPrice;
  const warnings = [variant.tgaWarnings, variant.productWarnings]
    .map(optionalText)
    .filter((warning): warning is string => warning !== undefined);

  return {
    sku: product.key,
    variantKey: variant.key,
    name: tidy(product.name),
    brand: optionalText(product.brand),
    rangedAtStore: price !== null,
    price: price?.sellingPrice,
    unitPrice: price === null ? undefined : describeCupPrice(price.cupPrice, price.cupUnit),
    isSpecial: price?.isSpecial,
    isClubPrice: price?.isClubPrice,
    wasPrice: price?.wasPrice ?? undefined,
    savedAmount: price?.savedAmount ?? undefined,
    availability: variant.availabilityStatus,
    purchasingUnit: variant.purchasingUnits.unit,
    canBuyByWeight: variants.some((entry) => entry.purchasingUnits.unit === "KG"),
    minimumQuantity: variant.purchasingUnits.minimumQty,
    quantityIncrement: variant.purchasingUnits.incrementQty,
    slug: product.slug,
    storeKey,
    barcode: optionalText("barcode" in variant ? variant.barcode : undefined),
    size: optionalText(variant.volumeSize),
    description: optionalText(
      variant.richDescription === null || variant.richDescription === undefined
        ? undefined
        : toPlainText(variant.richDescription),
    ),
    countryOfOrigin: optionalText(variant.countryOfOrigin),
    // The site sends one sentence, not a list; an empty one is "not stated" either way.
    ingredients: toIngredientInfo(
      !("ingredients" in variant) ||
        variant.ingredients === null ||
        variant.ingredients === undefined
        ? null
        : { ingredients: [variant.ingredients] },
    ),
    // A null allergen statement is "not stated" and must never read as "contains none".
    allergens: toAllergenInfo(
      !("allergenContained" in variant) ||
        variant.allergenContained === null ||
        variant.allergenContained === undefined
        ? null
        : [variant.allergenContained],
      undefined,
    ),
    servingSize: optionalText("servingSize" in variant ? variant.servingSize : undefined),
    servingsPerPack: optionalText(
      "servingsPerPack" in variant ? variant.servingsPerPack : undefined,
    ),
    directions: optionalText(variant.directionsOfUse),
    warnings,
    // A number upstream (18 on wine), reported as text; absent, never rendered as 0.
    ageRestriction:
      variant.ageRestriction === null || variant.ageRestriction === undefined
        ? undefined
        : String(variant.ageRestriction),
    isLiquor: product.isLiquor,
    isTobacco: product.isTobacco,
    isOwnBrand: product.isOwnBrand,
    nutrition: ("nutritionalInformation" in variant
      ? (variant.nutritionalInformation ?? [])
      : []
    ).map((panel) => ({
      basis: panel.quantityPerUnit,
      energy: optionalText(panel.energy),
      protein: optionalText(panel.protein),
      fatTotal: optionalText(panel.fatTotal),
      fatSaturated: optionalText(panel.fatTotalSaturated),
      carbohydrate: optionalText(panel.carbohydrate),
      sugars: optionalText(panel.carbohydrateSugars),
      dietaryFibre: optionalText(panel.dietaryFibre),
      sodium: optionalText(panel.sodium),
    })),
    images: variant.assets.map((asset) => ({
      url: asset.url,
      // The site publishes assets that are not photographs. What each one is stays with it
      // rather than being assumed, so a caller fetching one knows what it asked for.
      contentType: asset.contentType ?? undefined,
      name: asset.name ?? undefined,
      altText: asset.altText ?? undefined,
    })),
    variants: variants.map((entry) => ({
      variantKey: entry.key,
      unit: entry.purchasingUnits.unit,
      price: entry.variantPrice?.sellingPrice,
      minimumQuantity: entry.purchasingUnits.minimumQty,
      quantityIncrement: entry.purchasingUnits.incrementQty,
      availability: entry.availabilityStatus,
    })),
  };
}

/** A node of the browse tree. `key` is what browse_category takes; the slug is what a URL shows. */
export interface CategoryNode {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly level: number;
  readonly children: readonly CategoryNode[];
  /**
   * How many children were left unlisted because the requested depth ran out. Present only when
   * some were: a node shown with an empty `children` and no count is a leaf, and the two must be
   * distinguishable or a caller reads "no subcategories" from a depth limit.
   */
  readonly childrenNotListed?: number;
}

/**
 * The tree to a given depth.
 *
 * The site returns all four levels in one response — 773 nodes, ~150 KB — which is more than a
 * caller can read and more than most will accept. `depth` bounds what is returned, and a node
 * whose children were cut says how many it has rather than appearing childless.
 */
export function toCategoryNode(node: RawCategoryNode, depth: number): CategoryNode {
  const children = node.children ?? [];
  if (depth <= 0) {
    return {
      key: node.key,
      name: tidy(node.name),
      slug: node.displaySlug,
      level: node.level,
      children: [],
      ...(children.length === 0 ? {} : { childrenNotListed: children.length }),
    };
  }
  return {
    key: node.key,
    name: tidy(node.name),
    slug: node.displaySlug,
    level: node.level,
    children: children.map((child) => toCategoryNode(child, depth - 1)),
  };
}

/** A pick-up location. `distanceKm` is absent when the site did not state one. */
export interface Store {
  readonly id: string;
  readonly name: string;
  readonly address: string | undefined;
  readonly suburb: string | undefined;
  readonly distanceKm: number | undefined;
}

export function toStore(location: RawLocation): Store {
  const lines = ["line1", "line2", "line3", "line4", "line5"]
    .map((key) => optionalText(location.address.lines[key as "line1"]))
    .filter((line): line is string => line !== undefined);
  return {
    id: location.id,
    name: tidy(location.name),
    address: lines.length === 0 ? undefined : lines.join(", "),
    suburb: optionalText(location.address.locality.suburb),
    distanceKm: location.distance ?? undefined,
  };
}

export interface SavedAddress {
  readonly id: string;
  readonly address: string;
}

export function toSavedAddresses(
  addresses: readonly Readonly<{
    id: string;
    lines: Readonly<Record<string, string | null | undefined>>;
  }>[],
): readonly SavedAddress[] {
  return addresses.map((entry) => ({
    id: entry.id,
    address: ["line1", "line2", "line3", "line4", "line5"]
      .map((key) => optionalText(entry.lines[key]))
      .filter((line): line is string => line !== undefined)
      .join(", "),
  }));
}

export interface DeliveryWindow {
  readonly name: string;
  readonly method: string;
  readonly kind: string;
  readonly type: string;
  readonly available: boolean;
  readonly unavailableReasons: readonly string[];
  readonly startTime: string;
  readonly endTime: string;
  readonly storeId: string;
  readonly store: string | undefined;
  readonly allows: readonly string[];
  readonly fees: readonly DeliveryFee[];
}

export interface DeliveryFeeBand {
  readonly fromOrderValue: string;
  readonly toOrderValue: string | undefined;
  readonly amount: string;
}

export interface DeliveryFee {
  readonly type: string;
  /** Absent on every window observed; the bands are what applies. Never read as free. */
  readonly amount: string | undefined;
  readonly bands: readonly DeliveryFeeBand[];
}

const UNAVAILABLE_TAG = "unavailableReason:";

export function toDeliveryWindow(window: RawFulfilmentProposition): DeliveryWindow {
  // The site repeats tags; a reason stated twice is one reason.
  const tags = [...new Set(window.tags)];
  return {
    name: tidy(window.name),
    method: window.method,
    kind: window.kind,
    type: window.type,
    available: window.available,
    unavailableReasons: tags
      .filter((tag) => tag.startsWith(UNAVAILABLE_TAG))
      .map((tag) => tag.slice(UNAVAILABLE_TAG.length)),
    startTime: window.startTime,
    endTime: window.endTime,
    storeId: window.storeId,
    store: optionalText(window.store?.name),
    allows: tags.filter((tag) => !tag.startsWith(UNAVAILABLE_TAG)),
    fees: window.fees.map((fee) => ({
      type: fee.type,
      amount: typeof fee.amountInCents === "number" ? formatCents(fee.amountInCents) : undefined,
      bands: fee.rateCard.map((band) => ({
        fromOrderValue: formatCents(band.orderValueMinInCents),
        toOrderValue:
          typeof band.orderValueMaxInCents === "number"
            ? formatCents(band.orderValueMaxInCents)
            : undefined,
        amount: formatCents(band.amountInCents),
      })),
    })),
  };
}

export interface DeliveryWindows {
  readonly windows: readonly DeliveryWindow[];
  readonly returned: number;
  readonly available: number;
  readonly coverage: string;
}

/**
 * The windows offered, narrowed to what was asked for and never silently.
 *
 * The site answers with both methods at once — a delivery address returns hundreds of pick-up
 * slots at a nearby store alongside its own handful of delivery windows — so `method` bounds the
 * result and the coverage sentence states what each filter removed. Reporting all of them
 * unfiltered means a caller asked about delivery reads pick-up times at a store the shopper does
 * not use.
 */
export function toDeliveryWindows(
  raw: readonly RawFulfilmentProposition[],
  availableOnly: boolean,
  method: string | undefined,
  limit: number,
): DeliveryWindows {
  const all = raw.map(toDeliveryWindow);
  const wanted = method?.toLowerCase();
  const ofMethod =
    wanted === undefined ? all : all.filter((window) => window.method.toLowerCase() === wanted);
  const matching = availableOnly ? ofMethod.filter((window) => window.available) : ofMethod;
  const windows = matching.slice(0, limit);
  const available = all.filter((window) => window.available).length;
  const methodsSeen = [...new Set(all.map((window) => window.method))].sort();
  return {
    windows,
    returned: windows.length,
    available,
    coverage:
      `The site returned ${all.length} windows for this location (${methodsSeen.join(", ") || "no method stated"}), ` +
      `${available} of them available.` +
      (wanted === undefined ? "" : ` Narrowed to method '${method ?? ""}': ${ofMethod.length}.`) +
      (availableOnly ? ` Unavailable ones excluded: ${matching.length} left.` : "") +
      (windows.length < matching.length
        ? ` Only the first ${windows.length} of those ${matching.length} are listed — this is ` +
          `NOT all of them, so do not answer earliest/latest/none-available from this set.`
        : ` All ${windows.length} matching windows are listed.`) +
      ` This server cannot book a window and has no tool that does: choose one on the website. ` +
      `Delivery fees are charged by order value, so each window lists bands rather than one amount.`,
  };
}

/**
 * Allergen information has exactly two observed states. The site has no way to assert that a
 * product contains no allergens, so "notStated" must never be rendered as "no allergens": an
 * empty array was observed on paneer whose own ingredients list is milk.
 */
export type AllergenInfo =
  | {
      readonly status: "stated";
      readonly contains: readonly string[];
      readonly mayContain: string | undefined;
    }
  | { readonly status: "notStated"; readonly warning: string };

const ALLERGENS_NOT_STATED =
  "Woolworths has not published allergen information for this product. This is NOT a statement " +
  "that it is free of allergens — products containing known allergens come back empty here. " +
  "Read the ingredients, check the label photo with get_product_label, or check the packaging.";

export function toAllergenInfo(
  allergens: readonly string[] | null | undefined,
  mayContain: string | null | undefined,
): AllergenInfo {
  const contains = (allergens ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (contains.length === 0) return { status: "notStated", warning: ALLERGENS_NOT_STATED };
  return { status: "stated", contains, mayContain: optionalText(mayContain) };
}

/** Ingredients are absent often enough that an empty list must not read as "no ingredients". */
export type IngredientInfo =
  | { readonly status: "stated"; readonly ingredients: readonly string[] }
  | { readonly status: "notStated"; readonly warning: string };

export function toIngredientInfo(
  ingredients: Readonly<{ ingredients: readonly string[] }> | null | undefined,
): IngredientInfo {
  const listed = (ingredients?.ingredients ?? []).filter((entry) => entry.trim() !== "");
  if (listed.length === 0) {
    return {
      status: "notStated",
      warning:
        "Woolworths has not published an ingredients list for this product. Absence here says " +
        "nothing about what it contains; check the label photo with get_product_label.",
    };
  }
  return { status: "stated", ingredients: listed };
}

/** "Fresh Salad & Herbs" -> "fresh-salad-herbs", matching the site's own browse URLs. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Anything carrying the cart's shopping mode: the cart read, or the mutation that moves it. */
export interface HasShoppingMode {
  readonly shoppingMode: RawCustomerCart["shoppingMode"];
  readonly fulfilment: RawCustomerCart["fulfilment"];
}

export function toFulfilment(cart: HasShoppingMode, catalogueStoreKey?: string): Fulfilment {
  const mode = cart.shoppingMode;
  const proposition = cart.fulfilment.fulfilmentProposition;
  const address = mode.deliveryAddress;
  const lines =
    address === null
      ? undefined
      : [address.lines.line1, address.lines.line2, address.lines.line3]
          .map(optionalText)
          .filter((line): line is string => line !== undefined)
          .join(", ");

  const isDelivery = mode.mode.toLowerCase() === "delivery";
  const fulfilment = {
    mode: mode.mode,
    address: optionalText(lines),
    suburb: optionalText(address?.locality.suburb),
    pickupLocation: isDelivery ? undefined : optionalText(mode.pickupLocation?.name),
    store: optionalText(proposition?.store?.name),
    storeId: optionalText(proposition?.storeId),
    method: optionalText(proposition?.method),
    catalogueStoreKey: optionalText(catalogueStoreKey),
  };
  // A field that cannot apply in this mode is not "not reported": listing it there would make
  // the list mean two different things at once.
  const fields = (
    isDelivery
      ? ["address", "suburb", "store", "storeId", "method", "catalogueStoreKey"]
      : ["address", "suburb", "pickupLocation", "store", "storeId", "method", "catalogueStoreKey"]
  ) as readonly (keyof typeof fulfilment)[];
  return {
    ...fulfilment,
    notReported: fields.filter((field) => fulfilment[field] === undefined),
  };
}

function toPlainText(html: string): string {
  return tidy(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'"),
  );
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapses the site's three ways of saying "nothing" — absent, null, empty string — into one. */
export function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * A line of the GraphQL cart.
 *
 * `variantKey` is what a write targets. It is carried out to the caller because a product sold
 * both by weight and by the item has one line per pricing, and the sku alone does not identify
 * which of them a line is.
 */
export interface CartLine {
  readonly sku: string;
  readonly variantKey: string;
  readonly name: string;
  readonly quantity: number;
  readonly pricingUnit: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly lineDiscount: string;
  readonly canSubstitute: boolean;
  readonly slug: string;
}

/**
 * Money as text, from the cents the site sends.
 *
 * A field the site did not report is absent and named in `notReported`, never rendered as $0.00.
 * A field it reported as zero is rendered as $0.00: "no fee on this cart" and "a fee of zero" are
 * different answers, and on this API the site is capable of stating either.
 */
export interface CartTotals {
  readonly subtotal: string | undefined;
  readonly savings: string | undefined;
  readonly deliveryFees: string | undefined;
  readonly bagFees: string | undefined;
  readonly totalIncludingDeliveryFees: string | undefined;
  readonly notReported: readonly string[];
}

export interface CartValidationFailure {
  readonly rule: string;
  readonly message: string;
  readonly title: string | undefined;
  readonly resolution: string | undefined;
  readonly affectedSkus: readonly string[];
}

export interface CartFee {
  readonly type: string;
  readonly description: string;
  readonly amount: string;
}

/**
 * `lineCount` counts distinct product variants; `totalQuantity` is the site's own item count,
 * which counts a weighed line as one item however many kilograms it holds. They are not
 * interchangeable and neither is a sum of the other.
 */
export interface Cart {
  readonly lines: readonly CartLine[];
  readonly lineCount: number;
  readonly totalQuantity: number;
  readonly totals: CartTotals;
  readonly fees: readonly CartFee[];
  readonly state: string;
  readonly checkoutBlocked: boolean;
  readonly blockers: readonly CartValidationFailure[];
}

/** Cents to text. Negative amounts keep the sign ahead of the symbol. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** The site's fee types, as observed. An unmapped type stays in `fees` and out of `totals`. */
const DELIVERY_FEE_TYPE = "standardDeliveryFee";
const BAG_FEE_TYPE = "bagFee";

export function toCartFees(fees: readonly RawCartFee[]): readonly CartFee[] {
  return fees.map((fee) => ({
    type: fee.type,
    description: fee.description,
    amount: formatCents(fee.amountAsCents),
  }));
}

export function toCartTotals(cart: RawCustomerCart): CartTotals {
  const fee = (type: string): string | undefined => {
    const found = cart.fees.find((entry) => entry.type === type);
    return found === undefined ? undefined : formatCents(found.amountAsCents);
  };
  const totals = {
    // Products only; `orderSubtotal` and `total` both already carry the fees.
    subtotal: formatCents(cart.pricing.productSubtotal.afterDiscountAsCents),
    savings: formatCents(cart.pricing.productSubtotal.discountAmountAsCents),
    deliveryFees: fee(DELIVERY_FEE_TYPE),
    bagFees: fee(BAG_FEE_TYPE),
    totalIncludingDeliveryFees: formatCents(cart.pricing.total.afterDiscountAsCents),
  };
  const fields = [
    "subtotal",
    "savings",
    "deliveryFees",
    "bagFees",
    "totalIncludingDeliveryFees",
  ] as const;
  return {
    ...totals,
    // A fee the site has not determined — no fulfilment window chosen — is absent, not zero.
    notReported: fields.filter((field) => totals[field] === undefined),
  };
}

export function toCartBlockers(validation: RawCartValidation): readonly CartValidationFailure[] {
  return validation.failedValidations.map((failure) => ({
    rule: failure.ruleName,
    message: failure.message,
    title: optionalText(failure.title),
    resolution: optionalText(failure.resolution),
    affectedSkus: failure.affectedSkus,
  }));
}

/**
 * Raised when a line names a variant its own product does not list. The line's name and pricing
 * unit are only available from that variant, and neither may be guessed: a cart line shown under
 * the wrong name is worse than a cart that fails to load.
 */
export class UnmappableCartLineError extends Error {
  constructor(line: RawCartLineItem) {
    super(
      `Cart line for sku ${line.sku} names variant '${line.productVariantSku}', which its product ` +
        `does not list. The product carries: ${line.product.variants.map((variant) => variant.key).join(", ") || "(no variants)"}.`,
    );
    this.name = "UnmappableCartLineError";
  }
}

export function toCartLine(line: RawCartLineItem): CartLine {
  const variant = line.product.variants.find((entry) => entry.key === line.productVariantSku);
  if (variant === undefined) throw new UnmappableCartLineError(line);
  return {
    sku: line.sku,
    variantKey: line.productVariantSku,
    name: tidy(variant.name),
    quantity: line.quantity,
    pricingUnit: variant.purchasingUnits.unit,
    unitPrice: formatCents(line.unitPrice.afterDiscountAsCents),
    lineTotal: formatCents(line.lineTotal.afterDiscountAsCents),
    lineDiscount: formatCents(line.lineTotal.discountAmountAsCents),
    canSubstitute: line.canSubstitute,
    slug: line.product.slug,
  };
}

export function toCart(cart: RawCustomerCart): Cart {
  return {
    lines: cart.lineItems.map(toCartLine),
    lineCount: cart.totalUniqueProductSku,
    totalQuantity: cart.totalItemQuantity,
    totals: toCartTotals(cart),
    fees: toCartFees(cart.fees),
    state: cart.cartState,
    checkoutBlocked: !cart.validationResult.isValid,
    blockers: toCartBlockers(cart.validationResult),
  };
}

/**
 * Whether a list response is the whole answer or a slice of it.
 *
 * `coverage` is a sentence, not a pair of integers, because a caller that has to compare two
 * numbers to notice truncation will not notice it. Superlative and completeness claims are only
 * safe when `complete` is true.
 */
export interface Coverage {
  readonly returned: number;
  readonly matchesAvailable: number | undefined;
  readonly page: number;
  readonly complete: boolean;
  readonly coverage: string;
}

/** The site returns -1 for a query it could not resolve, e.g. an unknown category slug. */
const UNRESOLVED_COUNT = -1;

export interface CoverageInput {
  readonly returned: number;
  readonly matchesAvailable: number | undefined;
  readonly page: number;
  readonly noun: string;
  readonly refinement: string;
  /** Set when an in-stock filter was applied, so an empty result can say what emptied it. */
  readonly filteredToInStock?: boolean;
  /**
   * How many rows the site returned that could not be described. A short page and a page the
   * server could not read are different answers, and the refinement text tells the caller to
   * stop paging when a page comes back short.
   */
  readonly unparsed?: number;
}

/**
 * A completeness claim is only made from a coherent count.
 *
 * `returned >= matchesAvailable` used to be enough, which made two wrong guarantees: a `-1` count
 * satisfied `0 >= -1`, and the site's own off-by-one satisfied `40 >= 39`. Both produced "Safe to
 * compare across the full set" from a set that was neither complete nor countable.
 */
export function toCoverage(input: CoverageInput): Coverage {
  const { returned, matchesAvailable, page, noun, refinement } = input;
  const inStockNote =
    input.filteredToInStock === true
      ? ` Out-of-stock ${noun} were excluded, which alone can empty a result — retry with includeOutOfStock to tell an empty category from an unavailable one.`
      : "";
  const unparsed = input.unparsed ?? 0;
  const unparsedNote =
    unparsed === 0
      ? ""
      : ` ${unparsed} further ${unparsed === 1 ? "row" : "rows"} on this page could not be ` +
        `described and ${unparsed === 1 ? "is" : "are"} missing from the list — see \`unparsed\`. ` +
        `This page is short for that reason, not because the results ran out.`;

  if (matchesAvailable === undefined || matchesAvailable <= UNRESOLVED_COUNT) {
    return {
      returned,
      matchesAvailable: undefined,
      page,
      complete: false,
      coverage:
        `Showing ${returned} ${noun} (page ${page}). The site did not report a usable total` +
        (matchesAvailable === undefined
          ? ""
          : ` (it returned ${matchesAvailable}, its value for a query it could not resolve — check the arguments)`) +
        `, so this is NOT known to be all of them. Do not make cheapest/only/none-available ` +
        `claims from this set; ${refinement}${inStockNote}`,
    };
  }

  if (returned > matchesAvailable) {
    return {
      returned,
      matchesAvailable,
      page,
      complete: false,
      coverage:
        `Showing ${returned} ${noun} while the site reports only ${matchesAvailable} matches ` +
        `(page ${page}). The counts disagree, so neither is trustworthy and this is NOT known to ` +
        `be the full set. Do not make cheapest/only/none-available claims from it;` +
        ` ${refinement}${inStockNote}${unparsedNote}`,
    };
  }

  if (page === 1 && returned === matchesAvailable && unparsed === 0) {
    return {
      returned,
      matchesAvailable,
      page,
      complete: true,
      coverage:
        returned === 0
          ? `Complete: the site reports no matching ${noun} at all.${inStockNote}`
          : `Complete: all ${returned} matching ${noun} are included. Safe to compare across the full set.`,
    };
  }

  return {
    returned,
    matchesAvailable,
    page,
    complete: false,
    coverage:
      `Showing ${returned} of about ${matchesAvailable} matching ${noun} (page ${page}) — the ` +
      `count is the site's own and has been observed off by one. This is NOT the full result ` +
      `set. Do not answer cheapest/best/only/none-available from these ${returned} alone; ` +
      `${refinement}${inStockNote}${unparsedNote}`,
  };
}

/** A page past the end is stated, so an empty list is never read as "nothing matches". */
export function toEmptyPageCoverage(
  page: number,
  matchesAvailable: number,
  noun: string,
): Coverage {
  return {
    returned: 0,
    matchesAvailable,
    page,
    complete: false,
    coverage:
      `Page ${page} is past the end: ${matchesAvailable} matching ${noun} exist but none fall on ` +
      `this page. This does not mean there are no matches — request an earlier page.`,
  };
}

/**
 * The site's "Buy it again" list: products this shopper has bought before, most frequent first.
 *
 * This is NOT the complete purchase history. `byBuyAgain` is a list the site curates and orders by
 * frequency, and its `totalCount` counts that list, not everything the shopper has ever bought.
 * Paging to the end therefore proves the list is exhausted and nothing more, which is why the
 * coverage sentence here refuses the completeness claim the generic builder would make.
 *
 * The grid also carries advertising tiles (`GamResultItem`, `ContentInGridResultItem`). Those are
 * never mapped into the list — presenting advertising as established preference is the failure
 * this shape exists to prevent — and `advertisingExcluded` says how many were dropped so their
 * absence is stated rather than silent.
 */
/** The page envelope `byBuyAgain` returns. */
export type RawPastPurchasesPage = Readonly<RawPastPurchasesResponse["My"]["products"]>;

export interface PastPurchases extends Coverage {
  readonly products: readonly PurchasedProduct[];
  readonly advertisingExcluded: number;
}

/**
 * A previously purchased product.
 *
 * `variantKey` is carried because it is what a cart write targets, and this list is the most
 * common source of one. `size` is absent: this API publishes no pack size, and the variant name
 * usually carries it instead.
 */
export interface PurchasedProduct {
  readonly sku: string;
  readonly variantKey: string;
  readonly name: string;
  readonly brand: string | undefined;
  readonly department: string | undefined;
  /** False when the store this answered for does not sell it; the price fields are then absent. */
  readonly rangedAtStore: boolean;
  readonly price: number | undefined;
  readonly unitPrice: string | undefined;
  readonly isSpecial: boolean | undefined;
  readonly wasPrice: number | undefined;
  readonly availability: string;
  readonly purchasingUnit: string;
  readonly canBuyByWeight: boolean;
  readonly slug: string;
}

/**
 * Raised when a product carries no variant. Every field a caller needs to buy it — the key to
 * write, the price, the availability — lives on the variant, so a product without one cannot be
 * described at all and must not be listed as though it could be bought.
 */
export class UnbuyableProductError extends Error {
  constructor(sku: string) {
    super(`Product ${sku} arrived with no variants, so it carries no price, availability or key.`);
    this.name = "UnbuyableProductError";
  }
}

export function toPurchasedProduct(product: RawProductSummary): PurchasedProduct {
  // The site lists variants in the order its own UI offers them; the first is the default.
  const variant = product.variants[0];
  if (variant === undefined) throw new UnbuyableProductError(product.sku);
  const price = variant.variantPrice;
  return {
    sku: product.sku,
    variantKey: variant.variantKey,
    name: tidy(product.productName),
    brand: optionalText(product.brand),
    department: optionalText(product.categoryHierarchyNames.lvl1[0]),
    rangedAtStore: price !== null,
    price: price?.sellingPrice,
    unitPrice: price === null ? undefined : describeCupPrice(price.cupPrice, price.cupUnit),
    isSpecial: price?.isSpecial,
    // Null unless the product is on special. Absent, never a previous price of zero.
    wasPrice: price?.wasPrice ?? undefined,
    availability: variant.availabilityStatus,
    purchasingUnit: variant.unitOfMeasure,
    canBuyByWeight: product.variants.some((entry) => entry.unitOfMeasure === "KG"),
    slug: product.slug,
  };
}

/**
 * Coverage for the "Buy it again" list, which never claims completeness.
 *
 * `complete` stays false even on the last page: the list is the site's own selection, so having
 * all of it is not having the purchase history. The sentence says so in words, because a caller
 * that has to infer it from a flag will not.
 */
function buyAgainCoverage(returned: number, listSize: number, page: number): Coverage {
  return {
    returned,
    matchesAvailable: listSize,
    page,
    complete: false,
    coverage:
      `Showing ${returned} of the ${listSize} products in the site's "Buy it again" list ` +
      `(page ${page}), ordered by how often this shopper buys them. This list is the retailer's ` +
      `own selection, NOT the complete purchase history: a product's absence from it is not ` +
      `evidence the shopper has never bought it, and reaching the last page does not make it ` +
      `their full history. Never answer "they have never bought X" from this.`,
  };
}

/** Null on products the site publishes no cup price for; absent rather than rendered as $0. */
function describeCupPrice(cupPrice: number | null | undefined, cupUnit: string | null | undefined) {
  if (typeof cupPrice !== "number") return undefined;
  const unit = optionalText(cupUnit);
  return unit === undefined ? `$${cupPrice.toFixed(2)}` : `$${cupPrice.toFixed(2)} / ${unit}`;
}

/**
 * Splits the buy-again grid into products and advertising, and states the coverage.
 *
 * Failure policy matches the search grid: one unreadable row must not cost the shopper the whole
 * page, so a product that does not parse is counted and described in `rejections` rather than
 * dropped silently.
 */
export function toPastPurchases(
  page: Readonly<RawPastPurchasesPage>,
  requestedPage: number,
): PastPurchases & { readonly rejections: readonly string[] } {
  const products: PurchasedProduct[] = [];
  const rejections: string[] = [];
  const advertising: string[] = [];

  for (const item of page.results) {
    if (item.__typename !== "ProductSummary") {
      advertising.push(item.__typename);
      continue;
    }
    const parsed = productSummarySchema.safeParse(item);
    if (!parsed.success) {
      rejections.push(describeIssues(parsed.error));
      continue;
    }
    try {
      products.push(toPurchasedProduct(parsed.data));
    } catch (error: unknown) {
      rejections.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ...buyAgainCoverage(products.length, page.totalCount, requestedPage),
    products,
    advertisingExcluded: advertising.length,
    rejections,
  };
}
/**
 * What the site actually did to a requested cart line.
 *
 * Woolworths silently substitutes its own quantity for some products — sku 133211 requested at
 * 0.3 Kg comes back as 0.5 Kg. Echoing the applied value alone is not enough: a caller who asked
 * for 0.3 and is handed 0.5 without a word has been given a different order than the one they
 * placed. The divergence is stated in words, not left to be spotted by comparing two numbers.
 */
export interface CartAdjustment {
  readonly adjusted: boolean;
  readonly note: string | undefined;
}

/** Quantities are decimal kilograms, so equality needs a tolerance rather than ===. */
const QUANTITY_EPSILON = 0.0001;

export function toCartAdjustment(
  requestedQuantity: number,
  appliedQuantity: number,
  requestedPricingUnit: string,
  appliedPricingUnit: string,
  quantityIncrement: number | undefined,
): CartAdjustment {
  const quantityChanged = Math.abs(requestedQuantity - appliedQuantity) > QUANTITY_EPSILON;
  // A removal has no pricing unit to get wrong. The site echoes the product's own unit, which
  // differs from whatever was sent, and reporting that as an adjustment is noise in the channel
  // reserved for real quantity surprises.
  const isRemoval = requestedQuantity === 0;
  const unitChanged =
    !isRemoval &&
    requestedPricingUnit.trim().toLowerCase() !== appliedPricingUnit.trim().toLowerCase();
  if (!quantityChanged && !unitChanged) return { adjusted: false, note: undefined };

  const parts: string[] = [];
  if (quantityChanged) {
    parts.push(
      `Woolworths applied ${appliedQuantity} ${appliedPricingUnit}, not the ${requestedQuantity} ` +
        `${requestedPricingUnit} requested.`,
    );
    const reason = explainQuantityChange(requestedQuantity, appliedQuantity, quantityIncrement);
    if (reason !== undefined) parts.push(reason);
  }
  if (unitChanged) {
    parts.push(
      `Woolworths priced this line as ${appliedPricingUnit}, not the ${requestedPricingUnit} requested.`,
    );
  }
  parts.push(
    isRemoval
      ? "Tell the shopper what is actually left on the line."
      : "Tell the shopper what was actually added, not what was asked for.",
  );
  return { adjusted: true, note: parts.join(" ") };
}

/**
 * Why the site changed a quantity.
 *
 * Weight-priced products are sold in fixed steps — bananas in 0.25 kg, limes in 0.1 kg — and a
 * request between steps is rounded to one. The step is the site's own `incrementQty`, so the
 * explanation is its rule rather than an inference from an average weight.
 */
function explainQuantityChange(
  requested: number,
  applied: number,
  quantityIncrement: number | undefined,
): string | undefined {
  if (quantityIncrement === undefined || quantityIncrement <= 0) {
    return applied > requested
      ? "The site raised it, which usually means a minimum order quantity for this product."
      : "The site lowered it, which usually means a stock or maximum-quantity limit.";
  }
  return (
    `This product is sold in steps of ${quantityIncrement}, and ${requested} is not one of them, ` +
    `so the site moved to the nearest step it sells.`
  );
}

export interface OrderFulfilment {
  readonly method: string;
  readonly location: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly address: string | undefined;
}

export interface PastOrder {
  /** The reference as the site shows it: "CD" and eight digits. */
  readonly reference: string;
  readonly placedAt: string;
  readonly status: string;
  readonly fulfilmentStatus: string;
  readonly total: string;
  readonly isAmendable: boolean;
  readonly hasInvoice: boolean;
  readonly fulfilments: readonly OrderFulfilment[];
}

/**
 * Deliberately not a `Coverage`: that type carries a page number, and the orders list has no
 * pages. Reporting one would name a page the site never honoured.
 */
export interface OrderHistory {
  readonly returned: number;
  readonly matchesAvailable: number;
  readonly complete: boolean;
  readonly coverage: string;
  readonly orders: readonly PastOrder[];
}

/** One order's contents, as the site records them. */
export interface PurchasedOrder {
  readonly reference: string;
  readonly placedAt: string;
  readonly status: string;
  readonly total: string;
  readonly items: readonly PurchasedLine[];
  /**
   * Lines the site returned with a quantity of zero. Carried separately rather than counted as
   * purchases or dropped: what a zero means here is not documented by the API.
   */
  readonly zeroQuantityLines: readonly PurchasedLine[];
}

export interface PurchasedLine {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
}

export interface PurchaseHistory {
  readonly returned: number;
  readonly matchesAvailable: number;
  readonly complete: boolean;
  readonly coverage: string;
  readonly orders: readonly PurchasedOrder[];
}

export function toPurchaseHistory(
  page: Readonly<RawPurchaseHistoryResponse["orders"]>,
  filter: string,
): PurchaseHistory {
  const orders = page.results.map((order) => {
    const lines = order.lineItems.map((item) => ({
      sku: item.productKey,
      name: tidy(item.product.name),
      quantity: item.quantity,
    }));
    return {
      reference: order.orderNumber,
      placedAt: order.createdDateTime,
      status: order.orderStatus,
      total: formatCents(order.total.afterDiscountInCents),
      items: lines.filter((line) => line.quantity > 0),
      zeroQuantityLines: lines.filter((line) => line.quantity === 0),
    };
  });
  const returned = orders.length;
  const coherent = page.totalCount >= 0 && returned <= page.totalCount;
  const noun = `${filter.toLowerCase()} orders`;
  return {
    returned,
    matchesAvailable: page.totalCount,
    complete: coherent && returned === page.totalCount,
    coverage: !coherent
      ? `Showing the contents of ${returned} ${noun} while the site reported ${page.totalCount} ` +
        `as the total, which cannot be right. Treat neither number as the size of this history.`
      : returned === page.totalCount
        ? `The contents of all ${returned} ${noun} the site offers. It returns a recent window ` +
          `and does not say how far back it reaches, so a product's absence here is not evidence ` +
          `it was never bought. There are no further pages: the site ignores the page index.`
        : `Showing the contents of ${returned} of ${page.totalCount} ${noun}. The rest cannot be ` +
          `fetched: the site ignores the page index. Do not answer never-bought/how-often from these.`,
    orders,
  };
}

export function toPastOrder(order: RawOrder): PastOrder {
  return {
    reference: order.orderNumber,
    placedAt: order.createdDateTime,
    status: order.orderStatus,
    fulfilmentStatus: order.fulfilmentStatus,
    total: formatCents(order.total.afterDiscountInCents),
    isAmendable: order.isAmendable,
    hasInvoice: order.hasInvoice,
    fulfilments: order.fulfilments.map((fulfilment) => ({
      method: fulfilment.method,
      location: fulfilment.fulfilmentLocation.name,
      startTime: fulfilment.startTime,
      endTime: fulfilment.endTime,
      address: joinAddressLines(fulfilment.address.lines),
    })),
  };
}

/** Lines 3 to 5 are null on every observed order; an all-null address is absent, not "". */
function joinAddressLines(
  lines: Readonly<Record<string, string | null | undefined>>,
): string | undefined {
  const present = ["line1", "line2", "line3", "line4", "line5"]
    .map((key) => optionalText(lines[key]))
    .filter((line): line is string => line !== undefined);
  return present.length === 0 ? undefined : present.join(", ");
}

/**
 * `currentPage` reads -1 on an empty result and `pageSize` echoes how many rows came back rather
 * than the size requested, so neither is used to describe the page. The requested page is passed
 * in instead.
 */
export function toOrderHistory(
  page: Readonly<{ results: readonly RawOrder[]; totalCount: number }>,
  filter: string,
): OrderHistory {
  const returned = page.results.length;
  const noun = `${filter.toLowerCase()} orders`;
  const coherent = page.totalCount >= 0 && returned <= page.totalCount;
  return {
    returned,
    matchesAvailable: page.totalCount,
    // The site ignores `pageIndex`, so this response is everything it will hand over. Complete
    // means complete of what the site offers, which is not the same as the account's whole
    // history: it returns a recent window and states no start date for it.
    complete: coherent && returned === page.totalCount,
    coverage: !coherent
      ? `Showing ${returned} ${noun}, but the site reported ${page.totalCount} as the total, ` +
        `which cannot be right. Treat neither number as the size of this account's history.`
      : returned === page.totalCount
        ? `All ${returned} ${noun} the site offers. It returns a recent window and does not say ` +
          `how far back it reaches, so an order's absence here is not evidence it was never ` +
          `placed. There are no further pages: the site ignores the page index.`
        : `Showing ${returned} of ${page.totalCount} ${noun}. The remaining ` +
          `${page.totalCount - returned} cannot be fetched: the site ignores the page index, so ` +
          `every page returns this same set. Do not answer first/last/total-spend from these.`,
    orders: page.results.map(toPastOrder),
  };
}
