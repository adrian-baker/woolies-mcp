import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Clients, authorisation codes and tokens for the built-in authorisation server.
 *
 * Tokens are opaque random strings, never JWTs: this server has storage and is the only issuer
 * and the only verifier, so a self-describing token would buy nothing and cost revocability.
 *
 * Only the SHA-256 of a token is held. The file on disk, and this process's heap, therefore
 * cannot yield a working credential.
 */

const TOKEN_BYTES = 32;
const CODE_TTL_MS = 60_000;
/** Long enough for a person to read the page and find their passphrase. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface RegisteredClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string | undefined;
  readonly registeredAt: number;
}

export interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scope: string;
  /** The client's own CSRF value, echoed back untouched. Held here so a form cannot swap it. */
  readonly state: string;
  readonly expiresAt: number;
}

export interface TokenGrant {
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
  /** Milliseconds since the epoch. Absent on a refresh token, which does not expire on a clock. */
  readonly expiresAt: number | undefined;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

interface PersistedState {
  readonly clients: readonly RegisteredClient[];
  readonly refreshTokens: readonly (TokenGrant & { readonly hash: string })[];
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Compares a secret without leaking its length or contents through timing.
 * Both sides are hashed first so unequal lengths reach `timingSafeEqual` as equal-length buffers.
 */
export function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

export class OAuthStore {
  private readonly path: string | undefined;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, PendingCode>();
  /** Authorisation requests validated at GET /authorize, awaiting the person at POST /authorize. */
  private readonly requests = new Map<string, PendingCode>();
  /** In memory only: an hour-long token is cheaper to re-mint from a refresh than to persist. */
  private readonly accessTokens = new Map<string, TokenGrant>();
  private readonly refreshTokens = new Map<string, TokenGrant>();

  constructor(path: string | undefined) {
    this.path = path?.trim() === "" ? undefined : path;
  }

  /**
   * Reads the persisted clients and refresh tokens.
   *
   * A file that exists but cannot be parsed throws: starting with an empty store would silently
   * revoke every client, which presents as an authorisation loop rather than as a failure.
   */
  async load(): Promise<void> {
    const path = this.path;
    if (path === undefined) return;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw new Error(`OAuth state at ${path} could not be read.`, { cause: error });
    }

    const parsed = readState(JSON.parse(raw));
    if (parsed === undefined) {
      throw new Error(`OAuth state at ${path} is not { clients, refreshTokens }.`);
    }
    for (const client of parsed.clients) this.clients.set(client.clientId, client);
    for (const { hash: tokenHash, ...grant } of parsed.refreshTokens) {
      this.refreshTokens.set(tokenHash, grant);
    }
  }

  private async persist(): Promise<void> {
    const path = this.path;
    if (path === undefined) return;
    const state: PersistedState = {
      clients: [...this.clients.values()],
      refreshTokens: [...this.refreshTokens].map(([tokenHash, grant]) => ({
        hash: tokenHash,
        ...grant,
      })),
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  async registerClient(
    redirectUris: readonly string[],
    clientName: string | undefined,
  ): Promise<RegisteredClient> {
    const client: RegisteredClient = {
      clientId: newToken(),
      redirectUris,
      clientName,
      registeredAt: Date.now(),
    };
    this.clients.set(client.clientId, client);
    await this.persist();
    return client;
  }

  client(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Holds a validated authorisation request server-side and returns its handle.
   *
   * The consent form carries only this handle. Round-tripping the request parameters through
   * hidden fields would let the posted form differ from the one that was validated.
   */
  stashRequest(pending: Omit<PendingCode, "expiresAt">): string {
    const id = newToken();
    this.requests.set(hash(id), { ...pending, expiresAt: Date.now() + REQUEST_TTL_MS });
    return id;
  }

  /** Single use, so a resubmitted consent form cannot mint a second code. */
  takeRequest(id: string): PendingCode | undefined {
    const key = hash(id);
    const pending = this.requests.get(key);
    this.requests.delete(key);
    if (pending === undefined || pending.expiresAt < Date.now()) return undefined;
    return pending;
  }

  /** The code itself, returned once. Only its hash is retained. */
  issueCode(pending: Omit<PendingCode, "expiresAt">): string {
    const code = newToken();
    this.codes.set(hash(code), { ...pending, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  /** Single use: the code is removed whether or not it turns out to be valid or current. */
  redeemCode(code: string): PendingCode | undefined {
    const key = hash(code);
    const pending = this.codes.get(key);
    this.codes.delete(key);
    if (pending === undefined || pending.expiresAt < Date.now()) return undefined;
    return pending;
  }

  async issueTokens(grant: Omit<TokenGrant, "expiresAt">): Promise<IssuedTokens> {
    const accessToken = newToken();
    const refreshToken = newToken();
    this.accessTokens.set(hash(accessToken), {
      ...grant,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    this.refreshTokens.set(hash(refreshToken), { ...grant, expiresAt: undefined });
    await this.persist();
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  /** Rotates: the presented refresh token is spent, so a replay of it finds nothing. */
  async redeemRefreshToken(refreshToken: string): Promise<IssuedTokens | undefined> {
    const key = hash(refreshToken);
    const grant = this.refreshTokens.get(key);
    if (grant === undefined) return undefined;
    this.refreshTokens.delete(key);
    return await this.issueTokens({
      clientId: grant.clientId,
      scope: grant.scope,
      resource: grant.resource,
    });
  }

  /** The grant behind a live access token, or undefined when it is unknown or expired. */
  verifyAccessToken(accessToken: string): TokenGrant | undefined {
    const key = hash(accessToken);
    const grant = this.accessTokens.get(key);
    if (grant === undefined) return undefined;
    if (grant.expiresAt !== undefined && grant.expiresAt < Date.now()) {
      this.accessTokens.delete(key);
      return undefined;
    }
    return grant;
  }

  /** RFC 7009 is deliberately silent about which kind was presented; both maps are tried. */
  async revoke(token: string): Promise<void> {
    const key = hash(token);
    this.accessTokens.delete(key);
    if (this.refreshTokens.delete(key)) await this.persist();
  }
}

/**
 * Parses the persisted file entry by entry. A cast here would let a hand-edited or truncated file
 * install a client with no redirect URIs, which fails later as a refused authorisation rather
 * than as a bad file.
 */
function readState(parsed: unknown): PersistedState | undefined {
  const record = asRecord(parsed);
  if (record === undefined) return undefined;
  const rawClients = record["clients"];
  const rawTokens = record["refreshTokens"];
  if (!Array.isArray(rawClients) || !Array.isArray(rawTokens)) return undefined;

  const clients: RegisteredClient[] = [];
  for (const entry of rawClients) {
    const client = readClient(entry);
    if (client === undefined) return undefined;
    clients.push(client);
  }

  const refreshTokens: (TokenGrant & { readonly hash: string })[] = [];
  for (const entry of rawTokens) {
    const token = readRefreshToken(entry);
    if (token === undefined) return undefined;
    refreshTokens.push(token);
  }

  return { clients, refreshTokens };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function readClient(entry: unknown): RegisteredClient | undefined {
  const record = asRecord(entry);
  if (record === undefined) return undefined;
  const clientId = record["clientId"];
  const redirectUris = record["redirectUris"];
  const clientName = record["clientName"];
  const registeredAt = record["registeredAt"];
  if (typeof clientId !== "string" || clientId === "") return undefined;
  if (!Array.isArray(redirectUris) || !redirectUris.every((uri) => typeof uri === "string")) {
    return undefined;
  }
  if (clientName !== undefined && typeof clientName !== "string") return undefined;
  if (typeof registeredAt !== "number") return undefined;
  return { clientId, redirectUris, clientName, registeredAt };
}

function readRefreshToken(entry: unknown): (TokenGrant & { readonly hash: string }) | undefined {
  const record = asRecord(entry);
  if (record === undefined) return undefined;
  const tokenHash = record["hash"];
  const clientId = record["clientId"];
  const scope = record["scope"];
  const resource = record["resource"];
  if (typeof tokenHash !== "string" || tokenHash === "") return undefined;
  if (typeof clientId !== "string" || typeof scope !== "string" || typeof resource !== "string") {
    return undefined;
  }
  return { hash: tokenHash, clientId, scope, resource, expiresAt: undefined };
}
