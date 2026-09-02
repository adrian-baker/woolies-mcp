#!/usr/bin/env node
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { ConfigError, readHttpConfig, type HttpConfig } from "./config.js";
import { createServer, createWoolworthsApi, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { SessionStore, defaultSessionFilePath, restoreStoredSession } from "./session-store.js";
import type { WoolworthsApi } from "./woolworths/api.js";

/**
 * Streamable HTTP entry point, for the NAS deployment behind Tailscale Funnel.
 *
 * Stateless at the protocol level: every request builds its own server and transport, so there is
 * no session table to grow and no state to lose on restart.
 *
 * The Woolworths session is deliberately *not* per-request. One upstream session is shared by
 * every caller, so the throttle stays global and the deployment remains one shopper rather than
 * one per request (DESIGN.md, "Politeness"). The delivery location is therefore shared too,
 * which suits a single-user deployment.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function handleMcp(
  api: WoolworthsApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createServer(api);
  const transport = statelessTransport();
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(req, res);
}

/**
 * Stateless mode: `sessionIdGenerator: undefined` means no session id and no cross-request state.
 *
 * Deviation from the house `exactOptionalPropertyTypes` rule, confined to this function: the SDK
 * declares `sessionIdGenerator` as `() => string` while documenting `undefined` as the stateless
 * setting, and declares `Transport.onclose` non-optional while implementing it as optional. The
 * casts describe the SDK's real contract, not a shape left unchecked.
 */
type TransportOptions = Readonly<ConstructorParameters<typeof StreamableHTTPServerTransport>[0]>;

function statelessTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as TransportOptions);
}

function notFound(res: ServerResponse): void {
  // Empty body: an unknown path learns nothing about what is served here.
  res.writeHead(404).end();
}

const MAX_SESSION_BODY_BYTES = 256 * 1024;

/**
 * Receives a session captured by `npm run login` in a real browser.
 *
 * Guarded by the same secret path as the MCP endpoint, so anyone who can reach this could already
 * drive the tools. The cookies are held in memory only; a restart needs a fresh handover.
 */
async function handleSessionImport(
  api: WoolworthsApi,
  store: SessionStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  const body = await readBody(req);
  const parsed = parseCookies(body);
  if (typeof parsed === "string") {
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: `expected { cookies: [{ setCookie, url }] }: ${parsed}` }));
    return;
  }
  const cookies = parsed;

  const access = await api.importSession(cookies);
  const cookieExpiry = access.usable ? await api.cookieExpiry() : undefined;
  // Stored only once an account call has actually worked, so a restart never restores junk.
  if (access.usable) await store.save(cookies);
  console.error(
    `[${SERVER_NAME}] session handover: ${cookies.length} cookies, signedIn=${access.usable}`,
  );
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      imported: cookies.length,
      signedIn: access.usable,
      // The cookie's stated ceiling, not a promise the session lasts that long.
      cookieExpiresAt: cookieExpiry?.toISOString(),
      persisted: access.usable && store.isEnabled,
    }),
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_SESSION_BODY_BYTES) throw new Error("session handover body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The cookies, or a sentence saying what was wrong with the body.
 *
 * Four different malformations used to collapse into one `undefined`, which made a rejected
 * handover impossible to diagnose from the response: the caller was told the expected shape but
 * never which part of theirs failed.
 */
function parseCookies(body: string): readonly { setCookie: string; url: string }[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error: unknown) {
    return `body is not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return `body is ${JSON.stringify(parsed)}, not an object`;
  }
  const list = (parsed as Record<string, unknown>)["cookies"];
  if (!Array.isArray(list)) {
    return `"cookies" is ${list === undefined ? "missing" : "not an array"}`;
  }

  const cookies: { setCookie: string; url: string }[] = [];
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return `cookies[${index}] is ${JSON.stringify(entry)}, not an object`;
    }
    const record = entry as Record<string, unknown>;
    const setCookie = record["setCookie"];
    const url = record["url"];
    if (typeof setCookie !== "string" || typeof url !== "string") {
      return `cookies[${index}] needs string setCookie and url; it carried ${Object.keys(record).join(", ")}`;
    }
    cookies.push({ setCookie, url });
  }
  return cookies;
}

export async function startHttpServer(
  config: HttpConfig,
): Promise<ReturnType<typeof createHttpServer>> {
  const mcpPath = `/mcp/${config.pathToken}`;
  const api = createWoolworthsApi();
  const store = new SessionStore(process.env["WOOLIES_SESSION_FILE"] ?? defaultSessionFilePath());
  // Awaited before anything can be served. The restore costs two throttled round trips, and a
  // tool call inside that window would answer as a guest — at a guest's store, with a guest's
  // prices — without saying so.
  await restoreStoredSession(api, store, SERVER_NAME);

  const httpServer = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (path === `${mcpPath}/session`) {
      handleSessionImport(api, store, req, res).catch((error: unknown) => {
        console.error(`[${SERVER_NAME}] session handover failed:`, error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
      });
      return;
    }

    if (path !== mcpPath) {
      notFound(res);
      return;
    }

    handleMcp(api, req, res).catch((error: unknown) => {
      console.error(`[${SERVER_NAME}] request failed:`, error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  });

  httpServer.listen(config.port, () => {
    // The token is deliberately not logged: the path is the only thing guarding the endpoint.
    console.error(
      `[${SERVER_NAME}] ${SERVER_VERSION} listening on :${config.port}, MCP at /mcp/<token>`,
    );
  });

  return httpServer;
}

/** A misconfigured deploy must fail here, loudly and readably, not on the first request. */
function readConfigOrExit(): HttpConfig {
  try {
    return readHttpConfig(process.env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      console.error(`[${SERVER_NAME}] configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfigOrExit();
  const httpServer = await startHttpServer(config);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${SERVER_NAME}] ${signal} received, closing`);
    const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
