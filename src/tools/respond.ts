import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every tool answers with pretty-printed JSON: compact enough to read, structured enough to use. */
export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Runs a tool body, turning a thrown error into a tool error the model can act on.
 * The stack goes to stderr; only the message crosses the protocol boundary.
 */
export async function guarded(
  tool: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error: unknown) {
    console.error(`[woolies-mcp] ${tool} failed:`, error);
    return errorResult(`${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
