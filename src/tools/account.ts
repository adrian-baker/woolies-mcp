import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ORDER_FILTERS, PRICING_UNITS, type WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";
import { skuArgument } from "./arguments.js";

/**
 * Account tools. They need a signed-in session, which the server keeps signed in from its
 * credentials file or which a person hands over with `npm run login`. No credential is ever a
 * tool argument.
 *
 * There is deliberately no tool for checkout, payment, delivery slots or placing an order. Those
 * upstream endpoints exist and are intentionally left unbound: this server can fill a cart,
 * and a person finishes the shop.
 */

const CART_SEMANTICS =
  "Quantity is absolute, not a delta: the value you pass becomes the line's new quantity, and 0 " +
  "removes the line. For pricingUnit, use the product's `purchasingUnit` field from " +
  "search_products or get_product verbatim — it is 'EACH' or 'KG'. Only pass 'KG' with a decimal " +
  "quantity when the product's `canBuyByWeight` is true; sending 'KG' for a counted item orders " +
  "a kilogram of it.";

const NEEDS_ACCOUNT =
  "Needs a signed-in session. The server signs itself in again when the session dies, if it has " +
  "credentials; when it cannot, the error says why — call auth_status for the details.";

const CART_LOCATION =
  "The cart lives on the site's GraphQL API, which serves an unauthenticated caller an empty " +
  "guest cart rather than an error. Every cart call here proves the session first, so an empty " +
  "cart returned by these tools is genuinely empty and never a silently expired session.";

export function registerAccountTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "sign_in",
    {
      title: "Sign in to Woolworths",
      description:
        "Make sure the session is signed in. If it is not and the server has a credentials file, " +
        "this is the moment the server signs itself in; the result says whether that worked and, " +
        "if not, why automatic sign-in has stopped. A stop is not retried from here: it clears " +
        "when the credentials file is rewritten, a browser session is handed over with " +
        "`npm run login`, or the server restarts. Takes no credentials and never sees any.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () =>
      guarded("sign_in", async () => {
        const access = await api.checkAccountAccess();
        return jsonResult({
          accountToolsUsable: access.usable,
          autoSignIn: await api.autoSignInStatus(),
        });
      }),
  );

  server.registerTool(
    "auth_status",
    {
      title: "Woolworths sign-in status",
      description:
        "Report whether the account tools will work, by making a real account call rather than " +
        "inferring it. `accountToolsUsable` is demonstrated, not guessed: if it is true the cart, " +
        "location, history and order tools work right now. A dead session is signed in again on " +
        "this call when the server has credentials. `autoSignIn.state` is `ready`, `stopped` " +
        "(with the reason — a person has to act), or `notConfigured` (no credentials file; sign " +
        "in with `npm run login` from a machine with a browser).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded("auth_status", async () => {
        // Costs one account call. A status tool that guesses is worse than a status tool that
        // asks, and this is the tool people check before trusting the others.
        const access = await api.checkAccountAccess();
        return jsonResult({
          accountToolsUsable: access.usable,
          autoSignIn: await api.autoSignInStatus(),
        });
      }),
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get the Woolworths cart",
      description:
        "List the cart. Returns `lines` (one per distinct product variant, each with the " +
        "`variantKey` that identifies it, its `pricingUnit`, unit price and line total), " +
        "`lineCount` (distinct variants), `totalQuantity` (the site's own item count, which " +
        "counts a weighed line once however many kilograms it holds — never a sum of the " +
        "quantities), `totals` (subtotal, savings, deliveryFees, bagFees, " +
        "totalIncludingDeliveryFees, plus `notReported` naming any the site did not state — a " +
        "fee is absent, never $0.00, until a delivery window is chosen), `fees`, `state`, and " +
        "`checkoutBlocked` with `blockers` when the cart cannot be checked out as it stands " +
        `(for example a $50 delivery minimum). ${CART_LOCATION} ${NEEDS_ACCOUNT}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guarded("get_cart", async () => jsonResult(await api.getCart())),
  );

  server.registerTool(
    "set_cart_quantity",
    {
      title: "Set a cart line's quantity",
      description:
        `Set one product's cart line to an exact quantity, adding it if absent. ${CART_SEMANTICS} ` +
        "Returns requestedQuantity and appliedQuantity separately, because Woolworths silently " +
        "substitutes its own quantity for some products (0.3 Kg of loose bananas becomes 0.5 Kg). " +
        "When `adjusted` is true, `adjustment` says what the site did instead — report the " +
        "applied amount to the shopper, never the requested one. Also returns `variantKey` (the " +
        "line the write targeted), `cartTotalQuantity` and `cartLineCount` for the whole cart, " +
        "and `checkoutBlocked` with `blockers` when the cart cannot be checked out as it stands. " +
        "Setting a quantity in one pricing unit clears the same product's other pricing, so a " +
        "product is never left with both an EACH line and a KG line. " +
        `To change several products, use set_cart_quantities instead. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        sku: skuArgument("Woolworths product SKU, from search_products."),
        quantity: z
          .number()
          .min(0)
          .max(99)
          .describe("The line's new absolute quantity. 0 removes it. Decimals only for Kg."),
        pricingUnit: z
          .enum(PRICING_UNITS)
          .default("EACH")
          .describe("'EACH' for counted items, 'KG' for items priced by weight."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ sku, quantity, pricingUnit }) =>
      guarded("set_cart_quantity", async () =>
        jsonResult(await api.setCartQuantity(sku, quantity, pricingUnit)),
      ),
  );

  server.registerTool(
    "remove_from_cart",
    {
      title: "Remove a product from the cart",
      description:
        "Remove a product from the cart entirely, the same as setting its quantity to 0. No " +
        "pricing unit is needed: every line for the sku is removed, whichever pricing it was " +
        `held under. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        sku: skuArgument("SKU of the line to remove."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ sku }) =>
      guarded("remove_from_cart", async () => jsonResult(await api.removeFromCart(sku))),
  );

  server.registerTool(
    "set_cart_quantities",
    {
      title: "Set several cart lines at once",
      description:
        `Set many products' cart lines in one call. ${CART_SEMANTICS} The whole list is sent to ` +
        "the site as one write. If the site refuses it — it refuses a batch as a whole, and its " +
        "reason names no sku — each item is then looked up and the ones that could not have " +
        "been written are reported with why: no such sku, not sold at this store, or the wrong " +
        "pricing unit. The rest are written, so one bad line costs that line and not the whole " +
        "list. Results come back in the order asked, one entry per item, so check every entry. " +
        "Written " +
        "entries carry requestedQuantity and appliedQuantity: where `adjusted` is true the site " +
        "substituted its own quantity and `adjustment` says how, so summarise what was actually " +
        `added. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        items: z
          .array(
            z.object({
              sku: skuArgument("Woolworths product SKU."),
              quantity: z.number().min(0).max(99).describe("Absolute new quantity; 0 removes."),
              pricingUnit: z
                .enum(PRICING_UNITS)
                .default("EACH")
                .describe("The product's purchasingUnit value."),
            }),
          )
          .min(1)
          .max(50)
          .describe("The lines to set."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ items }) =>
      guarded("set_cart_quantities", async () => {
        const outcomes = await api.setCartQuantities(items);
        const failed = outcomes.filter((outcome) => outcome.kind === "failed").length;
        const adjusted = outcomes.filter(
          (outcome) => outcome.kind === "written" && outcome.result.adjusted,
        ).length;
        return jsonResult({
          requested: items.length,
          written: outcomes.length - failed,
          failed,
          adjusted,
          ...(adjusted === 0
            ? {}
            : {
                adjustmentWarning:
                  `Woolworths applied a different quantity than requested for ${adjusted} of ` +
                  `these lines. Read each outcome's adjustment and report what was actually added.`,
              }),
          outcomes,
        });
      }),
  );

  server.registerTool(
    "get_buy_it_again",
    {
      title: 'Get "Buy it again" products',
      description:
        'List the site\'s "Buy it again" products for this shopper, most frequently bought ' +
        "first. These are things they have genuinely bought, but the list is the retailer's own " +
        'selection and is NOT the complete purchase history — never answer "they have never ' +
        'bought X" from it, even after paging to the end. The grid also carries retailer ' +
        "advertising, which is excluded here rather than mixed in; `advertisingExcluded` says " +
        "how many tiles were dropped. Each product carries `variantKey`, which is what a cart " +
        `write targets. Read \`coverage\` before drawing any conclusion. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page of the history, most frequently bought first."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ page }) =>
      guarded("get_buy_it_again", async () => jsonResult(await api.getBuyItAgain(page))),
  );

  server.registerTool(
    "get_purchase_history",
    {
      title: "Get what past orders contained",
      description:
        "List the account's past orders with the products in each one: sku, name and quantity. " +
        "This is the shopper's actual purchase record, and it is NOT the same thing as " +
        "get_buy_it_again — that returns a list the retailer curates and orders by frequency, " +
        "which is a recommendation, while this is what was bought. Lines the site returned with " +
        "a quantity of zero are kept in `zeroQuantityLines` rather than counted or dropped: what " +
        "a zero means there is not documented. There is no page argument, because the site " +
        "ignores the page index. Read `coverage`: the site returns a recent window and never " +
        `says how far back it reaches. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        filter: z
          .enum(ORDER_FILTERS)
          .default("PAST")
          .describe("'PAST' for completed orders, 'ACTIVE' for those still in flight."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter }) =>
      guarded("get_purchase_history", async () => jsonResult(await api.getPurchaseHistory(filter))),
  );

  server.registerTool(
    "get_order_history",
    {
      title: "Get Woolworths orders",
      description:
        "List the account's orders with their references, dates, statuses, fulfilment slots and " +
        "totals. `filter` selects which set: 'PAST' for completed orders (the default), 'ACTIVE' " +
        "for orders still in flight. There is no page argument: the site ignores the page index " +
        "and returns the same set whatever is asked for, so this is everything it offers in one " +
        "call. Read `coverage` — the site returns a recent window and never says how far back it " +
        `reaches, so an order's absence is not evidence it was never placed. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        filter: z
          .enum(ORDER_FILTERS)
          .default("PAST")
          .describe("'PAST' for completed orders, 'ACTIVE' for those still in flight."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter }) =>
      guarded("get_order_history", async () => jsonResult(await api.getOrderHistory(filter))),
  );
}
