import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SHOP_SCOPE,
  authorizationServerMetadata,
  protectedResourceMetadata,
  resourceIdentifier,
} from "./metadata.js";
import { OAuthStore, secretsMatch, type TokenGrant } from "./store.js";

/**
 * The authorisation server and resource-server guard, on node:http.
 *
 * Hand-written rather than mounted from the SDK's router, which is Express-only: this server has
 * no web framework and adding one to reach five JSON endpoints would be the larger change.
 *
 * One shopper, one passphrase. There is no user table because there is no second user: the
 * deployment holds one Woolworths session, so anyone who authorises here shops as that shopper.
 */

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface OAuthOptions {
  readonly publicUrl: URL;
  readonly passphrase: string;
  readonly store: OAuthStore;
  /**
   * Whether the Woolworths session can still answer for the account.
   *
   * A refresh is refused when it cannot. That refusal is the only way to make a client open a
   * browser: a client holding a working refresh token renews in the background and the person
   * is never asked anything.
   */
  readonly upstreamSessionUsable: () => Promise<boolean>;
}

export class OAuthEndpoints {
  private readonly options: OAuthOptions;
  private failedAttempts = 0;
  private lockedUntil = 0;

  constructor(options: OAuthOptions) {
    this.options = options;
  }

  /** The URL a 401 points at, so a client can find the authorisation server from a failed call. */
  get resourceMetadataUrl(): string {
    return new URL("/.well-known/oauth-protected-resource", this.options.publicUrl).href;
  }

  get resource(): string {
    return resourceIdentifier(this.options.publicUrl);
  }

  /**
   * The promise for a request this server owns, or undefined so the caller keeps routing.
   *
   * Ownership is decided synchronously: a router that had to await before it could say "not
   * mine" would consume the body of requests belonging to someone else.
   */
  route(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> | undefined {
    if (!isOAuthPath(path)) return undefined;
    return this.dispatch(path, req, res);
  }

  private async dispatch(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      preflight(res);
      return;
    }
    if (isWellKnown(path, "oauth-protected-resource")) {
      cors(res);
      json(res, 200, protectedResourceMetadata(this.options.publicUrl));
      return;
    }
    if (isWellKnown(path, "oauth-authorization-server")) {
      cors(res);
      json(res, 200, authorizationServerMetadata(this.options.publicUrl));
      return;
    }
    if (path === "/register") {
      await this.register(req, res);
      return;
    }
    if (path === "/authorize") {
      await this.authorize(req, res);
      return;
    }
    if (path === "/token") {
      await this.token(req, res);
      return;
    }
    await this.revoke(req, res);
  }

  /**
   * Answers a request that carried no usable token.
   *
   * `error="invalid_token"` is what makes a client discard what it holds and start discovery
   * again; a bare 401 leaves it retrying with the same dead token.
   */
  challenge(res: ServerResponse, description: string): void {
    res.setHeader(
      "www-authenticate",
      `Bearer error="invalid_token", error_description="${description.replaceAll('"', "'")}", ` +
        `resource_metadata="${this.resourceMetadataUrl}"`,
    );
    json(res, 401, { error: "invalid_token", error_description: description });
  }

  /** The grant behind the request's bearer token, or a stated reason there is none. */
  authenticate(req: IncomingMessage): TokenGrant | string {
    const header = req.headers.authorization;
    if (header === undefined) return "no Authorization header";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || token === undefined || token === "") {
      return "Authorization header is not 'Bearer <token>'";
    }
    const grant = this.options.store.verifyAccessToken(token);
    if (grant === undefined) return "the access token is unknown or has expired";
    if (grant.resource !== this.resource) {
      return `the access token was issued for ${grant.resource}, not for this server`;
    }
    return grant;
  }

  /** RFC 7591. Open registration: the passphrase at /authorize is what actually guards access. */
  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body: unknown = JSON.parse(await readBody(req));
    const record = body as Record<string, unknown> | null;
    const redirectUris = record?.["redirect_uris"];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      json(res, 400, {
        error: "invalid_client_metadata",
        error_description: "redirect_uris must be a non-empty array",
      });
      return;
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isAllowedRedirect(uri)) {
        json(res, 400, {
          error: "invalid_redirect_uri",
          error_description: `${String(uri)} must be an https URL or a loopback http URL`,
        });
        return;
      }
    }
    const name = record?.["client_name"];
    const client = await this.options.store.registerClient(
      redirectUris as readonly string[],
      typeof name === "string" ? name : undefined,
    );
    cors(res);
    json(res, 201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.registeredAt / 1000),
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  private async authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      await this.showConsent(req, res);
      return;
    }
    if (req.method === "POST") {
      await this.decideConsent(req, res);
      return;
    }
    res.writeHead(405, { allow: "GET, POST" }).end();
  }

  private async showConsent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const query = new URL(req.url ?? "/", this.options.publicUrl).searchParams;
    const validated = this.validateAuthorizationRequest(query);
    if (typeof validated === "string") {
      html(res, 400, errorPage(validated));
      return;
    }
    // A redirect-able error is reported to the client, not to the person: a browser-facing page
    // would strand a client that is waiting on its callback.
    if ("redirectError" in validated) {
      redirect(res, validated.redirectError);
      return;
    }

    const requestId = this.options.store.stashRequest(validated.pending);
    let session: SessionState;
    try {
      session = (await this.options.upstreamSessionUsable()) ? "signedIn" : "signedOut";
    } catch {
      // Not a negative answer: this page is the recovery path, and refusing to render it because
      // the site could not be reached is how a person is left with nowhere to go.
      session = "unknown";
    }
    html(
      res,
      200,
      consentPage({
        requestId,
        clientName: validated.clientName,
        redirectUri: validated.pending.redirectUri,
        session,
        locked: this.lockRemainingMs() > 0,
      }),
    );
  }

  private async decideConsent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    const requestId = form.get("request_id") ?? "";
    const passphrase = form.get("passphrase") ?? "";

    const lockedFor = this.lockRemainingMs();
    if (lockedFor > 0) {
      html(
        res,
        429,
        errorPage(`Too many attempts. Try again in ${Math.ceil(lockedFor / 60000)} minutes.`),
      );
      return;
    }

    const pending = this.options.store.takeRequest(requestId);
    if (pending === undefined) {
      html(
        res,
        400,
        errorPage("This authorisation request has expired. Start again from the client."),
      );
      return;
    }

    if (!secretsMatch(passphrase, this.options.passphrase)) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        this.lockedUntil = Date.now() + LOCKOUT_MS;
        this.failedAttempts = 0;
      }
      html(res, 401, errorPage("That passphrase is not the one this server was configured with."));
      return;
    }
    this.failedAttempts = 0;

    const code = this.options.store.issueCode(pending);
    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.state !== "") target.searchParams.set("state", pending.state);
    redirect(res, target.href);
  }

  /**
   * The parameters of a well-formed authorisation request, a sentence for the person when the
   * request cannot safely be redirected, or a URL to bounce the error back to the client.
   */
  private validateAuthorizationRequest(query: URLSearchParams):
    | string
    | { readonly redirectError: string }
    | {
        readonly pending: Omit<Parameters<OAuthStore["stashRequest"]>[0], never>;
        readonly clientName: string | undefined;
      } {
    const clientId = query.get("client_id");
    if (clientId === null) return "The request carried no client_id.";
    const client = this.options.store.client(clientId);
    if (client === undefined) return "That client_id is not registered with this server.";

    const redirectUri = query.get("redirect_uri");
    if (redirectUri === null) return "The request carried no redirect_uri.";
    // Exact match against registration: a prefix or host match is how codes get delivered
    // to an attacker's path.
    if (!client.redirectUris.includes(redirectUri)) {
      return "That redirect_uri was not registered by this client.";
    }

    const state = query.get("state") ?? "";
    const fail = (error: string, description: string): { readonly redirectError: string } => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      if (state !== "") target.searchParams.set("state", state);
      return { redirectError: target.href };
    };

    if (query.get("response_type") !== "code") {
      return fail("unsupported_response_type", "only response_type=code is supported");
    }
    if (query.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256");
    }
    const codeChallenge = query.get("code_challenge");
    if (codeChallenge === null || codeChallenge === "") {
      return fail("invalid_request", "code_challenge is required");
    }
    // RFC 8707: a token is bound to the resource it was asked for, so one issued for another
    // deployment of this server cannot be replayed here. A client that omits it gets ours.
    const resource = query.get("resource");
    if (resource !== null && resource !== this.resource) {
      return fail("invalid_target", `this server is ${this.resource}`);
    }

    return {
      pending: {
        clientId,
        redirectUri,
        codeChallenge,
        resource: this.resource,
        scope: SHOP_SCOPE,
        state,
      },
      clientName: client.clientName,
    };
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    cors(res);
    const form = new URLSearchParams(await readBody(req));
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      await this.exchangeCode(form, res);
      return;
    }
    if (grantType === "refresh_token") {
      await this.refresh(form, res);
      return;
    }
    json(res, 400, {
      error: "unsupported_grant_type",
      error_description: `grant_type ${grantType ?? "(missing)"} is not supported`,
    });
  }

  private async exchangeCode(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (code === null || verifier === null) {
      json(res, 400, {
        error: "invalid_request",
        error_description: "code and code_verifier are both required",
      });
      return;
    }
    const pending = this.options.store.redeemCode(code);
    if (pending === undefined) {
      json(res, 400, {
        error: "invalid_grant",
        error_description: "that code is unknown, already used, or expired",
      });
      return;
    }
    if (form.get("client_id") !== pending.clientId) {
      json(res, 400, {
        error: "invalid_grant",
        error_description: "that code was issued to a different client",
      });
      return;
    }
    if (form.get("redirect_uri") !== pending.redirectUri) {
      json(res, 400, {
        error: "invalid_grant",
        error_description: "redirect_uri does not match the one the code was issued for",
      });
      return;
    }
    if (pkceChallenge(verifier) !== pending.codeChallenge) {
      json(res, 400, {
        error: "invalid_grant",
        error_description: "the code_verifier does not match the code_challenge",
      });
      return;
    }
    const issued = await this.options.store.issueTokens({
      clientId: pending.clientId,
      scope: pending.scope,
      resource: pending.resource,
    });
    json(res, 200, tokenResponse(issued.accessToken, issued.refreshToken, issued.expiresInSeconds));
  }

  /**
   * Refuses while the Woolworths session is dead, so the client stops renewing in the background
   * and runs the authorisation flow — which is what puts a browser in front of the person.
   */
  private async refresh(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const refreshToken = form.get("refresh_token");
    if (refreshToken === null) {
      json(res, 400, { error: "invalid_request", error_description: "refresh_token is required" });
      return;
    }
    if (!(await this.options.upstreamSessionUsable())) {
      json(res, 400, {
        error: "invalid_grant",
        error_description:
          "the Woolworths session this server holds is no longer signed in; authorise again to be shown how to renew it",
      });
      return;
    }
    const issued = await this.options.store.redeemRefreshToken(refreshToken);
    if (issued === undefined) {
      json(res, 400, {
        error: "invalid_grant",
        error_description: "that refresh token is unknown or has already been used",
      });
      return;
    }
    json(res, 200, tokenResponse(issued.accessToken, issued.refreshToken, issued.expiresInSeconds));
  }

  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    const token = form.get("token");
    if (token !== null) await this.options.store.revoke(token);
    cors(res);
    // RFC 7009: an unknown token is a successful revocation, so probing learns nothing.
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }

  private lockRemainingMs(): number {
    return Math.max(0, this.lockedUntil - Date.now());
  }
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Record<string, unknown> {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: SHOP_SCOPE,
  };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Both the bare well-known path and the path-suffixed form, because a client that knows the
 * resource is at /mcp looks for /.well-known/<doc>/mcp first (RFC 9728 §3.1).
 */
function isWellKnown(path: string, document: string): boolean {
  return path === `/.well-known/${document}` || path.startsWith(`/.well-known/${document}/`);
}

function isOAuthPath(path: string): boolean {
  return (
    isWellKnown(path, "oauth-protected-resource") ||
    isWellKnown(path, "oauth-authorization-server") ||
    path === "/register" ||
    path === "/token" ||
    path === "/revoke" ||
    path === "/authorize"
  );
}

/** Only https, or http on the loopback a desktop client listens on. */
function isAllowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    // A definite answer, not a swallowed failure: a string that is not a URL is not a redirect
    // this server will send a code to.
    // eslint-disable-next-line no-restricted-syntax
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
}

function preflight(res: ServerResponse): void {
  res
    .writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
      "access-control-max-age": "86400",
    })
    .end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (status >= 400) res.setHeader("cache-control", "no-store");
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res
    .writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    .end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" }).end();
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * No colours are stated. `color-scheme: light dark` hands the page to the reader's setting, and a
 * hard-coded foreground over an inherited background is how this rendered as dark text on black.
 */
const PAGE_HEAD =
  '<!doctype html><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<style>:root{color-scheme:light dark}*{box-sizing:border-box}" +
  "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem}" +
  "input{width:100%;padding:.5rem;margin:.5rem 0 1rem;font:inherit}" +
  "button{padding:.6rem 1.2rem;font:inherit}" +
  // A redirect URI is long and unbreakable; without this the page scrolls sideways on a phone.
  "code{overflow-wrap:anywhere}" +
  ".note{opacity:.7;font-size:.9rem}</style>";

interface ConsentView {
  readonly requestId: string;
  readonly clientName: string | undefined;
  readonly redirectUri: string;
  readonly session: SessionState;
  readonly locked: boolean;
}

function consentPage(view: ConsentView): string {
  const who = escapeHtml(view.clientName ?? "An unnamed client");
  const session = describeSession(view.session);
  const form = view.locked
    ? "<p>Too many failed attempts. This page will accept a passphrase again shortly.</p>"
    : `<form method="post" action="/authorize">
      <input type="hidden" name="request_id" value="${escapeHtml(view.requestId)}">
      <label for="p">Server passphrase</label>
      <input id="p" name="passphrase" type="password" autocomplete="current-password" required>
      <button type="submit">Approve</button>
    </form>`;
  return `${PAGE_HEAD}<title>Authorise woolies-mcp</title><body>
<h1>Authorise this client</h1>
<p>${who} is asking to shop as you: read your orders, and add to your cart. It will be sent back to <code>${escapeHtml(view.redirectUri)}</code>.</p>
${session}
${form}
<p class="note">This server never places an order and never books a delivery slot.</p>
</body>`;
}

/** Tri-state on purpose: "could not be determined" must not present as "not signed in". */
type SessionState = "signedIn" | "signedOut" | "unknown";

function describeSession(state: SessionState): string {
  switch (state) {
    case "signedIn":
      return "<p><strong>Woolworths session: signed in.</strong> Every tool works.</p>";
    case "signedOut":
      return (
        "<p><strong>Woolworths session: not signed in.</strong> Catalogue search still works; " +
        "cart, orders and account tools will not, until the session is renewed by running " +
        "<code>npm run login -- --server &lt;this server&gt;/mcp/&lt;path token&gt;</code> on a " +
        "machine with a browser.</p>"
      );
    case "unknown":
      return (
        "<p><strong>Woolworths session: could not be checked.</strong> The site did not answer, " +
        "so whether the account tools work is unknown — not that they do not.</p>"
      );
  }
}

function errorPage(message: string): string {
  return `${PAGE_HEAD}<title>Authorisation refused</title><body>
<h1>Authorisation refused</h1><p>${escapeHtml(message)}</p></body>`;
}
