/**
 * Offline gate for the built-in authorisation server.
 *
 * Runs the real router from src/http.ts against a real HTTP server on loopback and drives the
 * whole flow with fetch: discovery, registration, consent, PKCE, refusal, rotation and the
 * bearer guard. Nothing here reaches Woolworths — the upstream session state is a switch this
 * script sets, which is the only way to exercise both sides of the refresh refusal.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readHttpConfig } from "../src/config.js";
import { createOAuth, createRequestHandler } from "../src/http.js";
import { pkceChallenge } from "../src/oauth/endpoints.js";
import { SessionStore } from "../src/session-store.js";
import { createWoolworthsApi } from "../src/server.js";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const PATH_TOKEN = "0123456789abcdef0123456789abcdef";
const PASSPHRASE = "correct-horse-battery";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Flipped by the script; stands in for the Woolworths session without contacting the site. */
let sessionUsable = true;

let handler: ReturnType<typeof createRequestHandler> | undefined;
const server: Server = createServer((req, res) => {
  if (handler === undefined) {
    res.writeHead(503).end();
    return;
  }
  handler(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

const statePath = join(await mkdtemp(join(tmpdir(), "woolies-oauth-")), "state.json");
const config = readHttpConfig({
  MCP_PATH_TOKEN: PATH_TOKEN,
  MCP_PUBLIC_URL: base,
  MCP_AUTH_PASSPHRASE: PASSPHRASE,
  MCP_OAUTH_FILE: statePath,
  WOOLIES_SESSION_FILE: "",
});
const oauth = await createOAuth(config.oauth, () => Promise.resolve(sessionUsable));
handler = createRequestHandler({
  api: createWoolworthsApi(),
  sessionStore: new SessionStore(undefined),
  oauth,
  pathToken: PATH_TOKEN,
});

const noRedirect = { redirect: "manual" } as const;

console.log("\nDiscovery");
{
  const bare = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const body = (await bare.json()) as { resource: string; authorization_servers: string[] };
  check(
    "protected-resource names this server",
    bare.status === 200 &&
      body.resource === `${base}/mcp` &&
      body.authorization_servers[0] === base,
    JSON.stringify(body),
  );

  const suffixed = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  check(
    "path-suffixed well-known answers the same",
    suffixed.status === 200 && (await suffixed.text()) === JSON.stringify(body),
    `HTTP ${suffixed.status}`,
  );

  const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const meta = (await as.json()) as Record<string, string[] | string>;
  check(
    "authorization-server offers S256 only, endpoints absolute",
    JSON.stringify(meta["code_challenge_methods_supported"]) === '["S256"]' &&
      meta["authorization_endpoint"] === `${base}/authorize` &&
      meta["token_endpoint"] === `${base}/token`,
    JSON.stringify(meta["code_challenge_methods_supported"]),
  );
}

console.log("\nThe guard, before any token exists");
{
  const bare = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  const challenge = bare.headers.get("www-authenticate") ?? "";
  check(
    "unauthenticated /mcp answers 401 with a re-auth challenge",
    bare.status === 401 &&
      challenge.includes('error="invalid_token"') &&
      challenge.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource"`),
    `HTTP ${bare.status} ${challenge}`,
  );

  const legacy = await fetch(`${base}/mcp/${PATH_TOKEN}`, { method: "POST", body: "{}" });
  check(
    "the token path is closed while OAuth is on",
    legacy.status === 404,
    `HTTP ${legacy.status}`,
  );

  const junk = await fetch(`${base}/mcp`, {
    method: "POST",
    body: "{}",
    headers: { authorization: "Bearer not-a-real-token" },
  });
  check("an unknown bearer token is refused", junk.status === 401, `HTTP ${junk.status}`);
}

console.log("\nRegistration");
let clientId = "";
{
  const refused = await fetch(`${base}/register`, {
    method: "POST",
    body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
  });
  check(
    "a non-loopback http redirect_uri is refused",
    refused.status === 400,
    `HTTP ${refused.status}`,
  );

  const empty = await fetch(`${base}/register`, {
    method: "POST",
    body: JSON.stringify({ client_name: "no uris" }),
  });
  check(
    "registration without redirect_uris is refused",
    empty.status === 400,
    `HTTP ${empty.status}`,
  );

  const created = await fetch(`${base}/register`, {
    method: "POST",
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
  });
  const body = (await created.json()) as { client_id: string };
  clientId = body.client_id;
  check(
    "a client registers and is given an id",
    created.status === 201 && clientId.length > 0,
    `HTTP ${created.status}`,
  );
}

function authorizeUrl(overrides: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    state: "state-123",
    resource: `${base}/mcp`,
    ...overrides,
  });
  return `${base}/authorize?${params.toString()}`;
}

console.log("\nAuthorisation requests this server refuses");
{
  const noClient = await fetch(`${base}/authorize?response_type=code`, noRedirect);
  check(
    "a request with no client_id gets a page, not a redirect",
    noClient.status === 400,
    `HTTP ${noClient.status}`,
  );

  const unknownRedirect = await fetch(
    authorizeUrl({ redirect_uri: "https://elsewhere.example/cb", code_challenge: "x" }),
    noRedirect,
  );
  check(
    "an unregistered redirect_uri is never redirected to",
    unknownRedirect.status === 400 && unknownRedirect.headers.get("location") === null,
    `HTTP ${unknownRedirect.status}`,
  );

  const plain = await fetch(
    authorizeUrl({ code_challenge_method: "plain", code_challenge: "x" }),
    noRedirect,
  );
  const plainTarget = new URL(plain.headers.get("location") ?? "http://none");
  check(
    "plain PKCE is bounced back to the client as an error",
    plain.status === 302 &&
      plainTarget.searchParams.get("error") === "invalid_request" &&
      plainTarget.searchParams.get("state") === "state-123",
    plainTarget.search,
  );

  const wrongResource = await fetch(
    authorizeUrl({ resource: "https://someone-elses-nas.example/mcp", code_challenge: "x" }),
    noRedirect,
  );
  const target = new URL(wrongResource.headers.get("location") ?? "http://none");
  check(
    "a request for another resource is refused",
    target.searchParams.get("error") === "invalid_target",
    target.search,
  );
}

/** Runs a full browser round trip and returns the code, or the status that stopped it. */
async function consent(
  verifier: string,
  passphrase: string,
): Promise<{
  readonly code: string | undefined;
  readonly state: string | undefined;
  readonly status: number;
  readonly html: string;
}> {
  const page = await fetch(authorizeUrl({ code_challenge: pkceChallenge(verifier) }), noRedirect);
  const body = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(body)?.[1];
  if (requestId === undefined) {
    return { code: undefined, state: undefined, status: page.status, html: body };
  }

  const posted = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // No state is posted: the server holds the client's state, so a tampered form cannot swap it.
    body: new URLSearchParams({ request_id: requestId, passphrase }).toString(),
    redirect: "manual",
  });
  const location = posted.headers.get("location");
  const returned = location === null ? undefined : new URL(location).searchParams;
  return {
    code: returned?.get("code") ?? undefined,
    state: returned?.get("state") ?? undefined,
    status: posted.status,
    html: body,
  };
}

console.log("\nConsent");
let accessToken: string;
let refreshToken: string;
const verifier = randomBytes(32).toString("base64url");
{
  sessionUsable = true;
  const wrong = await consent(verifier, "not-the-passphrase");
  check(
    "the wrong passphrase issues no code",
    wrong.status === 401 && wrong.code === undefined,
    `HTTP ${wrong.status}`,
  );
  check(
    "the consent page reports a signed-in session",
    wrong.html.includes("Woolworths session: signed in"),
    "page states the session state",
  );

  sessionUsable = false;
  const signedOut = await consent(verifier, "not-the-passphrase");
  check(
    "the consent page reports a dead session without blocking approval",
    signedOut.html.includes("Woolworths session: not signed in") &&
      signedOut.html.includes("npm run login"),
    "page names the remedy",
  );
  sessionUsable = true;

  const granted = await consent(verifier, PASSPHRASE);
  check(
    "the right passphrase redirects with a code and the client's own state",
    granted.status === 302 && granted.code !== undefined && granted.state === "state-123",
    `HTTP ${granted.status}, state ${granted.state ?? "(none)"}`,
  );

  const exchange = async (
    body: Readonly<Record<string, string>>,
  ): Promise<{ status: number; json: Record<string, string> }> => {
    const response = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return { status: response.status, json: (await response.json()) as Record<string, string> };
  };

  const badVerifier = await exchange({
    grant_type: "authorization_code",
    code: granted.code ?? "",
    code_verifier: randomBytes(32).toString("base64url"),
    client_id: clientId,
    redirect_uri: REDIRECT,
  });
  check(
    "a code_verifier that does not match the challenge is refused",
    badVerifier.status === 400 && badVerifier.json["error"] === "invalid_grant",
    JSON.stringify(badVerifier.json),
  );

  // The failed attempt above spent the code: single use is not conditional on succeeding.
  const spent = await exchange({
    grant_type: "authorization_code",
    code: granted.code ?? "",
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  });
  check(
    "a code is single use, even after a failed exchange",
    spent.json["error"] === "invalid_grant",
    JSON.stringify(spent.json),
  );

  const second = await consent(verifier, PASSPHRASE);
  const issued = await exchange({
    grant_type: "authorization_code",
    code: second.code ?? "",
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  });
  accessToken = issued.json["access_token"] ?? "";
  refreshToken = issued.json["refresh_token"] ?? "";
  check(
    "a matching verifier yields an access and a refresh token",
    issued.status === 200 && accessToken.length > 0 && refreshToken.length > 0,
    `token_type ${issued.json["token_type"] ?? "(missing)"}, expires_in ${issued.json["expires_in"] ?? "(missing)"}`,
  );
}

console.log("\nThe token, against the real MCP endpoint");
{
  const initialize = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oauth-check", version: "0" },
      },
    }),
  });
  const text = await initialize.text();
  check(
    "an authorised initialize reaches the MCP server",
    initialize.status === 200 && text.includes("serverInfo"),
    `HTTP ${initialize.status}`,
  );
}

let rotatedRefreshToken: string;
console.log("\nRefresh, and the refusal that opens a browser");
{
  const post = async (body: Readonly<Record<string, string>>): Promise<Record<string, string>> => {
    const response = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return (await response.json()) as Record<string, string>;
  };

  sessionUsable = false;
  const refused = await post({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  check(
    "a dead Woolworths session refuses the refresh, so the client must ask the person",
    refused["error"] === "invalid_grant" &&
      (refused["error_description"] ?? "").includes("no longer signed in"),
    JSON.stringify(refused),
  );

  sessionUsable = true;
  const renewed = await post({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const rotated = renewed["refresh_token"] ?? "";
  rotatedRefreshToken = rotated;
  check(
    "a live session renews, and the refresh token rotates",
    (renewed["access_token"] ?? "").length > 0 && rotated !== refreshToken,
    "new access and refresh tokens issued",
  );

  const replayed = await post({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  check(
    "the spent refresh token is refused",
    replayed["error"] === "invalid_grant",
    JSON.stringify(replayed),
  );
}

console.log("\nRevocation");
{
  await fetch(`${base}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken }).toString(),
  });
  const after = await fetch(`${base}/mcp`, {
    method: "POST",
    body: "{}",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  check("a revoked access token stops working", after.status === 401, `HTTP ${after.status}`);
}

console.log("\nAcross a restart");
{
  // A second authorisation server reading the same file, as a restarted process would.
  const restarted = await createOAuth(config.oauth, () => Promise.resolve(true));
  handler = createRequestHandler({
    api: createWoolworthsApi(),
    sessionStore: new SessionStore(undefined),
    oauth: restarted,
    pathToken: PATH_TOKEN,
  });

  const page = await fetch(authorizeUrl({ code_challenge: pkceChallenge(verifier) }), noRedirect);
  const body = await page.text();
  check(
    "the registered client survives a restart",
    page.status === 200 && body.includes('name="request_id"'),
    `HTTP ${page.status}`,
  );

  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rotatedRefreshToken,
      client_id: clientId,
    }).toString(),
  });
  const renewed = (await response.json()) as Record<string, string>;
  check(
    "a refresh token survives a restart, so no browser is needed to resume",
    (renewed["access_token"] ?? "").length > 0,
    JSON.stringify(Object.keys(renewed)),
  );
}

console.log("\nLockout");
{
  const attempts: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    attempts.push((await consent(verifier, "wrong-every-time")).status);
  }
  // The lock is applied on the fifth failure, so the fifth is still answered 401 and the sixth
  // request never reaches the passphrase: the page renders without a form to submit.
  const locked = await consent(verifier, PASSPHRASE);
  check(
    "five wrong passphrases lock the page against the right one",
    attempts.every((status) => status === 401) &&
      locked.code === undefined &&
      locked.html.includes("Too many failed attempts"),
    `attempts ${attempts.join(",")} then a page offering no form`,
  );
}

server.close();

console.log(
  `\n${failures.length === 0 ? "All OAuth checks passed." : `${failures.length} failed:`}`,
);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
