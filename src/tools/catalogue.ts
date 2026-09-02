import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SORT_OPTIONS, SPECIAL_FILTERS, type WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";

const LOCATION_CAVEAT =
  "Prices and availability are per delivery location; call get_location to see the current one, " +
  "and set_location to move the cart to another of the account's saved addresses.";

const listingArguments = {
  page: z.number().int().min(1).default(1).describe("1-based page of results; 40 per page."),
  sort: z
    .enum(SORT_OPTIONS)
    .default("RELEVANCE")
    .describe(
      "Result order. FAVOURITES was observed to change the order only on get_specials; on search and browse it returns the same order as RELEVANCE.",
    ),
};

export function registerCatalogueTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "list_categories",
    {
      title: "List Woolworths categories",
      description:
        "The browse tree. Returns one node with its `children`: the root with no argument, or " +
        "the node a `categoryKey` names. Each node carries the `key` browse_category takes and " +
        "the `slug` the website shows. The tree is four levels deep and 773 nodes in total, far " +
        "more than one result can carry, so `depth` bounds it — walk down a level at a time by " +
        "passing a child's `key` back in. A node whose children were not listed reports " +
        "`childrenNotListed`; a node with neither children nor that count is a leaf.",
      inputSchema: {
        categoryKey: z
          .string()
          .optional()
          .describe("A category key from an earlier call. Omit for the top of the tree."),
        depth: z
          .number()
          .int()
          .min(0)
          .max(4)
          .default(1)
          .describe(
            "How many levels below the named node to list. 0 is the node alone; 1 its children. " +
              "4 returns the whole tree and is large enough to overflow a result.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ categoryKey, depth }) =>
      guarded("list_categories", async () =>
        jsonResult(await api.listCategories(categoryKey, depth)),
      ),
  );

  server.registerTool(
    "browse_category",
    {
      title: "Browse a Woolworths category",
      description:
        "List the products in a category, by the `key` list_categories returns. Returns one " +
        `page: read \`coverage\` before claiming a category holds nothing else. ${LOCATION_CAVEAT}`,
      inputSchema: {
        categoryKey: z.string().min(1).describe("A category key from list_categories."),
        ...listingArguments,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ categoryKey, page, sort }) =>
      guarded("browse_category", async () =>
        jsonResult(await api.browseCategory({ categoryKey, page, sort })),
      ),
  );

  server.registerTool(
    "get_specials",
    {
      title: "Get Woolworths specials",
      description:
        "List products currently on special. Each carries `wasPrice` and `savedAmount` alongside " +
        "the current price. `filters` narrows to a promotion type; omitted, every special is " +
        `included. Returns one page: read \`coverage\` before claiming anything is the best or ` +
        `only special available. ${LOCATION_CAVEAT}`,
      inputSchema: {
        filters: z
          .array(z.enum(SPECIAL_FILTERS))
          .optional()
          .describe("Promotion types to include. Omit for every special."),
        ...listingArguments,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filters, page, sort }) =>
      guarded("get_specials", async () =>
        jsonResult(
          await api.getSpecials({ ...(filters === undefined ? {} : { filters }), page, sort }),
        ),
      ),
  );
}
