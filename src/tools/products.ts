import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SORT_OPTIONS, type WoolworthsApi } from "../woolworths/api.js";
import { errorResult, guarded, jsonResult } from "./respond.js";
import { skuArgument } from "./arguments.js";

const LOCATION_CAVEAT =
  "Prices and availability are per delivery location; call get_location to see the current one, " +
  "and set_location to move the cart to another of the account's saved addresses.";

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
          .default("RELEVANCE")
          .describe(
            "Result order. FAVOURITES was observed to change the order only on get_specials; on search and browse it returns the same order as RELEVANCE.",
          ),
        department: z
          .string()
          .optional()
          .describe(
            "Department slug to keep only products from, e.g. 'fruit-veg'. Applied to this page " +
              "after the search runs, because the site's search accepts no category filter, so " +
              "it narrows one page rather than the query. `departmentFilter` reports how many " +
              "were examined, how many matched, and which department slugs the page held.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, page, sort, department }) =>
      guarded("search_products", async () =>
        jsonResult(
          await api.searchProducts({
            query,
            page,
            sort,
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
        "Fetch the product's packaging photograph and return it as an image, for reading details " +
        "the API does not publish — most importantly ingredients and allergens, which are " +
        "frequently absent from get_product. Call this when get_product reports allergens or " +
        "ingredients as 'notStated' and the answer matters. Images are token-expensive, so " +
        "request them one product at a time and only when needed. `image` selects which of the " +
        "product's photographs to fetch, 0-based; get_product's `images` lists them all, and the " +
        "packaging panel is rarely the first. A photo may still not show the panel, and reading " +
        "a label from a photo is not a substitute for the physical packaging for allergy " +
        "decisions.",
      inputSchema: {
        sku: skuArgument("Woolworths product SKU."),
        image: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Which of the product's photographs to fetch, 0-based."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sku, image }) =>
      guarded("get_product_label", async () => {
        const detail = await api.getProduct(sku);
        const asset = detail.images[image];
        if (asset === undefined) {
          return errorResult(
            detail.images.length === 0
              ? `Woolworths publishes no image for ${detail.name} (${detail.sku}).`
              : `${detail.name} (${detail.sku}) has ${detail.images.length} image(s), numbered 0 ` +
                  `to ${detail.images.length - 1}; ${image} is not one of them.`,
          );
        }
        const fetched = await api.fetchImage(asset.url);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sku: detail.sku,
                  name: detail.name,
                  image,
                  imagesAvailable: detail.images.length,
                  url: asset.url,
                  altText: asset.altText,
                  note:
                    "This is one of the product's own photographs. Whether it shows the " +
                    "ingredients or allergen panel is not stated; if it does not, try another " +
                    "index. Reading a label from a photo is not a substitute for the physical " +
                    "packaging for an allergy decision.",
                },
                null,
                2,
              ),
            },
            { type: "image", data: fetched.base64, mimeType: fetched.mimeType },
          ],
        };
      }),
  );

  server.registerTool(
    "search_products_batch",
    {
      title: "Search several things at once",
      description:
        "Run several catalogue searches in one call and get the results grouped by query. It is " +
        "genuinely one request — the queries are sent together and answered together — so 20 " +
        "searches take about as long as one. Groups come back in the order asked. Every group " +
        "carries its own `coverage` " +
        "sentence and the same caveats as search_products: the ranking pads results, extra query " +
        "words are ANDed, and a truncated group cannot answer cheapest/only/none questions. " +
        LOCATION_CAVEAT,
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
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ queries, resultsPerQuery }) =>
      guarded("search_products_batch", async () =>
        jsonResult({
          results: await api.searchMany(queries, {
            page: 1,
            sort: "RELEVANCE",
            size: resultsPerQuery,
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
        "star rating. `purchasingUnit` ('EACH' or 'KG') is what the cart tools need for " +
        "pricingUnit, and `canBuyByWeight` says whether 'KG' with a decimal quantity is allowed. " +
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
    async ({ sku }) => guarded("get_product", async () => jsonResult(await api.getProduct(sku))),
  );
}
