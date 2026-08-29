import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WoolworthsApi } from "../woolworths/api.js";
import { errorResult, guarded, jsonResult } from "./respond.js";

export function registerLocationTools(server: McpServer, api: WoolworthsApi): void {
  server.registerTool(
    "get_location",
    {
      title: "Get the current Woolworths delivery location",
      description:
        "Report the delivery location this session is shopping from: suburb, fulfilment method " +
        "and store id. Every price and availability answer from the other tools is for this " +
        "location, so check it before trusting a result.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guarded("get_location", async () => jsonResult(await api.getFulfilment())),
  );

  server.registerTool(
    "set_location",
    {
      title: "Set the Woolworths delivery location",
      description:
        "Switch the session to a New Zealand suburb, which changes the serving store and " +
        "therefore the prices and availability that search_products and get_product return. " +
        "If the suburb name matches several places, the matches are returned instead and you " +
        "should ask for a more specific name.",
      inputSchema: {
        suburb: z
          .string()
          .min(2)
          .describe("Suburb name, e.g. 'Ponsonby'. Partial names match, so be specific."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ suburb }) =>
      guarded("set_location", async () => {
        const outcome = await api.setLocation(suburb);
        switch (outcome.kind) {
          case "set": {
            const interpreted = outcome.interpretedAs;
            return jsonResult({
              status: "set",
              suburb: outcome.suburb,
              // Say so plainly when the site matched something other than what was asked for,
              // rather than letting a silent substitution look like an exact hit.
              note:
                interpreted === undefined
                  ? undefined
                  : `Interpreted '${suburb}' as '${interpreted}'.`,
              fulfilment: outcome.fulfilment,
            });
          }
          case "ambiguous":
            return jsonResult({
              status: "ambiguous",
              message: `'${suburb}' matches ${outcome.matches.length} suburbs. Ask which one is meant, then call set_location again with the full name.`,
              matches: outcome.matches,
            });
          case "notFound":
            return errorResult(`No New Zealand suburb matches '${suburb}'.`);
          default:
            return assertNever(outcome);
        }
      }),
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled set_location outcome: ${JSON.stringify(value)}`);
}
