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
