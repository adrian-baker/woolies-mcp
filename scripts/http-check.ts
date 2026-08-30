/**
 * Verifies a running Streamable HTTP deployment: health, that unknown paths 404, and a real MCP
 * initialize + tools/list + one tools/call through the token path.
 *
 * Usage: tsx scripts/http-check.ts <baseUrl> <pathToken>
 *   e.g. tsx scripts/http-check.ts http://127.0.0.1:8480 $MCP_PATH_TOKEN
 *
 * The token is taken as an argument rather than printed, so it stays out of the transcript.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [baseUrl, pathToken] = process.argv.slice(2);
if (baseUrl === undefined || pathToken === undefined) {
  console.error("usage: tsx scripts/http-check.ts <baseUrl> <pathToken>");
  process.exit(2);
}

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const health = await fetch(new URL("/healthz", baseUrl));
check("healthz", health.status === 200, `HTTP ${health.status} ${await health.text()}`);

const bogus = await fetch(new URL("/mcp/definitely-not-the-token", baseUrl));
check("unknown path 404s", bogus.status === 404, `HTTP ${bogus.status}`);

const root = await fetch(new URL("/", baseUrl));
check("root 404s", root.status === 404, `HTTP ${root.status}`);

const endpoint = new URL(`/mcp/${pathToken}`, baseUrl);
const client = new Client({ name: "woolies-mcp-http-check", version: "0.1.0" });
// The SDK declares Transport.sessionId as required while implementing it as optional; same
// exactOptionalPropertyTypes mismatch as in src/http.ts.
const transport = new StreamableHTTPClientTransport(endpoint);
await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
check("initialize", true, JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
check(
  "tools/list",
  tools.length > 0,
  `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
);

const called = await client.callTool({ name: "get_location", arguments: {} });
const text = (called.content as { type: string; text?: string }[])[0]?.text ?? "";
check("tools/call get_location", called.isError !== true, text.replace(/\s+/g, " ").slice(0, 120));

await client.close();

if (failures.length > 0) {
  console.log(`\nHTTP check FAILED: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nHTTP check passed.");
}
