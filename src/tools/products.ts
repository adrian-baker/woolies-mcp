import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SORT_OPTIONS, type WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";
import { skuArgument } from "./arguments.js";

const LOCATION_CAVEAT =
  "Prices and availability are per delivery location; call get_location to see the current one " +
  "and set_location to change it.";

export function registerProductTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "search_products",
    {
      title: "Search Woolworths products",
      description:
        "Search the Woolworths New Zealand catalogue by keyword. Returns `products` for this " +
        "page, `matchesAvailable` for the whole query, and a `coverage` sentence saying whether " +
        "this is everything — read it before answering cheapest/only/none questions. Extra query " +
        "words are ANDed, including sizes, and the site's ranking pads pages with loosely " +
        "related products, so check each name. `unitPrice` is a formatted string whose measure " +
        `varies per product and is absent for many, so compare it only within a category. ${LOCATION_CAVEAT}`,
      inputSchema: {
        query: z.string().min(1).describe("Search keywords, e.g. 'rose wine' or 'oat milk'."),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page of results; 40 products per page."),
        sort: z
          .enum(SORT_OPTIONS)
          .default("Relevance")
          .describe(
            "Result order. CUPAsc uses the site's raw cup price, whose measure varies per " +
              "product ($/L, $/100g, $/1ea), so it ranks meaningfully only within one category " +
              "and is absent for many products.",
          ),
        includeOutOfStock: z
          .boolean()
          .default(false)
          .describe(
            "Include products that cannot be bought at the current location. Off by default: " +
              "an unbuyable product is not a useful answer.",
          ),
        department: z
          .string()
          .optional()
          .describe(
            "Department slug to keep only products from, e.g. 'fruit-veg'. Applied to the fetched " +
              "page after the search runs, because the site's search does not accept a category " +
              "filter; the coverage sentence says how much was actually examined.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, page, sort, includeOutOfStock, department }) =>
      guarded("search_products", async () =>
        jsonResult(
          await api.searchProducts({
            query,
            page,
            sort,
            inStockOnly: !includeOutOfStock,
            ...(department === undefined ? {} : { department }),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_product_label",
    {
      title: "Get a product's label photo",
      description:
        "Return the product's packaging photo as an image, for reading details the API does not " +
        "publish — most importantly ingredients and allergens, which are frequently absent from " +
        "get_product. Call this when get_product reports allergens or ingredients as 'notStated' " +
        "and the answer matters. Images are token-expensive, so request them one product at a " +
        "time and only when needed. A photo may still not show the panel, and reading a label " +
        "from a photo is not a substitute for the physical packaging for allergy decisions.",
      inputSchema: {
        sku: skuArgument("Woolworths product SKU."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sku }) =>
      guarded("get_product_label", async () => {
        const image = await api.getProductImage(sku);
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(image.bytes).toString("base64"),
              mimeType: image.mimeType,
            },
          ],
        };
      }),
  );

  server.registerTool(
    "search_products_batch",
    {
      title: "Search several things at once",
      description:
        "Run several catalogue searches in one call and get the results grouped by query, so " +
        "finding many products costs one round trip. Every group carries its own `coverage` " +
        "sentence and the same caveats as search_products: the ranking pads results, extra query " +
        "words are ANDed, and a truncated group cannot answer cheapest/only/none questions. " +
        `${LOCATION_CAVEAT}`,
      inputSchema: {
        queries: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe("The searches to run, e.g. ['paneer', 'limes', 'oat milk']."),
        resultsPerQuery: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("How many top candidates to return per query."),
        includeOutOfStock: z.boolean().default(false).describe("Include unbuyable products."),
        department: z.string().optional().describe("Restrict every query to this department slug."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ queries, resultsPerQuery, includeOutOfStock, department }) =>
      guarded("search_products_batch", async () =>
        jsonResult({
          results: await api.searchMany(queries, {
            page: 1,
            sort: "Relevance",
            inStockOnly: !includeOutOfStock,
            size: resultsPerQuery,
            ...(department === undefined ? {} : { department }),
          }),
        }),
      ),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get a Woolworths product",
      description:
        "Fetch one product by SKU, with its price, size, unit price (a formatted string whose " +
        "measure varies per product, and absent for many), availability, category " +
        "breadcrumb, description, ingredients, allergens, claims, nutrition, origins and health " +
        "star rating. `purchasingUnit` ('Each' or 'Kg') is what the cart tools need for " +
        "pricingUnit, and `canBuyByWeight` says whether 'Kg' with a decimal quantity is allowed. " +
        "IMPORTANT: allergens and ingredients are often not published. When either reports " +
        "status 'notStated' that means Woolworths said nothing, NOT that the product is free of " +
        "allergens — products whose own ingredients are milk come back with allergens empty. " +
        "Never present 'notStated' as an allergy assurance; use get_product_label to read the " +
        `packaging, and say the data is unavailable. ${LOCATION_CAVEAT}`,
      inputSchema: {
        sku: skuArgument("Woolworths product SKU, e.g. '462559'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sku }) =>
      guarded("get_product", async () => jsonResult(await api.getProduct(sku))),
  );
}
