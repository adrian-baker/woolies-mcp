/**
 * Canned `/api/graphql` cart envelopes for the offline checks.
 *
 * The checks that exercise a dead or anonymous session must not reach the network: without a
 * scripted transport, `checkAccountAccess` and `getCart` would call the real site and the check
 * would pass or fail on whether Woolworths happened to answer.
 *
 * The canning is at the `fetch` boundary, not above it, so every check runs the same
 * `graphql-request` client the server does — including its conversion of an `errors` array into
 * an exception, which is the behaviour most worth having under test.
 */
import { FetchGraphQlTransport, readOperationName } from "../src/woolworths/graphql-client.js";

export const SIGNED_IN_CART_KEY = "00000000-0000-4000-8000-000000000001";
export const GUEST_CART_KEY = "11111111-1111-4111-8111-111111111111";

/** The error the site returns for a field guests may not select. Captured live. */
const GUEST_ERROR = {
  message: "Field 'me' is not allowed for guest users.",
  extensions: { code: "BANNED_OPERATION", service: "customer-graph-wnz" },
};

/** An empty cart, as the site sends one: no fees determined, no lines, everything zero. */
export function emptyCartEnvelope(key: string, me: { readonly id: string } | null): string {
  return JSON.stringify({
    data: {
      me,
      customerCart: {
        key,
        cartState: "Active",
        totalItemQuantity: 0,
        totalUniqueProductSku: 0,
        fees: [],
        shoppingMode: { mode: "Delivery", deliveryAddress: null, pickupLocation: null },
        fulfilment: { fulfilmentProposition: null },
        validationResult: { isValid: true, failedValidations: [] },
        checkout: { amountToPayAsCents: 0, chargeableTotalAsCents: 0, loyaltySpendAsCents: 0 },
        pricing: {
          orderSubtotal: {
            beforeDiscountAsCents: 0,
            afterDiscountAsCents: 0,
            discountAmountAsCents: 0,
          },
          productSubtotal: {
            beforeDiscountAsCents: 0,
            afterDiscountAsCents: 0,
            discountAmountAsCents: 0,
          },
          total: { beforeDiscountAsCents: 0, afterDiscountAsCents: 0, discountAmountAsCents: 0 },
        },
        lineItems: [],
      },
    },
    ...(me === null ? { errors: [GUEST_ERROR] } : {}),
  });
}

/** Responds to any request with `body`, so a check never reaches the network. */
function cannedFetch(body: () => string): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body(), { status: 200, headers: { "content-type": "application/json" } }),
    );
}

/** Always answers as a guest: the session is not honoured on the GraphQL half at all. */
export class GuestGraphQlTransport extends FetchGraphQlTransport {
  constructor() {
    super(cannedFetch(() => emptyCartEnvelope(GUEST_CART_KEY, null)));
  }
}

/**
 * Answers as the signed-in shopper once, then as a guest: the session died between the two.
 *
 * Counts what it was asked to do, so a check can assert that no write was attempted after the
 * death rather than only that the caller saw an error.
 */
export class DyingGraphQlTransport extends FetchGraphQlTransport {
  private readonly counts = { sends: 0, writes: 0 };

  constructor() {
    const counts = { sends: 0, writes: 0 };
    super((_input, init) => {
      counts.sends += 1;
      if (readOperationName(init?.body)?.startsWith("Set") === true) counts.writes += 1;
      const alive = counts.sends === 1;
      return Promise.resolve(
        new Response(
          emptyCartEnvelope(
            alive ? SIGNED_IN_CART_KEY : GUEST_CART_KEY,
            alive ? { id: SIGNED_IN_CART_KEY } : null,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    this.counts = counts;
  }

  get sends(): number {
    return this.counts.sends;
  }

  get writes(): number {
    return this.counts.writes;
  }
}

/**
 * A product grid holding exactly the skus given, as the aliased pre-flight search asks for them.
 *
 * `unit` is what the site says the product is sold by; `ranged` false is a product the store
 * does not carry, which the site reports as a null `variantPrice`.
 */
export function searchGridEnvelope(
  aliases: readonly {
    readonly alias: string;
    readonly sku: string | undefined;
    readonly unit?: string;
    readonly ranged?: boolean;
    /** A product sold both by weight and by the item carries two variants. */
    readonly alsoEach?: boolean;
  }[],
): string {
  const My: Record<string, unknown> = {};
  for (const entry of aliases) {
    const results =
      entry.sku === undefined
        ? []
        : [
            {
              __typename: "ProductSummary",
              sku: entry.sku,
              productName: `Product ${entry.sku}`,
              brand: null,
              slug: `product-${entry.sku}`,
              storeKey: "9583",
              categoryHierarchyNames: { lvl1: ["Pantry"] },
              variants: [
                {
                  variantKey: `${entry.sku}-${entry.unit === "KG" ? "KG" : "EA"}`,
                  name: `Product ${entry.sku}`,
                  unitOfMeasure: entry.unit ?? "EACH",
                  availabilityStatus: "IN_STOCK",
                  purchaseUnit: {
                    unit: entry.unit ?? "EACH",
                    minimumQty: 1,
                    maximumQty: 99,
                    incrementQty: 1,
                    defaultQty: 1,
                  },
                  variantPrice:
                    entry.ranged === false
                      ? null
                      : {
                          sellingPrice: 1,
                          wasPrice: null,
                          savedAmount: null,
                          cupPrice: null,
                          cupUnit: null,
                          isSpecial: false,
                          isClubPrice: false,
                        },
                },
                ...(entry.alsoEach === true
                  ? [
                      {
                        variantKey: `${entry.sku}-EA`,
                        name: `Product ${entry.sku}`,
                        unitOfMeasure: "EACH",
                        availabilityStatus: "IN_STOCK",
                        purchaseUnit: {
                          unit: "EACH",
                          minimumQty: 1,
                          maximumQty: 99,
                          incrementQty: 1,
                          defaultQty: 1,
                        },
                        variantPrice: {
                          sellingPrice: 1,
                          wasPrice: null,
                          savedAmount: null,
                          cupPrice: null,
                          cupUnit: null,
                          isSpecial: false,
                          isClubPrice: false,
                        },
                      },
                    ]
                  : []),
              ],
            },
          ];
    My[entry.alias] = {
      totalCount: results.length,
      pageSize: results.length,
      totalPages: 1,
      currentPage: 0,
      results,
    };
  }
  return JSON.stringify({ data: { My } });
}

/** A cart-write response holding the lines given. */
export function cartWriteEnvelope(
  lines: readonly { readonly variantKey: string; readonly quantity: number }[],
): string {
  return JSON.stringify({
    data: {
      setCartLineItemQuantity: {
        key: SIGNED_IN_CART_KEY,
        totalItemQuantity: lines.length,
        totalUniqueProductSku: lines.length,
        validationResult: { isValid: true, failedValidations: [] },
        checkout: { amountToPayAsCents: 0, chargeableTotalAsCents: 0, loyaltySpendAsCents: 0 },
        pricing: {
          orderSubtotal: {
            beforeDiscountAsCents: 0,
            afterDiscountAsCents: 0,
            discountAmountAsCents: 0,
          },
          productSubtotal: {
            beforeDiscountAsCents: 0,
            afterDiscountAsCents: 0,
            discountAmountAsCents: 0,
          },
          total: { beforeDiscountAsCents: 0, afterDiscountAsCents: 0, discountAmountAsCents: 0 },
        },
        lineItems: lines.map((line) => ({
          sku: line.variantKey.split("-")[0] ?? line.variantKey,
          productVariantSku: line.variantKey,
          quantity: line.quantity,
          lineTotal: { afterDiscountAsCents: 0, discountAmountAsCents: 0 },
          unitPrice: { beforeDiscountAsCents: 0, afterDiscountAsCents: 0 },
        })),
      },
    },
  });
}

/** One product as `products(keys:, storeKey:)` returns it, or a null payload for an unknown key. */
export function productDetailEnvelope(
  product:
    | undefined
    | {
        readonly sku: string;
        readonly units: readonly string[];
        readonly ranged?: boolean;
      },
): string {
  if (product === undefined) return JSON.stringify({ data: null });
  return JSON.stringify({
    data: {
      products: [
        {
          key: product.sku,
          brand: null,
          name: `Product ${product.sku}`,
          slug: `product-${product.sku}`,
          isLiquor: false,
          isTobacco: false,
          isOwnBrand: false,
          variants: product.units.map((unit) => ({
            __typename: "GroceryVariant",
            key: `${product.sku}-${unit === "KG" ? "KG" : "EA"}`,
            sku: product.sku,
            barcode: null,
            volumeSize: null,
            richDescription: null,
            countryOfOrigin: null,
            ingredients: null,
            allergenContained: null,
            servingSize: null,
            servingsPerPack: null,
            directionsOfUse: null,
            tgaWarnings: null,
            productWarnings: null,
            ageRestriction: null,
            availabilityStatus: "IN_STOCK",
            purchasingUnits: {
              unit,
              minimumQty: 1,
              maximumQty: 99,
              incrementQty: 1,
              defaultQty: 1,
            },
            variantPrice:
              product.ranged === false
                ? null
                : {
                    sellingPrice: 1,
                    wasPrice: null,
                    savedAmount: null,
                    cupPrice: null,
                    cupUnit: null,
                    isSpecial: false,
                    isClubPrice: false,
                  },
            nutritionalInformation: null,
            assets: [],
          })),
        },
      ],
    },
  });
}

/** The refusal the site sends when a batch carries a line it will not take. */
export function batchRefusalEnvelope(): string {
  return JSON.stringify({
    errors: [
      {
        message: "These items are no longer available at this store.",
        extensions: { code: "ProductStoreRangingAvailability" },
      },
    ],
  });
}
