/**
 * Drives the built stdio server as a client would: initialize, tools/list, then one tools/call.
 * Verifies the MCP layer rather than the API (scripts/smoke.ts covers that).
 *
 * Run with `npm run check:stdio` after `npm run build`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** The fields `search_products` actually returns; see SearchResult in src/woolworths/api.ts. */
const SEARCH_FIELDS = ["products", "matchesAvailable", "page", "coverage"] as const;

const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
const client = new Client({ name: "woolies-mcp-stdio-check", version: "0.1.0" });

await client.connect(transport);
console.log("connected:", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
console.log(`tools/list -> ${tools.length} tools`);
for (const tool of tools) {
  const required = tool.inputSchema.required ?? [];
  console.log(`  ${tool.name}(${required.join(", ")}) — ${tool.description?.slice(0, 70)}…`);
}

const located = await client.callTool({ name: "get_location", arguments: {} });
console.log("tools/call get_location ->", JSON.stringify(located));

// Only the required argument, so the optional page/sort defaults must come from the schema.
const searched = await client.callTool({
  name: "search_products",
  arguments: { query: "oat milk" },
});
const searchSummary = summariseSearch(searched);
console.log("tools/call search_products ->", describeSearch(searchSummary));
if (searchSummary.kind === "read") console.log(`  coverage: ${searchSummary.coverage}`);

await client.close();

/**
 * What `search_products` returned, or why it could not be read.
 *
 * A payload this cannot read is `unreadable`, never summarised as zero. The fields were once read
 * under the wrong names, which made every run print "0 items of 0" — a genuinely empty search and
 * a healthy one looked identical, which is the failure this check exists to catch.
 */
type SearchSummary =
  | {
      readonly kind: "read";
      readonly products: number;
      readonly matchesAvailable: number;
      readonly page: number;
      readonly coverage: string;
      readonly first: string | undefined;
    }
  | { readonly kind: "unreadable"; readonly why: string };

function summariseSearch(result: unknown): SearchSummary {
  const text = firstText(result);
  if (text === undefined) {
    return { kind: "unreadable", why: `no text content: ${JSON.stringify(result).slice(0, 200)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return {
      kind: "unreadable",
      why: `body is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unreadable", why: `payload is ${String(parsed)}, not an object` };
  }

  const record = parsed as Readonly<Record<string, unknown>>;
  const missing = SEARCH_FIELDS.filter((field) => record[field] === undefined);
  if (missing.length > 0) {
    return {
      kind: "unreadable",
      why: `payload has no ${missing.join(", ")}; it carried ${Object.keys(record).join(", ")}`,
    };
  }

  const { products, matchesAvailable, page, coverage } = record;
  if (
    !Array.isArray(products) ||
    typeof matchesAvailable !== "number" ||
    typeof page !== "number" ||
    typeof coverage !== "string"
  ) {
    return {
      kind: "unreadable",
      why: `unexpected types on ${Object.keys(record).join(", ")}`,
    };
  }

  const first: unknown = products[0];
  return {
    kind: "read",
    products: products.length,
    matchesAvailable,
    page,
    coverage,
    first: first === undefined ? undefined : JSON.stringify(first),
  };
}

function describeSearch(summary: SearchSummary): string {
  if (summary.kind === "unreadable") return `UNREADABLE — ${summary.why}`;
  return (
    `${summary.products} products of ${summary.matchesAvailable}, page ${summary.page}, ` +
    `first ${summary.first ?? "(none)"}`
  );
}

function firstText(result: unknown): string | undefined {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const block = content?.[0];
  return block?.type === "text" ? block.text : undefined;
}

const names = new Set(tools.map((tool) => tool.name));
const expected = ["search_products", "get_product", "get_location", "get_cart"];
const missingTools = expected.filter((name) => !names.has(name));

// A search that came back empty or unreadable fails here. Passing on `isError` alone let the
// tool answer with nothing and still look healthy.
const reasons = [
  ...(missingTools.length > 0 ? [`missing tools ${missingTools.join(", ")}`] : []),
  ...(located.isError === true || searched.isError === true ? ["a tool errored"] : []),
  ...(searchSummary.kind === "unreadable"
    ? [`the search response could not be read — ${searchSummary.why}`]
    : []),
  ...(searchSummary.kind === "read" && searchSummary.products === 0
    ? ["the search returned no products"]
    : []),
];

if (reasons.length > 0) {
  console.log(`FAILED: ${reasons.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("stdio check passed.");
}
