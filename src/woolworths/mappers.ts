import type { ZodError } from "zod";
import { productItemSchema } from "./schemas.js";
import type {
  RawDepartment,
  RawFacet,
  RawFulfilmentEnvelope,
  RawPrice,
  RawProductDetail,
  RawProductItem,
  RawPastOrder,
  RawSearchListItem,
  RawShopperEnvelope,
  RawSize,
  RawStoreArea,
  RawTrolleyItem,
} from "./schemas.js";

/**
 * The shape the model sees (DESIGN.md, "Compact product shape"). Absent fields are `undefined`
 * and drop out of the JSON, so the model is never handed a field it cannot use.
 */
export type PurchasingUnit = "Each" | "Kg";

export interface CompactProduct {
  /** The department this product sits in, used to narrow a search after the fact. */
  readonly department: string | undefined;
  readonly sku: string;
  readonly name: string;
  readonly brand: string | undefined;
  readonly size: string | undefined;
  readonly price: number;
  readonly unitPrice: string | undefined;
  readonly isSpecial: boolean;
  readonly wasPrice: number | undefined;
  readonly availability: string;
  /** The pricingUnit to send when putting this product in the trolley. */
  readonly purchasingUnit: PurchasingUnit;
  /** When true the caller may choose Kg instead and pass a decimal quantity. */
  readonly canBuyByWeight: boolean;
}

export interface ProductDetail extends CompactProduct {
  readonly breadcrumb: readonly string[];
  readonly description: string | undefined;
  readonly specialEnds: string | undefined;
  readonly allergens: AllergenInfo;
  readonly ingredients: IngredientInfo;
  readonly claims: readonly string[];
  readonly endorsements: readonly string[];
  readonly warnings: readonly string[];
  readonly origins: readonly string[];
  readonly healthStarRating: number | undefined;
  readonly contents: readonly string[];
  readonly directions: string | undefined;
  readonly servingSuggestion: string | undefined;
  readonly nutrition: unknown;
  /** Average weight of one item, for products sold by weight. */
  readonly averageWeightPerUnit: number | undefined;
  readonly imageUrls: readonly string[];
}

/**
 * A refinement the caller can actually act on: the counts carry the same slugs
 * `browse_category` takes, resolved from the numeric facet ids through the department tree.
 */
export interface CategoryCount {
  readonly group: string;
  readonly name: string;
  readonly productCount: number;
  readonly department: string | undefined;
  readonly aisle: string | undefined;
  readonly shelf: string | undefined;
}

/** Numeric facet id -> the slugs needed to browse it. */
export interface CategoryIndex {
  readonly departments: ReadonlyMap<string, string>;
  readonly aisles: ReadonlyMap<string, { department: string; aisle: string }>;
  readonly shelves: ReadonlyMap<string, { department: string; aisle: string; shelf: string }>;
}

export function buildCategoryIndex(departments: readonly Department[]): CategoryIndex {
  const departmentsById = new Map<string, string>();
  const aislesById = new Map<string, { department: string; aisle: string }>();
  const shelvesById = new Map<string, { department: string; aisle: string; shelf: string }>();

  for (const department of departments) {
    departmentsById.set(department.id, department.slug);
    for (const aisle of department.aisles) {
      aislesById.set(aisle.id, { department: department.slug, aisle: aisle.slug });
      for (const shelf of aisle.shelves) {
        shelvesById.set(shelf.id, {
          department: department.slug,
          aisle: aisle.slug,
          shelf: shelf.slug,
        });
      }
    }
  }
  return { departments: departmentsById, aisles: aislesById, shelves: shelvesById };
}

/**
 * The delivery context a price is quoted against.
 *
 * `suburbId` is deliberately absent: the shell reports it as 0 even after a successful suburb
 * change, so surfacing it only invited the reader to think the change had failed. `address` and
 * `fulfilmentStoreId` are what actually move.
 */
export interface Fulfilment {
  readonly address: string;
  readonly method: string;
  readonly areaId: number | undefined;
  readonly fulfilmentStoreId: number | undefined;
  readonly isAddressInDeliveryZone: boolean;
}

export interface Shelf {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface Aisle {
  readonly id: string;
  readonly name: string;
  /**
   * Derived from the name: the browse tree gives aisles no slug, but `dasFilter` wants one, and
   * the site's own URLs are the slugified name ("Rose Wine" -> "rose-wine").
   */
  readonly slug: string;
  readonly productCount: number;
  readonly shelves: readonly Shelf[];
}

export interface DepartmentSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly aisleCount: number;
}

export interface Department extends DepartmentSummary {
  readonly aisles: readonly Aisle[];
}

export interface Store {
  readonly id: number;
  readonly name: string;
  readonly address: string;
  /** A store is listed under each region it belongs to. */
  readonly areas: readonly string[];
}

const UNKNOWN_AVAILABILITY = "Unknown";

/**
 * `selectedPurchasingUnit` is the line's chosen unit where one has been chosen; `unit` is the
 * product's own. Anything the site does not report as Kg is a counted item.
 */
function toPurchasingUnit(unit: string, selected: string | null | undefined): PurchasingUnit {
  const effective = optionalText(selected) ?? unit;
  return effective.trim().toLowerCase() === "kg" ? "Kg" : "Each";
}

/**
 * Allergen information has exactly two observed states. The site has no way to assert that a
 * product contains no allergens, so "notStated" must never be rendered as "no allergens": an
 * empty array was observed on paneer whose own ingredients list is milk.
 */
export type AllergenInfo =
  | { readonly status: "stated"; readonly contains: readonly string[]; readonly mayContain: string | undefined }
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
  ingredients: { ingredients: readonly string[] } | null | undefined,
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

export function toCompactProduct(item: RawProductItem): CompactProduct {
  return {
    sku: item.sku,
    name: tidy(item.name),
    brand: optionalText(item.brand),
    size: describeSize(item.size),
    price: item.price.salePrice,
    unitPrice: describeUnitPrice(item.size),
    isSpecial: item.price.isSpecial,
    wasPrice: previousPrice(item.price),
    availability: optionalText(item.availabilityStatus) ?? UNKNOWN_AVAILABILITY,
    department: item.departments?.[0]?.name,
    purchasingUnit: toPurchasingUnit(item.unit, item.selectedPurchasingUnit),
    canBuyByWeight: item.supportsBothEachAndKgPricing,
  };
}

export function toProductDetail(detail: RawProductDetail): ProductDetail {
  return {
    sku: detail.sku,
    name: tidy(detail.name),
    brand: optionalText(detail.brand),
    size: describeSize(detail.size),
    price: detail.price.salePrice,
    unitPrice: describeUnitPrice(detail.size),
    isSpecial: detail.price.isSpecial,
    wasPrice: previousPrice(detail.price),
    availability: optionalText(detail.availabilityStatus) ?? UNKNOWN_AVAILABILITY,
    department: detail.breadcrumb?.department?.name,
    purchasingUnit: toPurchasingUnit(detail.unit, detail.selectedPurchasingUnit),
    canBuyByWeight: detail.supportsBothEachAndKgPricing,
    breadcrumb: toBreadcrumb(detail.breadcrumb),
    description: describeProduct(detail.description),
    specialEnds: detail.price.isSpecial ? optionalText(detail.price.promotionEndDate) : undefined,
    allergens: toAllergenInfo(detail.allergens, detail.allergenMaybePresent),
    ingredients: toIngredientInfo(detail.ingredients),
    claims: detail.claims ?? [],
    endorsements: detail.endorsements ?? [],
    warnings: detail.warnings ?? [],
    origins: detail.origins ?? [],
    healthStarRating: detail.healthStarRating ?? undefined,
    contents: detail.contents ?? [],
    directions: optionalText(detail.directions),
    servingSuggestion: optionalText(detail.servingSuggestion),
    nutrition: detail.nutrition ?? undefined,
    averageWeightPerUnit: detail.averageWeightPerUnit ?? undefined,
    imageUrls: (detail.images ?? []).map((image) => image.big),
  };
}

export function toCategoryCounts(
  facets: readonly RawFacet[],
  index: CategoryIndex | undefined,
): readonly CategoryCount[] {
  return facets.map((facet) => {
    const group = facet.group ?? facet.key;
    const located = locate(group, facet.value, index);
    return {
      group,
      name: facet.name,
      productCount: facet.productCount,
      department: located?.department,
      aisle: located?.aisle,
      shelf: located?.shelf,
    };
  });
}

function locate(
  group: string,
  value: string,
  index: CategoryIndex | undefined,
): { department: string; aisle?: string; shelf?: string } | undefined {
  if (index === undefined) return undefined;
  switch (group) {
    case "Department": {
      const department = index.departments.get(value);
      return department === undefined ? undefined : { department };
    }
    case "Aisle":
      return index.aisles.get(value);
    case "Shelf":
      return index.shelves.get(value);
    default:
      // Facet groups beyond the three browse levels exist (brand, dietary); they are not
      // browsable through browse_category, so they carry counts without slugs.
      return undefined;
  }
}

export function toDepartment(department: RawDepartment): Department {
  const aisles = department.dasFacets.map((facet) => ({
    id: facet.value,
    name: facet.name,
    slug: slugify(facet.name),
    productCount: facet.productCount,
    // A null shelfResponses is the site's way of saying the aisle has no shelves.
    shelves: (facet.shelfResponses ?? []).map((shelf) => ({
      id: String(shelf.id),
      name: shelf.label,
      slug: shelf.url,
    })),
  }));
  return {
    id: String(department.id),
    name: department.label,
    slug: department.url,
    aisleCount: aisles.length,
    aisles,
  };
}

export function toDepartmentSummary(department: Department): DepartmentSummary {
  return {
    id: department.id,
    name: department.name,
    slug: department.slug,
    aisleCount: department.aisleCount,
  };
}

export function toStores(areas: readonly RawStoreArea[]): readonly Store[] {
  const byId = new Map<number, { store: Store; areas: string[] }>();

  for (const area of areas) {
    for (const store of area.storeAddresses) {
      const existing = byId.get(store.id);
      if (existing !== undefined) {
        existing.areas.push(area.name);
        continue;
      }
      byId.set(store.id, {
        areas: [area.name],
        store: {
          id: store.id,
          name: tidy(store.name),
          // The site packs suburb, centre and postcode into one comma-joined string.
          address: tidy(store.address.split(",").join(", ")),
          areas: [],
        },
      });
    }
  }

  return [...byId.values()].map(({ store, areas: memberships }) => ({
    ...store,
    areas: meaningfulAreas(memberships),
  }));
}

/** Every store also appears under this catch-all, which says nothing once a real region is known. */
const ALL_LOCATIONS_AREA = "All Pick up locations";

function meaningfulAreas(areas: readonly string[]): readonly string[] {
  const named = [...new Set(areas)].filter((area) => area !== ALL_LOCATIONS_AREA);
  return named.length > 0 ? named : [ALL_LOCATIONS_AREA];
}

/** "Fresh Salad & Herbs" -> "fresh-salad-herbs", matching the site's own browse URLs. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toFulfilment(envelope: RawFulfilmentEnvelope): Fulfilment {
  const raw = envelope.context.fulfilment;
  return {
    address: optionalText(raw.address) ?? "Unknown",
    method: optionalText(raw.method) ?? "Unknown",
    areaId: raw.areaId ?? undefined,
    fulfilmentStoreId: raw.fulfilmentStoreId ?? undefined,
    isAddressInDeliveryZone: raw.isAddressInDeliveryZone ?? false,
  };
}

export interface SearchItemPartition {
  readonly products: readonly RawProductItem[];
  /** Tile types found alongside the products, e.g. `PromoTile`. */
  readonly skippedTypes: readonly string[];
  /** One message per entry typed `Product` whose shape did not parse. */
  readonly rejections: readonly string[];
}

/**
 * Splits a `products.items` array into products, non-product tiles, and entries that claimed to
 * be products but did not parse. Failure policy: continue — one unreadable row must not cost the
 * shopper the whole result page — and the caller logs `rejections` so the loss is visible.
 */
export function partitionSearchItems(items: readonly RawSearchListItem[]): SearchItemPartition {
  const products: RawProductItem[] = [];
  const skippedTypes = new Set<string>();
  const rejections: string[] = [];

  for (const item of items) {
    if (item.type !== "Product") {
      skippedTypes.add(item.type);
      continue;
    }
    const parsed = productItemSchema.safeParse(item);
    if (parsed.success) products.push(parsed.data);
    else rejections.push(describeIssues(parsed.error));
  }

  return { products, skippedTypes: [...skippedTypes], rejections };
}

function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function previousPrice(price: RawPrice): number | undefined {
  const showOriginal = price.isSpecial && price.originalPrice > price.salePrice;
  return showOriginal ? price.originalPrice : undefined;
}

function describeSize(size: RawSize | null | undefined): string | undefined {
  return optionalText(size?.volumeSize);
}

function describeUnitPrice(size: RawSize | null | undefined): string | undefined {
  const cupPrice = size?.cupPrice;
  const cupMeasure = optionalText(size?.cupMeasure);
  if (cupPrice === null || cupPrice === undefined || cupPrice === 0 || cupMeasure === undefined) {
    return undefined;
  }
  return `$${cupPrice.toFixed(2)} / ${cupMeasure}`;
}

function toBreadcrumb(breadcrumb: RawProductDetail["breadcrumb"]): readonly string[] {
  if (breadcrumb === null || breadcrumb === undefined) return [];
  return [breadcrumb.department, breadcrumb.aisle, breadcrumb.shelf]
    .map((node) => optionalText(node?.name))
    .filter((name): name is string => name !== undefined);
}

/** Descriptions arrive as HTML; the model wants the words, not the markup. */
function describeProduct(html: string | null | undefined): string | undefined {
  const markup = optionalText(html);
  if (markup === undefined) return undefined;
  return toPlainText(markup);
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
function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export interface AccountStatus {
  readonly signedIn: boolean;
  readonly firstName: string | undefined;
  readonly hasOnecard: boolean;
  readonly orderCount: number | undefined;
}

export interface CartLine {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly price: number;
  readonly size: string | undefined;
  readonly availability: string | undefined;
}

export interface CartTotals {
  readonly subtotal: string;
  readonly savings: string;
  readonly deliveryFees: string;
  readonly bagFees: string;
  readonly totalIncludingDeliveryFees: string;
}

/**
 * `lineCount` counts distinct products; `totalQuantity` sums the quantities on them, so a cart of
 * 19 lines can hold 23 items. The site reports both and they are not interchangeable.
 */
export interface Cart {
  readonly lines: readonly CartLine[];
  readonly lineCount: number;
  readonly totalQuantity: number;
  readonly totals: CartTotals;
}

export function toAccountStatus(envelope: RawShopperEnvelope): AccountStatus {
  const shopper = envelope.context.shopper;
  return {
    signedIn: shopper.isLoggedIn ?? false,
    firstName: optionalText(shopper.firstName),
    hasOnecard: shopper.hasOnecard ?? false,
    orderCount: shopper.orderCount ?? undefined,
  };
}

export function toCartLine(item: RawTrolleyItem): CartLine {
  const quantity = item.quantity;
  return {
    sku: item.sku,
    name: tidy(item.name),
    // Loose produce reports `{ value }`; packaged lines report a plain number. Both are quantities.
    quantity: typeof quantity === "number" ? quantity : quantity.value,
    price: item.price.salePrice,
    size: describeSize(item.size),
    availability: optionalText(item.availabilityStatus),
  };
}

/**
 * Walks the trolley payload for lines. The site groups items by category on some routes and
 * returns them flat on others, so anything with a nested `items` array is descended into rather
 * than assumed to be a line.
 */
export function toCartLines(items: readonly RawTrolleyItem[]): readonly CartLine[] {
  return items.map(toCartLine);
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

export function toCoverage(
  returned: number,
  matchesAvailable: number | undefined,
  page: number,
  noun: string,
  refinement: string,
): Coverage {
  if (matchesAvailable === undefined) {
    return {
      returned,
      matchesAvailable: undefined,
      page,
      complete: false,
      coverage:
        `Showing ${returned} ${noun} (page ${page}). The total number of matches is not known, ` +
        `so this may not be all of them. Do not make cheapest/only/none-available claims from ` +
        `this set; ${refinement}`,
    };
  }
  if (page === 1 && returned >= matchesAvailable) {
    return {
      returned,
      matchesAvailable,
      page,
      complete: true,
      coverage: `Complete: all ${returned} matching ${noun} are included. Safe to compare across the full set.`,
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
      `${refinement}`,
  };
}

/** A page past the end is stated, so an empty list is never read as "nothing matches". */
export function toEmptyPageCoverage(page: number, matchesAvailable: number, noun: string): Coverage {
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
 * One labelled block from the past-purchases endpoint.
 *
 * `isPurchaseHistory` exists because the endpoint mixes the shopper's real history with a
 * promotional block. Merging them would present advertising as established preference, so the
 * two are never combined and the flag decides which is which.
 */
export interface PurchaseSection extends Coverage {
  readonly section: string;
  readonly isPurchaseHistory: boolean;
  readonly products: readonly CompactProduct[];
}

/** The site's own label for the block that reflects what the shopper actually bought. */
const PURCHASE_HISTORY_SECTION = "items previously purchased";

export function toPurchaseSection(section: {
  section: string;
  itemCount: number;
  products: readonly RawProductItem[];
}): PurchaseSection {
  const isPurchaseHistory = section.section.trim().toLowerCase() === PURCHASE_HISTORY_SECTION;
  return {
    section: section.section,
    isPurchaseHistory,
    products: section.products.map(toCompactProduct),
    ...historyCoverage(section.products.length, isPurchaseHistory),
  };
}

function historyCoverage(returned: number, isPurchaseHistory: boolean): Coverage {
  const coverage = isPurchaseHistory
    ? `Showing ${returned} previously purchased products. The site returns a curated "your usuals" ` +
      `selection here and does not report how many products the full purchase history holds, so ` +
      `whether this is all of it is NOT knowable from this response. Do not claim the shopper has ` +
      `never bought something on the strength of its absence here.`
    : `Showing ${returned} promotional suggestions. These are advertising chosen by the retailer, ` +
      `NOT products this shopper has bought. Never describe them as the shopper's purchases, ` +
      `habits or preferences.`;
  return { returned, matchesAvailable: undefined, page: 1, complete: false, coverage };
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
  averageWeightPerUnit: number | undefined,
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
    const reason = explainQuantityChange(requestedQuantity, appliedQuantity, averageWeightPerUnit);
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

function explainQuantityChange(
  requested: number,
  applied: number,
  averageWeightPerUnit: number | undefined,
): string | undefined {
  if (averageWeightPerUnit === undefined || averageWeightPerUnit <= 0) {
    return applied > requested
      ? "The site raised it, which usually means a minimum order quantity for this product."
      : "The site lowered it, which usually means a stock or maximum-quantity limit.";
  }
  const units = applied / averageWeightPerUnit;
  const wholeUnits = Math.round(units);
  if (wholeUnits >= 1 && Math.abs(units - wholeUnits) < 0.01) {
    return (
      `${applied} is ${wholeUnits} item${wholeUnits === 1 ? "" : "s"} at this product's average ` +
      `unit weight of ${averageWeightPerUnit}, so the site rounded to whole items.`
    );
  }
  return applied > requested
    ? "The site raised it, which usually means a minimum order quantity for this product."
    : "The site lowered it, which usually means a stock or maximum-quantity limit.";
}


export interface PastOrder {
  readonly orderId: number;
  /** The reference as the site shows it, e.g. prefix "CD" with the order number. */
  readonly reference: string;
  readonly orderedAt: string;
  readonly method: string;
  readonly status: string;
  readonly total: number;
  readonly deliveryFee: number;
  readonly fulfilmentDate: string;
  readonly fulfilmentTime: string;
  readonly isEditable: boolean;
}

export interface OrderHistory extends Coverage {
  readonly orders: readonly PastOrder[];
}

export function toPastOrder(order: RawPastOrder): PastOrder {
  return {
    orderId: order.orderId,
    reference: `${order.prefix}${order.orderId}`,
    orderedAt: order.orderDate,
    method: order.method,
    status: order.status,
    total: order.total,
    deliveryFee: order.deliveryFee,
    fulfilmentDate: order.fulfilmentDate,
    fulfilmentTime: order.fulfilmentTime,
    isEditable: order.isEditable,
  };
}

export function toOrderHistory(orders: readonly RawPastOrder[], totalItems: number): OrderHistory {
  return {
    orders: orders.map(toPastOrder),
    returned: orders.length,
    matchesAvailable: totalItems,
    page: 1,
    complete: false,
    coverage:
      `Showing ${orders.length} of ${totalItems} orders the site returns by default. Its own ` +
      `filter list calls this window "Past 180 Days" and ignores a filter parameter, so orders ` +
      `older than that may exist and are NOT included. Do not tell the shopper this is every ` +
      `order they have placed, or that they have never ordered something.`,
  };
}
