/**
 * Environment is parsed once, here, and a bad value stops the process before it serves anything
 * (CODE_STANDARDS §6). Nothing else in the server reads `process.env`.
 */

export class ConfigError extends Error {}

export interface OAuthConfig {
  /**
   * The public https origin this deployment answers on. It is the OAuth issuer and the base of
   * every advertised endpoint, so a value that does not match what the client actually reached
   * produces a flow that discovers endpoints nobody serves.
   */
  readonly publicUrl: URL;
  /** The one shared secret typed on the consent page. It is the only thing gating access. */
  readonly passphrase: string;
  /** Registered clients and refresh tokens. Unset keeps them in memory, lost on restart. */
  readonly statePath: string | undefined;
}

export interface HttpConfig {
  readonly port: number;
  /**
   * The unguessable path segment: MCP is served only at `/mcp/<pathToken>`, and every other
   * path 404s. This is obscurity, not authentication, and it is the only thing protecting the
   * account: the server holds a signed-in session, so whoever reaches this URL shops as the
   * shopper — reading their orders and writing to their cart. Treat the token as a credential.
   */
  readonly pathToken: string;
  /**
   * Present only when MCP_PUBLIC_URL is set. When present, MCP is served at `/mcp` behind a
   * bearer token and the token path serves nothing but the session handover: two doors to the
   * same account, one of them weaker, is the weaker one.
   */
  readonly oauth: OAuthConfig | undefined;
  /** Where the Woolworths cookies are persisted. Unset means a restart starts anonymous. */
  readonly sessionPath: string | undefined;
}

export const DEFAULT_HTTP_PORT = 8480;
const MIN_PATH_TOKEN_LENGTH = 16;

export function readHttpConfig(env: Readonly<Record<string, string | undefined>>): HttpConfig {
  const token = env["MCP_PATH_TOKEN"]?.trim();
  if (token === undefined || token === "") {
    throw new ConfigError(
      "MCP_PATH_TOKEN is not set. Generate one with `openssl rand -hex 24` and put it in .env.",
    );
  }
  if (token.length < MIN_PATH_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_PATH_TOKEN must be at least ${MIN_PATH_TOKEN_LENGTH} characters; got ${token.length}.`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ConfigError("MCP_PATH_TOKEN must be URL-safe: letters, digits, underscore, hyphen.");
  }

  return {
    port: readPort(env["PORT"]),
    pathToken: token,
    oauth: readOAuth(env),
    sessionPath: env["WOOLIES_SESSION_FILE"],
  };
}

const MIN_PASSPHRASE_LENGTH = 12;

function readOAuth(env: Readonly<Record<string, string | undefined>>): OAuthConfig | undefined {
  const raw = env["MCP_PUBLIC_URL"]?.trim();
  if (raw === undefined || raw === "") return undefined;

  let publicUrl: URL;
  try {
    publicUrl = new URL(raw);
  } catch {
    throw new ConfigError(`MCP_PUBLIC_URL is not a URL: '${raw}'.`);
  }
  // Loopback is exempt so the offline check can run the real flow without a certificate.
  const loopback = publicUrl.hostname === "127.0.0.1" || publicUrl.hostname === "localhost";
  if (publicUrl.protocol !== "https:" && !loopback) {
    throw new ConfigError(`MCP_PUBLIC_URL must be https; got '${raw}'.`);
  }
  if (publicUrl.search !== "" || publicUrl.hash !== "") {
    throw new ConfigError("MCP_PUBLIC_URL must carry no query string and no fragment.");
  }

  const passphrase = env["MCP_AUTH_PASSPHRASE"];
  if (passphrase === undefined || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ConfigError(
      `MCP_AUTH_PASSPHRASE must be set to at least ${MIN_PASSPHRASE_LENGTH} characters when ` +
        "MCP_PUBLIC_URL is: it is the only thing standing between the internet and this account.",
    );
  }

  return { publicUrl, passphrase, statePath: env["MCP_OAUTH_FILE"] };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535; got '${raw}'.`);
  }
  return port;
}
