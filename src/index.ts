#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  SessionStore,
  defaultSessionFilePath,
  restoreStoredSession,
} from "./session-store.js";
import { createServer, createWoolworthsApi, SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * stdio entry point. stdout carries JSON-RPC only, so every diagnostic goes to stderr.
 *
 * A stored sign-in is loaded before the transport connects, so the account tools are usable on
 * the first call rather than silently anonymous.
 */
async function main(): Promise<void> {
  const api = createWoolworthsApi();
  const store = new SessionStore(process.env["WOOLIES_SESSION_FILE"] ?? defaultSessionFilePath());
  await restoreStoredSession(api, store, SERVER_NAME);

  const server = createServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] ${SERVER_VERSION} ready on stdio`);

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[${SERVER_NAME}] ${signal} received, closing`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] failed to start:`, error);
  process.exit(1);
});
