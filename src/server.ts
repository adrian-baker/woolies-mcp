import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCatalogueTools } from "./tools/catalogue.js";
import { registerLocationTools } from "./tools/location.js";
import { registerProductTools } from "./tools/products.js";
import { registerStoreTools } from "./tools/stores.js";
import { WoolworthsApi } from "./woolworths/api.js";
import { Authenticator } from "./woolworths/auth.js";
import { Session, type SessionOptions } from "./woolworths/session.js";

export const SERVER_NAME = "woolies-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  readonly session?: SessionOptions;
}

/** One Woolworths session and the API built on it, shared by every tool in a server instance. */
export function createWoolworthsApi(options: ServerOptions = {}): WoolworthsApi {
  const session = new Session(options.session ?? {});
  return new WoolworthsApi(session, new Authenticator());
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
        "Shops woolworths.co.nz (New Zealand) for one signed-in household: reads the catalogue " +
        "and fills the cart. It never places an order, pays, or books a delivery window. Prices " +
        "and availability are for the address the cart is being delivered to, so call " +
        "get_location before quoting either.",
    },
  );

  registerProductTools(server, api);
  registerCatalogueTools(server, api);
  registerStoreTools(server, api);
  registerLocationTools(server, api);
  registerAccountTools(server, api);
  return server;
}
