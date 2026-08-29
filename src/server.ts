import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCatalogueTools } from "./tools/catalogue.js";
import { registerLocationTools } from "./tools/location.js";
import { registerProductTools } from "./tools/products.js";
import { registerStoreTools } from "./tools/stores.js";
import { WoolworthsApi } from "./woolworths/api.js";
import { Authenticator } from "./woolworths/auth.js";
import { WoolworthsClient, type ClientOptions } from "./woolworths/client.js";
import { Session, type SessionOptions } from "./woolworths/session.js";

export const SERVER_NAME = "woolies-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  readonly session?: SessionOptions;
  readonly client?: ClientOptions;
}

/** One Woolworths session and the API built on it, shared by every tool in a server instance. */
export function createWoolworthsApi(options: ServerOptions = {}): WoolworthsApi {
  const session = new Session(options.session ?? {});
  const client = new WoolworthsClient(session, options.client ?? {});
  return new WoolworthsApi(client, new Authenticator());
}

/**
 * Builds the server with its tools registered but no transport attached, so the stdio entry
 * point and a later Streamable HTTP entry point share one definition.
 */
export function createServer(api: WoolworthsApi = createWoolworthsApi()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to woolworths.co.nz (New Zealand). Prices and availability are per " +
        "delivery location: the session starts at a default store, so call get_location to see " +
        "where it is shopping and set_location to move it before quoting prices.",
    },
  );

  registerProductTools(server, api);
  registerCatalogueTools(server, api);
  registerStoreTools(server, api);
  registerLocationTools(server, api);
  registerAccountTools(server, api);
  return server;
}
