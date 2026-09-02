import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WoolworthsApi } from "../woolworths/api.js";
import { guarded, jsonResult } from "./respond.js";

export function registerStoreTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "find_stores",
    {
      title: "Find Woolworths pick-up stores",
      description:
        "List Woolworths New Zealand pick-up locations near the cart's delivery address, " +
        "optionally narrowed by a name or address fragment. This is a proximity search, never " +
        "the national list: `complete` is always false, so a store's absence is never evidence " +
        "it does not exist — search for it by name. Each store appears once, with every region " +
        "it is listed under in `areas`. These are collection points; the delivery location that " +
        "sets prices is separate and is reported by get_location.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Store or suburb name fragment, e.g. 'Ponsonby'. Omit for the nearest locations.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) =>
      guarded("find_stores", async () => jsonResult(await api.findStores(query))),
  );
}
