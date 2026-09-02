import type { BrowserContext } from "playwright";

/**
 * A `fetch` backed by a browser's own request context, so a request carries exactly the cookies
 * that browser holds.
 *
 * Only the status, the body and the content type cross over. Copying the upstream response
 * headers wholesale fails: they carry HTTP/2 pseudo-headers and `set-cookie` blobs that undici
 * rejects as header names, and a `content-encoding` that no longer describes the already-decoded
 * body. The browser's request context keeps its own cookies, so nothing here needs them.
 */
export function browserFetch(context: BrowserContext): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await context.request.fetch(url, {
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { data: init.body } : {}),
      failOnStatusCode: false,
    });

    const status = response.status();
    const contentType = response.headers()["content-type"] ?? "application/json";
    // 204 and 304 may not carry a body; constructing one with a body throws.
    const body = status === 204 || status === 304 ? null : await response.body();
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
}
