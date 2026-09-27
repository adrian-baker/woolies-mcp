import { Cookie, CookieJar } from "tough-cookie";

export const SITE_ORIGIN = "https://www.woolworths.co.nz";

/**
 * The edge (Akamai) answers 400 to anything that does not look like a browser, so the UA is part
 * of the protocol rather than decoration.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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
  private jar = new CookieJar();
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

  /**
   * Re-runs the bootstrap after the site rejects a call, keeping every cookie.
   *
   * The jar is kept: the `cw-*`, Keycloak and Auth0 cookies are the sign-in and nothing reloads
   * them afterwards, so discarding them here is a permanent sign-out. The edge cookies the
   * bootstrap needs are reissued by Set-Cookie; on a live authenticated call only
   * `akavpau_vpwww` was observed rotating.
   */
  async refreshBootstrap(): Promise<void> {
    await this.bootstrap();
  }

  /** True once the jar holds at least one cookie for the site. */
  async hasCookies(): Promise<boolean> {
    const cookies = await this.jar.getCookies(SITE_ORIGIN);
    return cookies.length > 0;
  }

  /** The names of the cookies the jar holds for the site. */
  async cookieNames(): Promise<readonly string[]> {
    const cookies = await this.jar.getCookies(SITE_ORIGIN);
    return cookies.map((cookie) => cookie.key);
  }

  /** Loads cookies from a stored or handed-over session; each is a Set-Cookie string and its URL. */
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

  /**
   * Every woolworths.co.nz cookie the jar holds, as Set-Cookie strings `importCookies` accepts, so
   * a session the server signed in itself can be stored and restored like a handed-over one.
   */
  async exportCookies(): Promise<readonly ImportedCookie[]> {
    const serialized = await this.jar.serialize();
    const exported: ImportedCookie[] = [];
    for (const json of serialized.cookies) {
      const cookie = Cookie.fromJSON(json);
      const domain = cookie?.domain;
      if (cookie === undefined || !domain?.endsWith("woolworths.co.nz")) continue;
      exported.push({
        setCookie: cookie.toString(),
        url: `https://${domain}${cookie.path ?? "/"}`,
      });
    }
    return exported;
  }

  /** Issues a request with the jar applied, storing any cookies the response sets. */
  async fetch(url: URL, init: RequestInit = {}, maxRedirects = MAX_REDIRECTS): Promise<Response> {
    let target = url;
    let request = init;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await this.sendOnce(target, request);
      const location = response.headers.get("location");
      if (!isRedirect(response.status) || location === null) return response;
      const next = new URL(location, target);
      request = followRedirect(request, response.status, target, next);
      target = next;
    }
    throw new SessionError(`More than ${maxRedirects} redirects starting at ${url.href}`);
  }

  /**
   * Takes over another session's cookies, replacing every one this session held. A sign-in is
   * performed on a fresh session and adopted only once proven, so a failed one never touches the
   * shared jar and a working one carries nothing over from the session it replaces.
   */
  adopt(other: Session): void {
    this.jar = other.jar;
  }

  /**
   * One request and no redirect following, for a caller that has to see every hop. Cookies are
   * still absorbed from the response.
   */
  async fetchOnce(url: URL, init: RequestInit = {}): Promise<Response> {
    return this.sendOnce(url, init);
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

  /**
   * Rejections already reported, by host and reason. The site sets a third-party cookie on every
   * request, so logging each one buries the log; the first of each kind is enough to diagnose a
   * broken session, and a new kind still surfaces.
   */
  private readonly reportedCookieRejections = new Set<string>();

  private async absorbCookies(url: URL, response: Response): Promise<void> {
    for (const setCookie of response.headers.getSetCookie()) {
      try {
        await this.jar.setCookie(setCookie, url.href);
      } catch (error: unknown) {
        // A cookie the jar rejects (bad domain, malformed attributes) is not fatal: the session
        // survives on the rest. Recorded so a broken session is diagnosable.
        const reason = error instanceof Error ? error.message : String(error);
        const kind = `${url.host}: ${reason}`;
        if (this.reportedCookieRejections.has(kind)) continue;
        this.reportedCookieRejections.add(kind);
        console.error(
          `[woolies-mcp] ignoring unusable Set-Cookie from ${url.host}: ${reason} ` +
            "(further identical rejections are not repeated)",
        );
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

/**
 * 307 and 308 require the method and body to be preserved; downgrading them to a bare GET drops
 * the body and destroys the session.
 * 301, 302 and 303 are followed as GET, as browsers do. Caller headers cross an origin boundary
 * only when the origin does not change.
 */
function followRedirect(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = from.origin === to.origin ? init.headers : undefined;
  const carried = headers === undefined ? {} : { headers };
  if (status === 307 || status === 308) return { ...init, ...carried };
  return { method: "GET", ...carried };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
