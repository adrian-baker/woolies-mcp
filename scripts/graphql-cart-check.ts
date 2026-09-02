/**
 * The GraphQL cart contract, checked without a network.
 *
 * `/api/graphql` answers everything with HTTP 200, including failure and including an empty guest
 * cart served to a caller whose session has expired. These checks assert that each of those is
 * refused loudly, and that the captured payloads still map to what the tools promise.
 *
 * The fixtures are the two carts captured on 2 September 2026 — one holding a line, one empty —
 * projected onto the fields this server's documents select. The cart key is replaced with a
 * placeholder; nothing here carries account details.
 *
 * Run with `npm run check:graphql-cart`.
 */
import { Kind } from "graphql";
import { NotSignedInError } from "../src/woolworths/auth.js";
import { GraphQlCart, WrongCartError } from "../src/woolworths/graphql-cart.js";
import { FetchGraphQlTransport, GraphQlError } from "../src/woolworths/graphql-client.js";
import {
  CART_READ_DOCUMENT,
  CART_READ_OPERATION,
  multiSearchAlias,
  multiSearchDocument,
  multiSearchVariables,
  pricingUnitFromVariantKey,
  variantKeyFor,
  variantKeysFor,
} from "../src/woolworths/graphql-documents.js";
import {
  UnmappableCartLineError,
  toCart,
  toDeliveryWindow,
  toDeliveryWindows,
  toProductDetail,
} from "../src/woolworths/mappers.js";
import {
  cartReadResponseSchema,
  detailProductSchema,
  detailVariantSchema,
  fulfilmentPropositionSchema,
} from "../src/woolworths/schemas.js";

const CART_KEY = "00000000-0000-4000-8000-000000000001";

const CARTS = {
  populated: {
    key: "00000000-0000-4000-8000-000000000001",
    cartState: "Active",
    totalItemQuantity: 1,
    totalUniqueProductSku: 1,
    fees: [
      {
        amountAsCents: 1400,
        description: "standardDeliveryFee",
        type: "standardDeliveryFee",
      },
      {
        amountAsCents: 150,
        description: "bagFee",
        type: "bagFee",
      },
    ],
    shoppingMode: {
      mode: "Delivery",
      deliveryAddress: {
        id: "00000000-0000-4000-8000-0000000000ad",
        lines: {
          line1: "1 Example Road",
          line2: "Sampleville",
          line3: "Auckland 0000",
          line4: "",
          line5: "",
        },
        locality: { suburb: "Sampleville", city: "Auckland", state: null },
        coordinates: { latitude: -36.9, longitude: 174.6 },
      },
      pickupLocation: { id: "9101", name: "Example Woolworths" },
    },
    fulfilment: {
      fulfilmentProposition: {
        storeId: "9583",
        method: "delivery",
        store: { storeId: "9064", name: "Example Woolworths" },
      },
    },
    validationResult: {
      isValid: false,
      failedValidations: [
        {
          ruleName: "ValidateMinimumDeliveryValue",
          message: "Add a few more items to your cart to reach the minimum subtotal.",
          affectedSkus: [],
          resolution: null,
          title: "Delivery has a $50 minimum spend",
        },
      ],
    },
    checkout: {
      amountToPayAsCents: 1750,
      chargeableTotalAsCents: 1750,
      loyaltySpendAsCents: 0,
    },
    pricing: {
      orderSubtotal: {
        beforeDiscountAsCents: 1750,
        afterDiscountAsCents: 1750,
        discountAmountAsCents: 0,
      },
      productSubtotal: {
        beforeDiscountAsCents: 200,
        afterDiscountAsCents: 200,
        discountAmountAsCents: 0,
      },
      total: {
        beforeDiscountAsCents: 1750,
        afterDiscountAsCents: 1750,
        discountAmountAsCents: 0,
      },
    },
    lineItems: [
      {
        sku: "245902",
        productVariantSku: "245902-KG",
        quantity: 0.2,
        canSubstitute: true,
        lineTotal: {
          afterDiscountAsCents: 200,
          discountAmountAsCents: 0,
        },
        unitPrice: {
          beforeDiscountAsCents: 998,
          afterDiscountAsCents: 998,
        },
        product: {
          slug: "woolworths-fresh_limes-245902",
          variants: [
            {
              key: "245902-KG",
              name: "Woolworths Fresh Limes Min Order 100g",
              purchasingUnits: {
                unit: "KG",
                minimumQty: 0.1,
                maximumQty: 100,
                incrementQty: 0.1,
                defaultQty: 0.1,
              },
            },
            {
              key: "245902-EA",
              name: "Woolworths Fresh Limes Min Order 100g",
              purchasingUnits: {
                unit: "EACH",
                minimumQty: 1,
                maximumQty: 36,
                incrementQty: 1,
                defaultQty: 1,
              },
            },
          ],
        },
      },
    ],
  },
  empty: {
    key: "00000000-0000-4000-8000-000000000001",
    cartState: "Active",
    totalItemQuantity: 0,
    totalUniqueProductSku: 0,
    fees: [],
    shoppingMode: { mode: "Delivery", deliveryAddress: null, pickupLocation: null },
    fulfilment: { fulfilmentProposition: null },
    validationResult: {
      isValid: true,
      failedValidations: [],
    },
    checkout: {
      amountToPayAsCents: 0,
      chargeableTotalAsCents: 0,
      loyaltySpendAsCents: 0,
    },
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
      total: {
        beforeDiscountAsCents: 0,
        afterDiscountAsCents: 0,
        discountAmountAsCents: 0,
      },
    },
    lineItems: [],
  },
};

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

async function rejects(
  description: string,
  run: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  try {
    const value = await run();
    check(description, false, `resolved with ${JSON.stringify(value).slice(0, 120)}`);
  } catch (error: unknown) {
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    check(description, error instanceof expected, named.slice(0, 140));
  }
}

/**
 * Replays canned envelopes through the real client, so the classification under test is the one
 * the server actually runs rather than a stand-in for it.
 */
class CannedTransport extends FetchGraphQlTransport {
  constructor(envelopes: readonly unknown[]) {
    let index = 0;
    super(() => {
      const envelope = envelopes[Math.min(index, envelopes.length - 1)];
      index += 1;
      return Promise.resolve(
        new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
  }
}

/** Sends one canned envelope through the client and returns its data, or throws as the client does. */
function classify(envelope: unknown): Promise<unknown> {
  return new CannedTransport([envelope]).send(CART_READ_OPERATION, CART_READ_DOCUMENT, {});
}

function cartWith(me: { id: string } | null, cart: unknown): unknown {
  return { data: { me, customerCart: cart } };
}

console.log("the envelope: HTTP 200 is not success");
await rejects(
  "an errors array is a failure, never data",
  () =>
    classify({
      data: { customerCart: { lineItems: [] } },
      errors: [{ message: "boom", extensions: { code: "SUBREQUEST_HTTP_ERROR" } }],
    }),
  GraphQlError,
);
await rejects(
  "a guest-banned field is the sign-in handover, not a generic error",
  () =>
    classify({
      data: { me: null, customerCart: CARTS.empty },
      errors: [
        {
          message: "Field 'me' is not allowed for guest users.",
          extensions: { code: "BANNED_OPERATION", service: "customer-graph-wnz" },
        },
      ],
    }),
  NotSignedInError,
);
check(
  "the handover names `npm run login`",
  new NotSignedInError().message.includes("npm run login"),
  new NotSignedInError().message.slice(0, 60),
);
await rejects(
  "an error with no extensions is still a failure, not a crash in the reporting",
  () => classify({ data: null, errors: [{ message: "no extensions here" }] }),
  GraphQlError,
);
await rejects(
  "a body that is not JSON is a failure",
  () => classify("<html>edge error</html>"),
  Error,
);

console.log("\nthe guest cart never reads as an empty cart");
await rejects(
  "a null `me` beside a plausible cart is refused",
  () => new GraphQlCart(new CannedTransport([cartWith(null, CARTS.empty)]), 60_000).read(),
  NotSignedInError,
);
const guestCart = { ...CARTS.empty, key: "11111111-1111-4111-8111-111111111111" };
await rejects(
  "a guest cart is refused even though it parses",
  () => new GraphQlCart(new CannedTransport([cartWith(null, guestCart)]), 60_000).read(),
  NotSignedInError,
);

console.log("\nthe captured cart maps to what the tools promise");
const read = await new GraphQlCart(
  new CannedTransport([cartWith({ id: CART_KEY }, CARTS.populated)]),
  60_000,
).read();
check(
  "the line names the sku",
  read.cart.lines[0]?.sku === "245902",
  read.cart.lines[0]?.sku ?? "(none)",
);
check(
  "the line names the variant a write targets",
  read.cart.lines[0]?.variantKey === "245902-KG",
  read.cart.lines[0]?.variantKey ?? "(none)",
);
check(
  "the line is named from its own variant, not guessed",
  read.cart.lines[0]?.name === "Woolworths Fresh Limes Min Order 100g",
  read.cart.lines[0]?.name ?? "(none)",
);
check(
  "the pricing unit comes from the variant",
  read.cart.lines[0]?.pricingUnit === "KG",
  read.cart.lines[0]?.pricingUnit ?? "(none)",
);
check(
  "cents become money",
  read.cart.lines[0]?.lineTotal === "$2.00",
  read.cart.lines[0]?.lineTotal ?? "(none)",
);
check(
  "the subtotal is the products, not the fees",
  read.cart.totals.subtotal === "$2.00",
  read.cart.totals.subtotal ?? "(none)",
);
check(
  "the total includes the fees",
  read.cart.totals.totalIncludingDeliveryFees === "$17.50",
  read.cart.totals.totalIncludingDeliveryFees ?? "(none)",
);
check(
  "delivery fee mapped",
  read.cart.totals.deliveryFees === "$14.00",
  read.cart.totals.deliveryFees ?? "(none)",
);
check("bag fee mapped", read.cart.totals.bagFees === "$1.50", read.cart.totals.bagFees ?? "(none)");
check(
  "a checkout blocker is surfaced with the site's own wording",
  read.cart.checkoutBlocked && read.cart.blockers[0]?.title === "Delivery has a $50 minimum spend",
  read.cart.blockers.map((blocker) => blocker.rule).join(", ") || "(none)",
);
check(
  "the site's item count is used, not a sum of the quantities",
  read.cart.totalQuantity === 1 && read.cart.lines[0]?.quantity === 0.2,
  `${read.cart.totalQuantity} items from a line of ${read.cart.lines[0]?.quantity ?? "?"}`,
);

console.log("\nreported as zero and not reported are different answers");
check(
  "a discount the site stated as zero is $0.00",
  read.cart.totals.savings === "$0.00",
  read.cart.totals.savings ?? "(absent)",
);
check(
  "a stated zero is not listed as unreported",
  !read.cart.totals.notReported.includes("savings"),
  read.cart.totals.notReported.join(", ") || "(none)",
);
const emptyCart = toCart(
  cartReadResponseSchema.parse({ me: { id: CART_KEY }, customerCart: CARTS.empty }).customerCart,
);
check(
  "a fee the site has not determined is absent, not $0.00",
  emptyCart.totals.deliveryFees === undefined && emptyCart.totals.bagFees === undefined,
  JSON.stringify({ delivery: emptyCart.totals.deliveryFees, bag: emptyCart.totals.bagFees }),
);
check(
  "the omission is named rather than left silent",
  emptyCart.totals.notReported.includes("deliveryFees") &&
    emptyCart.totals.notReported.includes("bagFees"),
  emptyCart.totals.notReported.join(", ") || "(none)",
);
check(
  "no $0.00 was invented for an undetermined fee",
  !JSON.stringify({
    delivery: emptyCart.totals.deliveryFees,
    bag: emptyCart.totals.bagFees,
  }).includes("$0.00"),
  JSON.stringify(emptyCart.totals),
);

console.log("\na line whose variant is missing is refused, never renamed");
const orphaned = structuredClone(CARTS.populated);
const orphanedLine = orphaned.lineItems[0];
if (orphanedLine !== undefined) orphanedLine.productVariantSku = "245902-XX";
try {
  toCart(
    cartReadResponseSchema.parse({ me: { id: CART_KEY }, customerCart: orphaned }).customerCart,
  );
  check("a line naming an unknown variant is refused", false, "mapped anyway");
} catch (error: unknown) {
  check(
    "a line naming an unknown variant is refused",
    error instanceof UnmappableCartLineError,
    error instanceof Error ? error.message.slice(0, 120) : String(error),
  );
}

console.log("\nthe write is guarded by the cart it landed in");
const writeInto = (key: string): unknown => ({
  data: {
    setCartLineItemQuantity: {
      key,
      totalItemQuantity: 1,
      totalUniqueProductSku: 1,
      validationResult: { isValid: true, failedValidations: [] },
      checkout: { amountToPayAsCents: 200, chargeableTotalAsCents: 200, loyaltySpendAsCents: 0 },
      pricing: CARTS.populated.pricing,
      lineItems: [
        {
          sku: "245902",
          productVariantSku: "245902-KG",
          quantity: 0.2,
          lineTotal: { afterDiscountAsCents: 200, discountAmountAsCents: 0 },
          unitPrice: { beforeDiscountAsCents: 998, afterDiscountAsCents: 998 },
        },
      ],
    },
  },
});
await rejects(
  "a write that landed in another cart is never reported as written",
  () =>
    new GraphQlCart(
      new CannedTransport([
        cartWith({ id: CART_KEY }, CARTS.populated),
        writeInto("22222222-2222-4222-8222-222222222222"),
      ]),
      60_000,
    ).setQuantity("245902", 0.2, "KG"),
  WrongCartError,
);
const written = await new GraphQlCart(
  new CannedTransport([cartWith({ id: CART_KEY }, CARTS.populated), writeInto(CART_KEY)]),
  60_000,
).setQuantity("245902", 0.2, "KG");
check(
  "a write into the signed-in cart reports what landed",
  written.appliedQuantity === 0.2 && written.variantKey === "245902-KG",
  JSON.stringify(written),
);
check(
  "a variant the cart does not hold is absent, and the caller reads it as zero",
  (
    await new GraphQlCart(
      new CannedTransport([cartWith({ id: CART_KEY }, CARTS.populated), writeInto(CART_KEY)]),
      60_000,
    ).setQuantity("958674", 0, "EACH")
  ).appliedQuantity === undefined,
  "absent",
);

console.log("\na product not sold at a store is not priced at zero");
const UNRANGED = {
  __typename: "GroceryVariant",
  key: "958674-EA",
  sku: "958674-EA",
  barcode: null,
  volumeSize: "3 Pack",
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
  availabilityStatus: "UNAVAILABLE",
  purchasingUnits: { unit: "EACH", minimumQty: 1, maximumQty: 36, incrementQty: 1, defaultQty: 1 },
  // Observed live: null at store 9171 while store 9583 priced the same product at $7.
  variantPrice: null,
  nutritionalInformation: null,
  assets: [],
};
const unranged = toProductDetail(
  detailProductSchema.parse({
    key: "958674",
    brand: "Woolworths",
    name: "Woolworths Fresh Chilli Green",
    slug: "woolworths-fresh-chilli-green",
    isLiquor: false,
    isTobacco: false,
    isOwnBrand: true,
    variants: [UNRANGED],
  }),
  [detailVariantSchema.parse(UNRANGED)],
  "9171",
);
check(
  "an unpriced product says it is not ranged, rather than costing nothing",
  !unranged.rangedAtStore && unranged.price === undefined,
  `ranged=${unranged.rangedAtStore} price=${String(unranged.price)}`,
);
check(
  "nothing about the price is invented",
  unranged.isSpecial === undefined && unranged.wasPrice === undefined,
  JSON.stringify({ isSpecial: unranged.isSpecial, wasPrice: unranged.wasPrice }),
);
check(
  "what the store did say is still reported",
  unranged.availability === "UNAVAILABLE" && unranged.storeKey === "9171",
  `${unranged.availability} at ${unranged.storeKey}`,
);

console.log("\ndelivery windows are described, never priced as one amount");
const WINDOW = {
  name: "Delivery 2 Sep 2026 10am - 2 Sep 2026 12:30pm",
  method: "delivery",
  type: "standard",
  kind: "delivery-truck",
  available: false,
  startTime: "2026-09-02T10:00:00+12:00",
  endTime: "2026-09-02T12:30:00+12:00",
  storeId: "9583",
  store: { storeId: "9064", name: "Northwest Woolworths" },
  // The site repeats the reason; captured verbatim.
  tags: [
    "perishability:AllAllowed",
    "liquor-allowed:true",
    "unavailableReason:cutoff-start-time-passed",
    "unavailableReason:cutoff-start-time-passed",
  ],
  fees: [
    {
      type: "standardDeliveryFee",
      currency: "NZD",
      amountInCents: null,
      rateCard: [
        { orderValueMinInCents: 0, orderValueMaxInCents: 19999, amountInCents: 1400 },
        { orderValueMinInCents: 20000, orderValueMaxInCents: null, amountInCents: 900 },
      ],
    },
  ],
};
const mapped = toDeliveryWindow(fulfilmentPropositionSchema.parse(WINDOW));
check(
  "a fee with no stated amount is absent, not free",
  mapped.fees[0]?.amount === undefined,
  String(mapped.fees[0]?.amount),
);
check(
  "the bands the site charges by are carried instead",
  mapped.fees[0]?.bands.length === 2 && mapped.fees[0].bands[0]?.amount === "$14.00",
  JSON.stringify(mapped.fees[0]?.bands),
);
check(
  "the open-ended top band has no upper bound rather than a zero",
  mapped.fees[0]?.bands[1]?.toOrderValue === undefined,
  String(mapped.fees[0]?.bands[1]?.toOrderValue),
);
check(
  "a repeated unavailable reason is stated once",
  mapped.unavailableReasons.length === 1 &&
    mapped.unavailableReasons[0] === "cutoff-start-time-passed",
  mapped.unavailableReasons.join(", "),
);
check(
  "capability tags are kept apart from the reason it is closed",
  mapped.allows.length === 2 && !mapped.allows.some((tag) => tag.startsWith("unavailableReason")),
  mapped.allows.join(", "),
);
const listed = toDeliveryWindows([fulfilmentPropositionSchema.parse(WINDOW)], true, undefined, 40);
check(
  "an unavailable window is excluded but still counted, and booking is refused in words",
  listed.windows.length === 0 &&
    listed.coverage.includes("1 windows") &&
    listed.coverage.includes("cannot book"),
  listed.coverage.slice(0, 80),
);
// The fixture is a delivery window, so asking for pick-up must return none and say why.
const wrongMethod = toDeliveryWindows(
  [fulfilmentPropositionSchema.parse(WINDOW)],
  false,
  "pickup",
  40,
);
check(
  "a window of the other method is excluded and the filter is named",
  wrongMethod.windows.length === 0 && wrongMethod.coverage.includes("'pickup'"),
  wrongMethod.coverage.slice(0, 120),
);

console.log("\nbatched search");
{
  const queries = ["paneer", "limes", "oat milk"];
  const document = multiSearchDocument(queries.length);
  const operation = document.definitions[0];
  const selections =
    operation?.kind === Kind.OPERATION_DEFINITION ? operation.selectionSet.selections : [];
  const my = selections[0];
  const fields = my?.kind === Kind.FIELD ? (my.selectionSet?.selections ?? []) : [];
  const aliases = fields
    .map((field) => (field.kind === Kind.FIELD ? field.alias?.value : undefined))
    .filter((alias): alias is string => alias !== undefined);
  check(
    "one operation carries every query, each under its own alias",
    selections.length === 1 && aliases.length === queries.length,
    `${selections.length} root selection(s), aliases: ${aliases.join(", ")}`,
  );
  const variables = multiSearchVariables(queries, 1, 5, "RELEVANCE");
  check(
    "every alias in the document has a variable, and every variable an alias",
    aliases.every((alias) => alias in variables) &&
      Object.keys(variables).length === aliases.length,
    Object.keys(variables).join(", "),
  );
  check(
    "each alias carries its own search term, in the order asked",
    queries.every((query, index) => {
      const input = variables[multiSearchAlias(index)];
      return input !== undefined && "byKeyword" in input && input.byKeyword.value === query;
    }),
    queries.join(", "),
  );
}

console.log("\nvariant keys");
check(
  "Each encodes as -EA",
  variantKeyFor("245902", "EACH") === "245902-EA",
  variantKeyFor("245902", "EACH"),
);
check(
  "Kg encodes as -KG",
  variantKeyFor("245902", "KG") === "245902-KG",
  variantKeyFor("245902", "KG"),
);
check(
  "both pricings of a sku are addressable, so one can clear the other",
  variantKeysFor("245902").join(",") === "245902-EA,245902-KG",
  variantKeysFor("245902").join(","),
);
check(
  "a key decodes back to its pricing unit",
  pricingUnitFromVariantKey("245902-KG") === "KG",
  "KG",
);
check(
  "an unrecognised suffix decodes to nothing rather than a default",
  pricingUnitFromVariantKey("245902-XX") === undefined,
  String(pricingUnitFromVariantKey("245902-XX")),
);

if (failures.length === 0) {
  console.log("\nGraphQL cart checks passed.");
} else {
  console.log(`\nGraphQL cart checks FAILED: ${failures.join(", ")}`);
  process.exitCode = 1;
}
