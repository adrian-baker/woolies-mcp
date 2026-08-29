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
console.log("tools/call search_products ->", summarise(searched));

await client.close();

function summarise(result: unknown): string {
  const text = firstText(result);
  if (text === undefined) return JSON.stringify(result);
  const parsed: unknown = JSON.parse(text);
  const search = parsed as { items?: unknown[]; totalItems?: number; page?: number; sort?: string };
  return `${search.items?.length ?? 0} items of ${search.totalItems ?? 0}, page ${search.page}, sort ${search.sort}, first ${JSON.stringify(search.items?.[0])}`;
}

function firstText(result: unknown): string | undefined {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const block = content?.[0];
  return block?.type === "text" ? block.text : undefined;
}

const names = new Set(tools.map((tool) => tool.name));
const expected = ["search_products", "get_product", "get_location", "set_location"];
const missing = expected.filter((name) => !names.has(name));
const errored = located.isError === true || searched.isError === true;
if (missing.length > 0 || errored) {
  console.log(`FAILED${missing.length > 0 ? `: missing ${missing.join(", ")}` : ": tool errored"}`);
  process.exitCode = 1;
} else {
  console.log("stdio check passed.");
}
