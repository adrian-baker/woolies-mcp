import { API_BASE, API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE, Session } from "./session.js";
import { delay, Throttle } from "./throttle.js";

/** An array repeats the key, which is how `dasFilter` stacks department, aisle and shelf. */
export type QueryValue = string | number | boolean | readonly string[];

export class WoolworthsApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WoolworthsApiError";
    this.status = status;
    this.url = url;
  }
}

export interface ClientOptions {
  readonly minRequestIntervalMs?: number;
  readonly retryBackoffMs?: number;
}

const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_500;

/** Statuses the edge returns when it no longer accepts the session (DESIGN.md). */
function isSessionRejection(status: number): boolean {
  return status === 400 || status === 403;
}

/** Statuses worth one more try without touching the session. */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The transport for `/api/v1`: throttled, cookie-bearing, and self-healing once.
 *
 * Recovery policy — at most one extra attempt per call, either a re-bootstrap (session
 * rejection) or a backoff (transient failure). Two attempts is the whole budget, so a
 * genuinely broken upstream is reported rather than hammered.
 */
export class WoolworthsClient {
  private readonly session: Session;
  private readonly throttle: Throttle;
  private readonly retryBackoffMs: number;

  /** Exposed so a browser-captured session can be handed to the jar; see Session.importCookies. */
  get shopperSession(): Session {
    return this.session;
  }

  constructor(session: Session, options: ClientOptions = {}) {
    this.session = session;
    this.throttle = new Throttle(options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS);
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  get(path: string, query: Readonly<Record<string, QueryValue>> = {}): Promise<unknown> {
    return this.requestJson("GET", buildUrl(path, query));
  }

  put(path: string): Promise<unknown> {
    return this.requestJson("PUT", buildUrl(path, {}));
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.requestJson("POST", buildUrl(path, {}), body);
  }

  delete(path: string): Promise<unknown> {
    return this.requestJson("DELETE", buildUrl(path, {}));
  }

  private async requestJson(method: string, url: URL, body?: unknown): Promise<unknown> {
    if (!(await this.session.hasCookies())) await this.session.bootstrap();

    const first = await this.attempt(method, url, body);
    if (first.ok) return parseJson(first, url);

    if (isSessionRejection(first.status)) {
      console.error(
        `[woolies-mcp] HTTP ${first.status} from ${url.pathname}; re-bootstrapping the session`,
      );
      await this.session.refreshBootstrap();
    } else if (isTransient(first.status)) {
      console.error(
        `[woolies-mcp] HTTP ${first.status} from ${url.pathname}; retrying in ${this.retryBackoffMs}ms`,
      );
      await delay(this.retryBackoffMs);
    } else {
      throw failure(first, url);
    }

    const second = await this.attempt(method, url, body);
    if (second.ok) return parseJson(second, url);
    throw failure(second, url);
  }

  private attempt(method: string, url: URL, body: unknown): Promise<Attempt> {
    return this.throttle.run(async () => {
      const response = await this.session.fetch(url, {
        method,
        headers: {
          [API_REQUEST_HEADER]: API_REQUEST_HEADER_VALUE,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { ok: response.ok, status: response.status, body: await response.text() };
    });
  }
}

interface Attempt {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

function buildUrl(path: string, query: Readonly<Record<string, QueryValue>>): URL {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(query)) {
    // Narrowing on typeof keeps the element type; Array.isArray widens a readonly array to any[].
    if (typeof value === "object") {
      for (const member of value) url.searchParams.append(key, member);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function parseJson(attempt: Attempt, url: URL): unknown {
  try {
    return JSON.parse(attempt.body);
  } catch (error: unknown) {
    throw new WoolworthsApiError(
      `${url.pathname} returned HTTP ${attempt.status} with a body that is not JSON`,
      attempt.status,
      url.href,
      { cause: error },
    );
  }
}

function failure(attempt: Attempt, url: URL): WoolworthsApiError {
  return new WoolworthsApiError(
    `${url.pathname}${url.search} returned HTTP ${attempt.status}: ${attempt.body.slice(0, 300)}`,
    attempt.status,
    url.href,
  );
}
