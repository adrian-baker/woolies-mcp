import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCatalogueTools } from "./tools/catalogue.js";
import { registerLocationTools } from "./tools/location.js";
import { registerProductTools } from "./tools/products.js";
import { registerStoreTools } from "./tools/stores.js";
import { WoolworthsApi } from "./woolworths/api.js";
import { AutoSignIn, performCredentialSignIn } from "./woolworths/credential-signin.js";
import { Session, type SessionOptions } from "./woolworths/session.js";
import type { SessionStore } from "./session-store.js";

export const SERVER_NAME = "woolies-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  readonly session?: SessionOptions;
  /**
   * `{ "email", "password" }` for automatic sign-in. Unset turns it off; set but absent on disk
   * leaves it off until the file appears.
   */
  readonly credentialsPath?: string | undefined;
  /** Where a session the server signs in itself is saved, so a restart restores it. */
  readonly sessionStore?: SessionStore;
}

/** One Woolworths session and the API built on it, shared by every tool in a server instance. */
export function createWoolworthsApi(options: ServerOptions = {}): WoolworthsApi {
  const session = new Session(options.session ?? {});
  const credentialsPath = options.credentialsPath;
  const store = options.sessionStore;
  const autoSignIn =
    credentialsPath === undefined
      ? undefined
      : new AutoSignIn({
          credentialsPath,
          signIn: (credentials) => performCredentialSignIn(session, credentials),
          onSignedIn: async () => {
            if (store !== undefined) await store.save(await session.exportCookies());
          },
        });
  return new WoolworthsApi(session, Date.now, undefined, autoSignIn);
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
