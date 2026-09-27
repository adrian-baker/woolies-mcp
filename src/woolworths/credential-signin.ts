import { readFile, stat } from "node:fs/promises";
import { LOGIN_CHAIN_REDIRECTS, SITE_ORIGIN, type Session } from "./session.js";

/**
 * Signs the shared session in with a stored email and password, over plain HTTP.
 *
 * The chain is the browser's: the BFF entry point hands over to Keycloak, which brokers to
 * Auth0's two-step form (email, then password), and the answer travels back through Keycloak to
 * the BFF callback on www. Both steps are required: a password posted without the email step is
 * accepted by Auth0 and then refused by Keycloak ("Unexpected error when authenticating with
 * identity provider").
 *
 * The client says what it is. `js-available=false` is sent as the page serves it; nothing here
 * imitates a browser beyond the user agent the edge already requires, and a captcha is a stop,
 * never something to get past.
 */

const AUTH_ORIGIN = "https://auth.woolworths.co.nz";
const START_PATH = "/api/v1.0/bff/initiate-oidc-signin";
const CALLBACK_PATH = "/api/v1.0/bff/login-callback";

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export type SignInResult =
  { readonly kind: "signedIn" } | { readonly kind: "refused"; readonly reason: string };

/** What a sign-in form page offers. Pure, so every refusal the site can state is checkable offline. */
export interface LoginPage {
  readonly state: string | undefined;
  readonly hasPasswordField: boolean;
  readonly hasCaptcha: boolean;
  readonly errors: readonly string[];
}

export function readLoginPage(html: string): LoginPage {
  return {
    state: /<input[^>]*name="state"[^>]*value="([^"]+)"/.exec(html)?.[1],
    hasPasswordField: /<input[^>]*name="password"/.test(html),
    // The widget container, not the script: every page ships the captcha script whether or not
    // a challenge is rendered.
    hasCaptcha: /data-captcha-sitekey\s*=/.test(html),
    errors: [...html.matchAll(/id="error-element-[^"]*"[^>]*>([^<]*)</g)]
      .map((match) => (match[1] ?? "").trim())
      .filter((text) => text !== ""),
  };
}

/** Keycloak's own message on a page it renders instead of redirecting onward. */
export function readKeycloakError(html: string): string | undefined {
  const feedback = /class="[^"]*kc-feedback-text[^"]*"[^>]*>([^<]*)</.exec(html)?.[1]?.trim();
  if (feedback !== undefined && feedback !== "") return feedback;
  return /Unexpected error[^<]*/.exec(html)?.[0].trim();
}

export async function performCredentialSignIn(
  session: Session,
  credentials: Credentials,
): Promise<SignInResult> {
  const start = new URL(START_PATH, SITE_ORIGIN);
  start.searchParams.set("redirectUrl", Buffer.from(`${SITE_ORIGIN}/`).toString("base64"));
  const landing = await follow(session, start, { headers: { accept: "text/html" } });

  // Auth0 still holding a live sign-in skips the form and returns straight to the site.
  if (landing.host === new URL(SITE_ORIGIN).host) return { kind: "signedIn" };

  const identifier = readLoginPage(landing.html);
  const refusal = refusalOn(landing, identifier, "the email page");
  if (refusal !== undefined) return refusal;
  if (identifier.state === undefined) {
    return refused(`the email page at ${landing.path} carried no state to post back`);
  }

  const afterEmail = await follow(
    session,
    new URL(landing.url),
    form({
      state: identifier.state,
      username: credentials.email,
      "js-available": "false",
      "webauthn-available": "false",
      "is-brave": "false",
      "webauthn-platform-available": "false",
      action: "default",
    }),
  );
  const passwordPage = readLoginPage(afterEmail.html);
  const emailRefusal = refusalOn(afterEmail, passwordPage, "the password page");
  if (emailRefusal !== undefined) return emailRefusal;
  if (!passwordPage.hasPasswordField) {
    return refused(
      `the email step ended at ${afterEmail.host}${afterEmail.path}, not a password form`,
    );
  }

  const afterPassword = await follow(
    session,
    new URL(afterEmail.url),
    form({
      state: passwordPage.state ?? identifier.state,
      username: credentials.email,
      password: credentials.password,
      action: "default",
    }),
  );

  if (afterPassword.host === new URL(SITE_ORIGIN).host) {
    if (!afterPassword.passedCallback) {
      return refused(
        `the chain returned to ${afterPassword.path} without passing ${CALLBACK_PATH}`,
      );
    }
    return { kind: "signedIn" };
  }
  if (afterPassword.host === new URL(AUTH_ORIGIN).host) {
    const page = readLoginPage(afterPassword.html);
    return (
      refusalOn(afterPassword, page, "the password step") ??
      refused(`the password step stayed on ${afterPassword.path} and stated no reason`)
    );
  }
  const keycloak = readKeycloakError(afterPassword.html);
  return refused(
    `the chain stopped at ${afterPassword.host}${afterPassword.path}` +
      (keycloak === undefined ? "" : `: "${keycloak}"`),
  );
}

interface Followed {
  readonly url: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly html: string;
  readonly passedCallback: boolean;
}

/**
 * Follows the chain hop by hop, recording whether the BFF callback was on it: arriving at www
 * any other way is not a completed sign-in.
 */
async function follow(session: Session, url: URL, init: RequestInit): Promise<Followed> {
  let target = url;
  let request = init;
  let passedCallback = false;
  for (let hop = 0; hop <= LOGIN_CHAIN_REDIRECTS; hop += 1) {
    if (target.pathname === CALLBACK_PATH) passedCallback = true;
    const response = await session.fetchOnce(target, request);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) {
      return {
        url: target.href,
        host: target.host,
        path: target.pathname,
        status: response.status,
        html: await response.text(),
        passedCallback,
      };
    }
    await response.arrayBuffer();
    target = new URL(location, target);
    request = { headers: { accept: "text/html" } };
  }
  throw new Error(`The sign-in chain made more than ${LOGIN_CHAIN_REDIRECTS} redirects.`);
}

function form(fields: Readonly<Record<string, string>>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      origin: AUTH_ORIGIN,
    },
    body: new URLSearchParams(fields).toString(),
  };
}

function refusalOn(followed: Followed, page: LoginPage, step: string): SignInResult | undefined {
  if (followed.status >= 400) return refused(`${step} answered HTTP ${followed.status}`);
  if (page.hasCaptcha) return refused(`${step} presented a captcha`);
  if (page.errors.length > 0) return refused(`${step} said: ${page.errors.join(" ")}`);
  return undefined;
}

function refused(reason: string): SignInResult {
  return { kind: "refused", reason };
}

/**
 * The credentials file, or undefined when there is none — which switches automatic sign-in off.
 * A file that exists but is not `{ "email": string, "password": string }` throws.
 */
export async function readCredentials(path: string): Promise<Credentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new Error(`Credentials at ${path} could not be read.`, { cause: error });
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Credentials at ${path} are not a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  const email = record["email"];
  const password = record["password"];
  if (
    typeof email !== "string" ||
    email === "" ||
    typeof password !== "string" ||
    password === ""
  ) {
    throw new Error(`Credentials at ${path} need non-empty string "email" and "password".`);
  }
  return { email, password };
}

/** Changes whenever the file is rewritten, so new credentials clear a stop left by the old ones. */
async function credentialsVersion(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

export type AutoSignInStatus =
  | { readonly state: "notConfigured" }
  | { readonly state: "ready"; readonly lastSignedInAt: string | undefined }
  | { readonly state: "stopped"; readonly reason: string; readonly since: string };

export type RecoveryOutcome =
  { readonly kind: "signedIn" } | { readonly kind: "unavailable"; readonly reason: string };

/** What the transport calls when the site refuses the session. */
export interface SessionRecovery {
  recover(): Promise<RecoveryOutcome>;
}

/**
 * Two consecutive sign-ins inside this window mean the first did not take. Signing in again would
 * only repeat it, so the second stops instead.
 */
const MIN_SIGN_IN_INTERVAL_MS = 10 * 60 * 1000;

export interface AutoSignInOptions {
  readonly credentialsPath: string;
  readonly signIn: (credentials: Credentials) => Promise<SignInResult>;
  /** Called with the new session after a sign-in, so a restart does not need another one. */
  readonly onSignedIn: () => Promise<void>;
  readonly now?: () => number;
}

/**
 * Re-signs the session when it dies, and stops for good on the first failure.
 *
 * Every attempt is a real login against a real account, and failed ones count towards a lockout.
 * So there is exactly one attempt in flight at a time, no retry after a refusal, and no second
 * sign-in inside ten minutes of the last. A stop clears only when a person acts: new credentials
 * written to the file, a browser handover (`npm run login`), or a restart.
 */
export class AutoSignIn implements SessionRecovery {
  private readonly options: AutoSignInOptions;
  private readonly now: () => number;
  private inFlight: Promise<RecoveryOutcome> | undefined;
  private lastSignedInAt: number | undefined;
  private stop:
    | { readonly reason: string; readonly at: number; readonly version: number | undefined }
    | undefined;

  constructor(options: AutoSignInOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  recover(): Promise<RecoveryOutcome> {
    const existing = this.inFlight;
    if (existing !== undefined) return existing;
    const attempt = this.attempt().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = attempt;
    return attempt;
  }

  /** A session handed over by a person is a person acting: it clears any stop. */
  clearStop(): void {
    this.stop = undefined;
  }

  async status(): Promise<AutoSignInStatus> {
    const version = await credentialsVersion(this.options.credentialsPath);
    if (version === undefined) return { state: "notConfigured" };
    const stop = this.currentStop(version);
    if (stop !== undefined) {
      return { state: "stopped", reason: stop.reason, since: new Date(stop.at).toISOString() };
    }
    return {
      state: "ready",
      lastSignedInAt:
        this.lastSignedInAt === undefined ? undefined : new Date(this.lastSignedInAt).toISOString(),
    };
  }

  private currentStop(version: number | undefined): typeof this.stop {
    if (this.stop !== undefined && this.stop.version !== version) this.stop = undefined;
    return this.stop;
  }

  private async attempt(): Promise<RecoveryOutcome> {
    const version = await credentialsVersion(this.options.credentialsPath);
    const stop = this.currentStop(version);
    if (stop !== undefined) {
      return { kind: "unavailable", reason: `automatic sign-in is stopped: ${stop.reason}` };
    }

    const credentials = await readCredentials(this.options.credentialsPath);
    if (credentials === undefined) {
      return {
        kind: "unavailable",
        reason: `automatic sign-in is off: there is no credentials file at ${this.options.credentialsPath}`,
      };
    }

    const last = this.lastSignedInAt;
    if (last !== undefined && this.now() - last < MIN_SIGN_IN_INTERVAL_MS) {
      const minutes = Math.round((this.now() - last) / 60_000);
      return this.stopWith(
        `the site refused a session signed in ${minutes} minute(s) ago, so signing in again would only repeat it`,
        version,
      );
    }

    let result: SignInResult;
    try {
      result = await this.options.signIn(credentials);
    } catch (error: unknown) {
      return this.stopWith(
        `the sign-in could not be completed: ${error instanceof Error ? error.message : String(error)}`,
        version,
      );
    }
    if (result.kind === "refused") return this.stopWith(result.reason, version);

    this.lastSignedInAt = this.now();
    await this.options.onSignedIn();
    console.error("[woolies-mcp] automatic sign-in succeeded");
    return { kind: "signedIn" };
  }

  private stopWith(reason: string, version: number | undefined): RecoveryOutcome {
    this.stop = { reason, at: this.now(), version };
    console.error(`[woolies-mcp] automatic sign-in stopped: ${reason}`);
    return { kind: "unavailable", reason: `automatic sign-in is stopped: ${reason}` };
  }
}
