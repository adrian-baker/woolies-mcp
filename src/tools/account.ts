import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PRICING_UNITS, type WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";
import { skuArgument } from "./arguments.js";

/**
 * Account tools. They need a session signed in out of band by `npm run login`; no credential ever
 * passes through this process.
 *
 * There is deliberately no tool for checkout, payment, delivery slots or placing an order. Those
 * upstream endpoints exist and are intentionally left unbound: this server can fill a trolley,
 * and a person finishes the shop.
 */

const CART_SEMANTICS =
  "Quantity is absolute, not a delta: the value you pass becomes the line's new quantity, and 0 " +
  "removes the line. For pricingUnit, use the product's `purchasingUnit` field from " +
  "search_products or get_product verbatim — it is 'Each' or 'Kg'. Only pass 'Kg' with a decimal " +
  "quantity when the product's `canBuyByWeight` is true; sending 'Kg' for a counted item orders " +
  "a kilogram of it.";

const NEEDS_ACCOUNT =
  "Needs a signed-in session; run `npm run login` where the server runs, or call sign_in for " +
  "the details.";

/** States the cookie date as a ceiling, never as a date to plan around. */
function describeCookieExpiry(expiry: Date | undefined): string {
  if (expiry === undefined)
    return "The session carries no dated cookie, so it can end at any time.";
  return (
    `The session cookie is dated ${expiry.toISOString()}, which is the longest it can last, ` +
    "not a guarantee it will."
  );
}

export function registerAccountTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "sign_in",
    {
      title: "Sign in to Woolworths",
      description:
        "Report whether the session is signed in, and if not, how to sign it in. Sign-in is not " +
        "performed here and cannot be: it happens in a real browser via `npm run login` on the " +
        "machine running the server, because Auth0 challenges non-browser sign-ins. This tool " +
        "never sends credentials and never touches the account.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () =>
      guarded("sign_in", async () => {
        const outcome = await api.signIn();
        // Same demonstrated check as auth_status, so the two can never contradict each other.
        const access = await api.checkAccountAccess();
        return jsonResult({
          outcome,
          accountToolsUsable: access.usable,
          shellReportsSignedIn: access.shellReportsSignedIn,
          firstName: access.usable ? access.firstName : undefined,
        });
      }),
  );

  server.registerTool(
    "auth_status",
    {
      title: "Woolworths sign-in status",
      description:
        "Report whether the account tools will work, by making a real account call rather than " +
        "inferring it. `accountToolsUsable` is demonstrated, not guessed: if it is true the cart " +
        "and purchase-history tools work right now. `shellReportsSignedIn` is what the site's " +
        "own session check claims, reported separately because a session can satisfy that while " +
        "account access is already gone; when the two disagree, `note` says so and the demonstrated " +
        "answer is the one to believe. `cookieExpiresAt`, when present, is only the date stamped " +
        "on the session cookie: an upper bound, not a promise. The catalogue tools work signed " +
        "out and are unaffected.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded("auth_status", async () => {
        // Costs one account call. A status tool that guesses is worse than a status tool that
        // asks, and this is the tool people check before trusting the others.
        const access = await api.checkAccountAccess();
        // Only reported when access is demonstrated: a forward date beside an unusable session
        // describes a session that is already gone.
        const cookieExpiry = access.usable ? await api.cookieExpiry() : undefined;
        return jsonResult({
          accountToolsUsable: access.usable,
          shellReportsSignedIn: access.shellReportsSignedIn,
          firstName: access.usable ? access.firstName : undefined,
          cookieExpiresAt: cookieExpiry?.toISOString(),
          note:
            access.usable === access.shellReportsSignedIn
              ? undefined
              : "The site's session check and real account access disagree: the session is " +
                "partly dead. Believe accountToolsUsable and run `npm run login` again.",
          hint: access.usable
            ? `Account tools work right now. ${describeCookieExpiry(cookieExpiry)}`
            : "Account tools will fail. Run `npm run login` where the server runs.",
        });
      }),
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get the Woolworths trolley",
      description:
        "List the trolley. Returns `lines` (one per distinct product), `lineCount` (how many " +
        "distinct products), `totalQuantity` (the quantities summed, so 19 lines can be 23 " +
        "items), and `totals` with the money as the site formats it: subtotal, savings, " +
        `deliveryFees, bagFees and totalIncludingDeliveryFees. ${NEEDS_ACCOUNT}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guarded("get_cart", async () => jsonResult(await api.getCart())),
  );

  server.registerTool(
    "set_cart_quantity",
    {
      title: "Set a trolley line's quantity",
      description:
        `Set one product's trolley line to an exact quantity, adding it if absent. ${CART_SEMANTICS} ` +
        "Returns requestedQuantity and appliedQuantity separately, because Woolworths silently " +
        "substitutes its own quantity for some products (0.3 Kg of loose bananas becomes 0.5 Kg). " +
        "When `adjusted` is true, `adjustment` says what the site did instead — report the " +
        "applied amount to the shopper, never the requested one. Also returns " +
        "trolleyTotalQuantity (quantities summed across the whole trolley, not a line count). " +
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
          .default("Each")
          .describe("'Each' for counted items, 'Kg' for items priced by weight."),
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
      title: "Remove a product from the trolley",
      description:
        "Remove a line from the trolley entirely, the same as setting its quantity to 0. No " +
        `pricing unit is needed: a removal has none. ${NEEDS_ACCOUNT}`,
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
      title: "Set several trolley lines at once",
      description:
        `Set many products' trolley lines in one call. ${CART_SEMANTICS} Each item is reported ` +
        "separately as written or failed with a reason; one failure never removes an item from " +
        "the results, so check every entry. Written entries carry requestedQuantity and " +
        "appliedQuantity: where `adjusted` is true the site substituted its own quantity and " +
        `\`adjustment\` says how, so summarise what was actually added. ${NEEDS_ACCOUNT}`,
      inputSchema: {
        items: z
          .array(
            z.object({
              sku: skuArgument("Woolworths product SKU."),
              quantity: z.number().min(0).max(99).describe("Absolute new quantity; 0 removes."),
              pricingUnit: z
                .enum(PRICING_UNITS)
                .default("Each")
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
    "get_past_purchases",
    {
      title: "Get previously bought products",
      description:
        "Return the site's previously-purchased sections, kept separate and labelled. ONLY the " +
        "section with isPurchaseHistory true reflects what this shopper actually bought; the " +
        "other section is retailer advertising and must never be described as their purchases, " +
        "habits or preferences. Read each section's `coverage` before concluding anything about " +
        `what the shopper does or does not buy. ${NEEDS_ACCOUNT}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded("get_past_purchases", async () => {
        const sections = await api.getPastPurchases();
        return jsonResult({
          purchaseHistory: sections.filter((section) => section.isPurchaseHistory),
          promotional: sections.filter((section) => !section.isPurchaseHistory),
        });
      }),
  );

  server.registerTool(
    "get_order_history",
    {
      title: "Get past Woolworths orders",
      description:
        "List the account's past orders with their references, dates, fulfilment slots, statuses " +
        "and totals. Read `coverage`: the site returns only its default recent window, so an " +
        `order's absence is not evidence it was never placed. ${NEEDS_ACCOUNT}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guarded("get_order_history", async () => jsonResult(await api.getOrderHistory())),
  );
}
