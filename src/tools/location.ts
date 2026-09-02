import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";

export function registerLocationTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "get_location",
    {
      title: "Get the current Woolworths delivery location",
      description:
        "Report where this session is shopping from: mode, delivery suburb and address or " +
        "pick-up location. `catalogueStoreKey` is the store the catalogue prices against and is " +
        "the field that decides every price and in-stock answer; `store` and `storeId` name the " +
        "store fulfilling the order and are stated only once a delivery window is chosen, which " +
        "this server never does. Every price and availability answer from the other tools is " +
        "for this location, so check it before trusting a result. Read from the cart, so it " +
        "needs a signed-in session; anything the cart did not state is listed in `notReported` " +
        "rather than guessed. `savedAddresses` lists the account's own addresses with the ids " +
        "set_location takes — note that an account can hold the same street address more than " +
        "once under different ids.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded("get_location", async () =>
        jsonResult({
          ...(await api.getFulfilment()),
          savedAddresses: await api.listAddresses(),
        }),
      ),
  );

  server.registerTool(
    "set_location",
    {
      title: "Move the cart to a saved delivery address",
      description:
        "Move the cart to one of the account's own saved delivery addresses, which changes the " +
        "serving store and therefore the prices and stock every other tool returns. Call " +
        "get_location first for the ids: only an address the account already holds can be used, " +
        "and an unknown id is refused with the list rather than moving anything. This books " +
        "nothing — the site clears any chosen delivery window, and the result says so.",
      inputSchema: {
        addressId: z.string().min(1).describe("An address id from get_location's savedAddresses."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ addressId }) =>
      guarded("set_location", async () => jsonResult(await api.setLocation(addressId))),
  );

  server.registerTool(
    "get_delivery_windows",
    {
      title: "List Woolworths delivery and pick-up windows",
      description:
        "List the delivery and pick-up windows offered for this cart's delivery address, or for " +
        "a pick-up location. The site answers with both methods at once — a delivery address " +
        "comes back with hundreds of pick-up slots at a nearby store alongside its own delivery " +
        "windows — so pass `method` to get one or the other; without it both are returned and " +
        "most of them will be pick-up. Read-only: this server cannot book a window and has no " +
        "tool that does — report the options and let the shopper choose on the website. " +
        "`coverage` says what each filter removed and whether the list was truncated. Each window gives " +
        "its times, method, whether it is `available` and, when it is not, the site's own " +
        "`unavailableReasons`. Delivery fees are charged by order value, so `fees[].bands` lists " +
        "the thresholds and there is deliberately no single amount. `allows` carries the site's " +
        "capability tags, e.g. whether liquor may be sent. Needs a signed-in session.",
      inputSchema: {
        locationId: z
          .string()
          .optional()
          .describe(
            "A pick-up location id from find_stores. Omit for delivery to the cart's address.",
          ),
        availableOnly: z
          .boolean()
          .default(true)
          .describe("Whether to list only bookable windows. False includes closed ones and why."),
        method: z
          .enum(["delivery", "pickup"])
          .optional()
          .describe(
            "Keep only windows of this method. Omit for both, which is mostly pick-up slots.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(40)
          .describe("How many matching windows to list. `coverage` says if more matched."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ locationId, availableOnly, method, limit }) =>
      guarded("get_delivery_windows", async () =>
        jsonResult(
          await api.getDeliveryWindows({
            ...(locationId === undefined ? {} : { locationId }),
            availableOnly,
            ...(method === undefined ? {} : { method }),
            limit,
          }),
        ),
      ),
  );
}
