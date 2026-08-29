/**
 * Environment is parsed once, here, and a bad value stops the process before it serves anything
 * (CODE_STANDARDS §6). Nothing else in the server reads `process.env`.
 */

export class ConfigError extends Error {}

export interface HttpConfig {
  readonly port: number;
  /**
   * The unguessable path segment: MCP is served only at `/mcp/<pathToken>`, and every other
   * path 404s. This is obscurity, not authentication — it keeps the endpoint out of scanners,
   * and the server behind it stays read-only for anonymous callers.
   */
  readonly pathToken: string;
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

  return { port: readPort(env["PORT"]), pathToken: token };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535; got '${raw}'.`);
  }
  return port;
}
