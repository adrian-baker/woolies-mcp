/**
 * Sign-in happens out of band, in a real browser, via `npm run login`.
 *
 * Auth0 serves a Cloudflare Turnstile challenge to clients that do not look like browsers, so
 * posting an email and password from here does not work: it fails the challenge and each attempt
 * counts against the real account. A person signing in themselves is both the legitimate path and
 * the one that is not challenged. The resulting cookies are handed to the server and the password
 * never reaches this process.
 *
 * This module therefore holds no credentials and makes no network calls. It exists so the account
 * tools can explain an anonymous session instead of failing opaquely.
 */

export type SignInOutcome =
  | { readonly kind: "alreadySignedIn" }
  | { readonly kind: "handoverRequired"; readonly detail: string };

const HANDOVER_DETAIL =
  "This session is not signed in. Sign in by running `npm run login` where the server is " +
  "deployed: it opens a real browser at the Woolworths login page, waits for you to sign in, " +
  "and hands the resulting session to the server. The server never sees your password. " +
  "Credentials cannot be supplied here — Auth0 challenges non-browser sign-ins, and attempts " +
  "count against the account. The catalogue tools need no account and are unaffected.";

export class Authenticator {
  /** Reports the session state. Makes no request, so no account is ever touched. */
  signIn(alreadySignedIn: boolean): Promise<SignInOutcome> {
    return Promise.resolve(
      alreadySignedIn
        ? { kind: "alreadySignedIn" }
        : { kind: "handoverRequired", detail: HANDOVER_DETAIL },
    );
  }
}

/** Raised by account operations when the session is anonymous. */
export class NotSignedInError extends Error {
  constructor(options?: ErrorOptions) {
    super(HANDOVER_DETAIL, options);
    this.name = "NotSignedInError";
  }
}
