import { CookieJar } from "tough-cookie";

export const SITE_ORIGIN = "https://www.woolworths.co.nz";

/** Trailing slash is load-bearing: `new URL("products", API_BASE)` must keep the `/api/v1/` prefix. */
export const API_BASE = new URL("/api/v1/", SITE_ORIGIN);

/**
 * The edge (Akamai) answers 400 to anything that does not look like a browser, so the UA is
 * part of the protocol rather than decoration. See DESIGN.md, "Session requirements".
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Sent on every API call alongside the UA and cookie jar; without it the API answers 400. */
export const API_REQUEST_HEADER = "x-requested-with";
export const API_REQUEST_HEADER_VALUE = "OnlineShopping.WebApp";

const MAX_REDIRECTS = 5;
/** The sign-in chain crosses www -> auth -> iam -> www and needs far more hops than an API call. */
export const LOGIN_CHAIN_REDIRECTS = 15;
const DEFAULT_TIMEOUT_MS = 20_000;

export class SessionError extends Error {}

export interface SessionOptions {
  readonly timeoutMs?: number;
}

/** A cookie captured from a browser: the raw Set-Cookie string and the URL it belongs to. */
export interface ImportedCookie {
  readonly setCookie: string;
  readonly url: string;
}

/**
 * One anonymous shopper session: a cookie jar plus the bootstrap that fills it.
 *
 * Redirects are followed by hand because the edge sets session cookies on intermediate hops,
 * and `fetch`'s automatic redirect handling would discard them.
 */
export class Session {
  private readonly jar = new CookieJar();
  private readonly timeoutMs: number;
  private inFlightBootstrap: Promise<void> | undefined;

  constructor(options: SessionOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Fills the cookie jar from the homepage. Concurrent callers share a single bootstrap. */
  async bootstrap(): Promise<void> {
    const existing = this.inFlightBootstrap;
    if (existing !== undefined) return existing;

    const started = this.loadHomepage().finally(() => {
      this.inFlightBootstrap = undefined;
    });
    this.inFlightBootstrap = started;
    return started;
  }

  /** Discards the current cookies and bootstraps again, for use after the edge rejects a call. */
  async reset(): Promise<void> {
    await this.jar.removeAllCookies();
    await this.bootstrap();
  }

  /** True once the jar holds at least one cookie for the site. */
  async hasCookies(): Promise<boolean> {
    const cookies = await this.jar.getCookies(SITE_ORIGIN);
    return cookies.length > 0;
  }

  /**
   * Loads cookies captured from a browser sign-in; each entry is a Set-Cookie string and its URL.
   * Auth0 challenges non-browser clients with Turnstile, so sign-in cannot happen here.
   */
  async importCookies(cookies: readonly ImportedCookie[]): Promise<number> {
    let accepted = 0;
    for (const { setCookie, url } of cookies) {
      try {
        await this.jar.setCookie(setCookie, url);
        accepted += 1;
      } catch (error: unknown) {
        console.error(`[woolies-mcp] rejected an imported cookie for ${url}:`, error);
      }
    }
    return accepted;
  }

  /** The jar's contents, for persisting a signed-in session across restarts. */
  async exportCookies(): Promise<readonly ImportedCookie[]> {
    const serialised = await this.jar.serialize();
    return serialised.cookies.map((cookie) => {
      const domain = typeof cookie.domain === "string" ? cookie.domain : "";
      const path = typeof cookie.path === "string" ? cookie.path : "/";
      const attributes = [
        `${cookie.key}=${cookie.value ?? ""}`,
        `Domain=${domain}`,
        `Path=${path}`,
      ];
      if (typeof cookie.expires === "string") attributes.push(`Expires=${cookie.expires}`);
      if (cookie.httpOnly === true) attributes.push("HttpOnly");
      if (cookie.secure === true) attributes.push("Secure");
      return {
        setCookie: attributes.join("; "),
        url: `https://${domain.replace(/^\./, "")}${path}`,
      };
    });
  }

  /** When the site session cookie expires, or undefined if the jar holds no dated session cookie. */
  async sessionExpiry(): Promise<Date | undefined> {
    const cookies = await this.jar.getCookies(SITE_ORIGIN);
    const dated = cookies
      .filter((cookie) => cookie.key.startsWith("cw-"))
      .map((cookie) => cookie.expires)
      .filter((expires): expires is Date => expires instanceof Date);
    if (dated.length === 0) return undefined;
    return dated.reduce((soonest, next) => (next < soonest ? next : soonest));
  }

  /** Issues a request with the jar applied, storing any cookies the response sets. */
  async fetch(url: URL, init: RequestInit = {}, maxRedirects = MAX_REDIRECTS): Promise<Response> {
    let target = url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await this.sendOnce(target, hop === 0 ? init : { method: "GET" });
      const location = response.headers.get("location");
      if (!isRedirect(response.status) || location === null) return response;
      target = new URL(location, target);
    }
    throw new SessionError(`More than ${maxRedirects} redirects starting at ${url.href}`);
  }

  private async loadHomepage(): Promise<void> {
    const response = await this.fetch(new URL(SITE_ORIGIN), { headers: { accept: "text/html" } });
    if (!response.ok) {
      throw new SessionError(`Bootstrap of ${SITE_ORIGIN} failed with HTTP ${response.status}`);
    }
    // Drain the body so the socket is released; the HTML itself is not used.
    await response.arrayBuffer();
    if (!(await this.hasCookies())) {
      throw new SessionError(`Bootstrap of ${SITE_ORIGIN} set no cookies`);
    }
  }

  private async sendOnce(url: URL, init: RequestInit): Promise<Response> {
    const cookie = await this.jar.getCookieString(url.href);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: mergeHeaders(cookie, init.headers),
    });
    await this.absorbCookies(url, response);
    return response;
  }

  private async absorbCookies(url: URL, response: Response): Promise<void> {
    for (const setCookie of response.headers.getSetCookie()) {
      try {
        await this.jar.setCookie(setCookie, url.href);
      } catch (error: unknown) {
        // A cookie the jar rejects (bad domain, malformed attributes) is not fatal: the session
        // survives on the rest. Record it so a broken session is diagnosable.
        console.error(`[woolies-mcp] ignoring unusable Set-Cookie from ${url.host}:`, error);
      }
    }
  }
}

/**
 * `HeadersInit` is also `Headers` or an entry array, both of which spread into an object as
 * nothing useful, so the caller's headers are merged through `Headers` and win over the defaults.
 */
function mergeHeaders(cookie: string, overrides: RequestInit["headers"]): Headers {
  const headers = new Headers({
    "user-agent": BROWSER_USER_AGENT,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-NZ,en;q=0.9",
  });
  if (cookie !== "") headers.set("cookie", cookie);
  for (const [key, value] of new Headers(overrides).entries()) headers.set(key, value);
  return headers;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
