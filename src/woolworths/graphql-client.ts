import { ClientError, GraphQLClient, type RequestOptions } from "graphql-request";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { NotSignedInError } from "./auth.js";
import { SITE_ORIGIN, type Session } from "./session.js";
import type { Throttle } from "./throttle.js";

export const GRAPHQL_PATH = "/api/graphql";
export const GRAPHQL_ENDPOINT = new URL(GRAPHQL_PATH, SITE_ORIGIN).href;

/**
 * The Next.js pages exchange the sign-in cookies for `__session__0` / `__session__1`, and
 * `/api/graphql` authenticates on those. Loading any Next.js page mints them; `/cart` is the one
 * observed doing it.
 */
export const SESSION_UPGRADE_PATH = "/cart";
const SESSION_COOKIE_PREFIX = "__session__";

/** `extensions.code` on the error the site returns for a field guests may not select. */
const GUEST_BANNED_CODE = "BANNED_OPERATION";

/**
 * A GraphQL failure, already converted from the site's HTTP 200. Never carries data: a response
 * with errors is a failure whole, because a partially resolved payload is indistinguishable from
 * a complete one once the errors are dropped.
 */
export class GraphQlError extends Error {
  readonly operation: string;
  readonly codes: readonly string[];

  constructor(
    message: string,
    operation: string,
    codes: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GraphQlError";
    this.operation = operation;
    this.codes = codes;
  }
}

export interface GraphQlTransport {
  /** Sends one operation and returns its data. Any failure throws; nothing is returned partly. */
  send<TResult, TVariables extends object>(
    operation: string,
    document: TypedDocumentNode<TResult, TVariables>,
    variables: TVariables,
  ): Promise<TResult>;

  /** Mints the Next.js session cookies `/api/graphql` authenticates on. */
  upgradeSession(): Promise<void>;
}

/**
 * Builds the client for one endpoint.
 *
 * `graphql-request` throws `ClientError` whenever the response carries an `errors` array, so the
 * conversion from "HTTP 200 that means failure" to an exception is the library's behaviour rather
 * than a convention every call site has to remember. Nothing in this repo reads a GraphQL body
 * any other way.
 */
export function createGraphQlClient(fetcher: typeof fetch): GraphQLClient {
  return new GraphQLClient(GRAPHQL_ENDPOINT, {
    fetch: fetcher,
    headers: {
      accept: "application/graphql-response+json,application/json;q=0.9",
      origin: SITE_ORIGIN,
      referer: `${SITE_ORIGIN}${SESSION_UPGRADE_PATH}`,
    },
  });
}

/**
 * Re-raises a `ClientError` as this codebase's own failures.
 *
 * An error naming a guest-banned field becomes `NotSignedInError`, so a session the site no longer
 * recognises produces the same `npm run login` handover the REST 401 path produces. Everything
 * else becomes a `GraphQlError` carrying the site's codes.
 */
export function asGraphQlFailure(operation: string, error: unknown): Error {
  if (!(error instanceof ClientError)) {
    return error instanceof Error
      ? error
      : new GraphQlError(String(error), operation, [], { cause: error });
  }

  // A `ClientError` is not always a GraphQL failure: an HTTP error carries no `errors` at all,
  // and reporting "0 errors" would say nothing about what went wrong.
  const errors = error.response.errors ?? [];
  if (errors.length === 0) {
    const status = error.response.status;
    const body = typeof error.response.body === "string" ? error.response.body : "";
    return new GraphQlError(
      `${operation} failed with HTTP ${status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`,
      operation,
      [],
      { cause: error },
    );
  }

  const codes = errors.map((entry) => {
    // The library types `extensions` as always present; the wire does not guarantee it, and an
    // error whose code cannot be read must still be reported rather than crash the reporting.
    const extensions: unknown = entry.extensions;
    if (typeof extensions !== "object" || extensions === null) return "<no code>";
    const code = (extensions as Record<string, unknown>)["code"];
    return typeof code === "string" ? code : "<no code>";
  });
  if (codes.includes(GUEST_BANNED_CODE)) return new NotSignedInError({ cause: error });

  const messages = errors.map((entry) => entry.message);
  return new GraphQlError(
    `${operation} returned ${errors.length} GraphQL error(s): ${messages.join("; ")} [${codes.join(", ")}]`,
    operation,
    codes,
    { cause: error },
  );
}

/**
 * A transport whose requests are issued by a caller-supplied `fetch`.
 *
 * The fetch is a parameter because the same operations are sent from three places that reach the
 * site differently: the server's cookie jar, a real browser's request context during
 * `npm run login`, and a canned responder in the offline checks. All three go through the same
 * client, so all three convert an `errors` array to an exception identically.
 */
export class FetchGraphQlTransport implements GraphQlTransport {
  protected readonly client: GraphQLClient;

  constructor(fetcher: typeof fetch) {
    this.client = createGraphQlClient(fetcher);
  }

  /** No session to upgrade; the caller's fetch decides what credentials a request carries. */
  upgradeSession(): Promise<void> {
    return Promise.resolve();
  }

  async send<TResult, TVariables extends object>(
    operation: string,
    document: TypedDocumentNode<TResult, TVariables>,
    variables: TVariables,
  ): Promise<TResult> {
    // `RequestOptions` is a conditional type on the variables, and TypeScript cannot evaluate it
    // while they are still a type parameter, so it rejects even the shape the overload accepts.
    // Cast in one place, here; every call site keeps its real types. Same reason as the SDK casts
    // in http.ts (DESIGN.md, "Stack and deployment").
    const options = {
      document,
      variables,
      // The browser tags each call two ways; the header here, the query parameter in the fetch.
      requestHeaders: { "wnzx-operation-name": operation },
    } as unknown as RequestOptions<TVariables, TResult>;

    try {
      return await this.client.request<TResult, TVariables>(options);
    } catch (error: unknown) {
      throw asGraphQlFailure(operation, error);
    }
  }
}

/**
 * `/api/graphql` over the shared shopper session.
 *
 * The session upgrade is the transport's job because `/api/graphql` does not authenticate on the
 * sign-in cookies alone: without `__session__0` / `__session__1` the site serves a *guest*, at
 * HTTP 200, with no error.
 */
export class SessionGraphQlTransport extends FetchGraphQlTransport {
  private readonly session: Session;
  private readonly throttle: Throttle;

  constructor(session: Session, throttle: Throttle) {
    // One jar and one request budget for the whole server, so it stays one shopper making one
    // request at a time.
    super((input, init) => sendThroughSession(session, throttle, input, init));
    this.session = session;
    this.throttle = throttle;
  }

  override async upgradeSession(): Promise<void> {
    const response = await this.throttle.run(() =>
      this.session.fetch(new URL(SESSION_UPGRADE_PATH, SITE_ORIGIN), {
        headers: { accept: "text/html" },
      }),
    );
    // Drain the body so the socket is released; the HTML itself is not used.
    await response.arrayBuffer();
    if (!response.ok) {
      throw new GraphQlError(
        `Minting the GraphQL session at ${SESSION_UPGRADE_PATH} failed with HTTP ${response.status}.`,
        "sessionUpgrade",
        [],
      );
    }
  }

  /** Whether the jar holds the cookies `/api/graphql` authenticates on. */
  async hasSessionCookies(): Promise<boolean> {
    const cookies = await this.session.cookieNames();
    return cookies.some((name) => name.startsWith(SESSION_COOKIE_PREFIX));
  }

  /**
   * Sends an operation, minting the Next.js session first and re-minting it once if the site says
   * the one we hold has expired.
   *
   * `__session__0` / `__session__1` are short-lived and roll on every response, so a session that
   * worked a minute ago can be refused. Minting only when absent left the server dead until a
   * restart; the site states the condition plainly (HTTP 401, `session_expired`), so it is
   * recovered from once and reported if it recurs.
   */
  override async send<TResult, TVariables extends object>(
    operation: string,
    document: TypedDocumentNode<TResult, TVariables>,
    variables: TVariables,
  ): Promise<TResult> {
    if (!(await this.hasSessionCookies())) await this.upgradeSession();
    try {
      return await super.send(operation, document, variables);
    } catch (error: unknown) {
      if (!isExpiredSession(error)) throw error;
      console.error(`[woolies-mcp] ${operation}: the GraphQL session expired; re-minting it`);
      await this.upgradeSession();
      try {
        return await super.send(operation, document, variables);
      } catch (retried: unknown) {
        // Re-minting from a dead sign-in produces another dead session. That is not a transport
        // failure to report raw: it is the handover, same as a guest response.
        if (isExpiredSession(retried)) throw new NotSignedInError({ cause: retried });
        throw retried;
      }
    }
  }
}

function sendThroughSession(
  session: Session,
  throttle: Throttle,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  // The site routes on `op-name`; graphql-request posts to the bare endpoint.
  const operation = readOperationName(init?.body);
  if (operation !== undefined) url.searchParams.set("op-name", operation);
  return throttle.run(() => session.fetch(url, init ?? {}));
}

/**
 * Whether the site said the Next.js session has expired, as opposed to any other failure.
 *
 * Matched on the site's own words rather than the status alone: a 401 from a different cause must
 * not send this into a re-mint loop.
 */
function isExpiredSession(error: unknown): boolean {
  return error instanceof GraphQlError && error.message.includes(EXPIRED_SESSION);
}

/** The body the site returns when `__session__*` is no longer accepted. */
const EXPIRED_SESSION = "session_expired";

/** The operation name out of the request body, so the URL can carry it as the site's UI does. */
export function readOperationName(body: RequestInit["body"]): string | undefined {
  if (typeof body !== "string") return undefined;
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const name = (parsed as Record<string, unknown>)["operationName"];
  return typeof name === "string" && name !== "" ? name : undefined;
}
