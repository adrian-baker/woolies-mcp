import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";

/** The full list runs to hundreds of stores, so an unfiltered call is capped. */
const UNFILTERED_LIMIT = 50;

export function registerStoreTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "find_stores",
    {
      title: "Find Woolworths pick-up stores",
      description:
        "List Woolworths New Zealand pick-up locations, filtered by a name or address fragment. " +
        "These are collection points; the delivery location that sets prices is separate and is " +
        "managed with get_location and set_location.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            `Store or suburb name fragment, e.g. 'Ponsonby'. Omit to sample the first ${UNFILTERED_LIMIT}.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) =>
      guarded("find_stores", async () => {
        const found = await api.findStores(query);
        if (query !== undefined) return jsonResult(found);
        const listed = found.stores.slice(0, UNFILTERED_LIMIT);
        return jsonResult({
          ...found,
          stores: listed,
          returned: listed.length,
          complete: listed.length === found.stores.length,
          coverage:
            `Showing ${listed.length} of ${found.stores.length} pick-up locations. This is NOT ` +
            "the full list — pass a query to search it rather than concluding from these.",
        });
      }),
  );
}
