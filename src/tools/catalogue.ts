import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SORT_OPTIONS, type WoolworthsApi } from "../woolworths/api.js";
import { toDepartmentSummary } from "../woolworths/mappers.js";
import { errorResult, guarded, jsonResult } from "./respond.js";

const LOCATION_CAVEAT =
  "Prices and availability are per delivery location; call get_location to see the current one " +
  "and set_location to change it.";

const listingArguments = {
  page: z.number().int().min(1).default(1).describe("1-based page of results; 40 per page."),
  sort: z
    .enum(SORT_OPTIONS)
    .default("Relevance")
    .describe(
      "Result order. CUPAsc uses the site's raw cup price, whose measure varies per product " +
        "($/L, $/100g, $/1ea), so it ranks meaningfully only within one category and is absent " +
        "for many products.",
    ),
  includeOutOfStock: z
    .boolean()
    .default(false)
    .describe("Include products that cannot be bought at the current location."),
};

export function registerCatalogueTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "list_categories",
    {
      title: "List Woolworths categories",
      description:
        "The browse tree. With no argument, lists the 13 departments and their slugs. With a " +
        "department slug, lists that department's aisles and shelves. Every slug it returns is " +
        "usable with browse_category, at any level.",
      inputSchema: {
        department: z
          .string()
          .optional()
          .describe("Department slug, e.g. 'beer-wine'. Omit to list the departments."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ department }) =>
      guarded("list_categories", async () => {
        const departments = await api.listCategories();
        if (department === undefined) {
          return jsonResult({ departments: departments.map(toDepartmentSummary) });
        }
        const found = departments.find((candidate) => candidate.slug === department);
        if (found === undefined) {
          return errorResult(
            `No department with slug '${department}'. Known slugs: ${departments
              .map((candidate) => candidate.slug)
              .join(", ")}.`,
          );
        }
        return jsonResult(found);
      }),
  );

  server.registerTool(
    "browse_category",
    {
      title: "Browse a Woolworths category",
      description:
        "List the products in a department, aisle or shelf, using the slugs from " +
        "list_categories. A narrower level needs the wider ones too. Every slug is checked " +
        "against the tree, so a wrong one is an error naming the valid slugs rather than a " +
        "silent whole-department result. Returns one page: read `coverage` before answering " +
        `anything about the cheapest, the best, or whether something exists. ${LOCATION_CAVEAT}`,
      inputSchema: {
        department: z.string().min(1).describe("Department slug, e.g. 'beer-wine'. Required."),
        aisle: z
          .string()
          .optional()
          .describe("Aisle slug within the department, e.g. 'red-wine'. From list_categories."),
        shelf: z
          .string()
          .optional()
          .describe("Shelf slug within the aisle, e.g. 'pinot-noir'. From list_categories."),
        ...listingArguments,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ department, aisle, shelf, page, sort, includeOutOfStock }) =>
      guarded("browse_category", async () =>
        jsonResult(
          await api.browseCategory({
            department,
            ...(aisle === undefined ? {} : { aisle }),
            ...(shelf === undefined ? {} : { shelf }),
            page,
            sort,
            inStockOnly: !includeOutOfStock,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_specials",
    {
      title: "Get Woolworths specials",
      description:
        "List products currently on special, optionally narrowed to one department. Each product " +
        "carries wasPrice alongside the current price. Returns one page: read `coverage` before " +
        `claiming anything is the best or only special available. ${LOCATION_CAVEAT}`,
      inputSchema: {
        department: z
          .string()
          .optional()
          .describe("Department slug from list_categories, e.g. 'meat-poultry'."),
        ...listingArguments,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ department, page, sort, includeOutOfStock }) =>
      guarded("get_specials", async () =>
        jsonResult(
          await api.getSpecials({
            ...(department === undefined ? {} : { department }),
            page,
            sort,
            inStockOnly: !includeOutOfStock,
          }),
        ),
      ),
  );
}
