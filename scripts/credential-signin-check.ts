/**
 * Offline gate for automatic sign-in: what the login pages say, the whole chain against a stubbed
 * site, the limits on attempts, the transport's single retry, and a signed-in session surviving
 * a save and restore.
 *
 * The page fixtures are synthetic, cut to the markup the parser reads: the inputs, the
 * `error-element-*` messages, the captcha widget container and Keycloak's error text, as the live
 * Auth0 and Keycloak pages served them to this client.
 *
 * Run with `npm run check:credential-signin`.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotSignedInError } from "../src/woolworths/auth.js";
import {
  AutoSignIn,
  performCredentialSignIn,
  readKeycloakError,
  readLoginPage,
  type Credentials,
  type RecoveryOutcome,
  type SignInResult,
} from "../src/woolworths/credential-signin.js";
import { SessionGraphQlTransport } from "../src/woolworths/graphql-client.js";
import { IDENTITY_DOCUMENT, IDENTITY_OPERATION } from "../src/woolworths/graphql-documents.js";
import { Session } from "../src/woolworths/session.js";
import { Throttle } from "../src/woolworths/throttle.js";

const failures: string[] = [];

function check(description: string, passed: boolean, detail: string): void {
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${description}: ${detail}`);
  if (!passed) failures.push(description);
}

const IDENTIFIER_PAGE = `<form method="POST"><input type="hidden" name="state" value="s-one"/>
<input name="username" type="email" value=""/><input type="hidden" name="js-available" value="false"/>
<button type="submit" name="action" value="default">Continue</button></form>
<script>var b=c("div[data-captcha-sitekey]");</script>`;
const PASSWORD_PAGE = `<form method="POST"><input type="hidden" name="state" value="s-two"/>
<input name="username" type="hidden" value="shopper@example.com"/><input name="password" type="password"/></form>`;
const WRONG_PASSWORD_PAGE = `<form method="POST"><input type="hidden" name="state" value="s-two"/>
<input name="password" type="password"/><span id="error-element-password" class="ulp-input-error-message">Wrong email or password</span></form>`;
const CAPTCHA_PAGE = `<form method="POST"><input type="hidden" name="state" value="s-two"/>
<input name="password" type="password"/><div class="ulp-captcha" data-captcha-sitekey="0x4AAA" data-captcha-provider="auth0_v2"></div></form>`;
const KEYCLOAK_ERROR_PAGE = `<html><title>Sign in to Woolworths NZ</title><div id="kc-content">
<span class="kc-feedback-text">Unexpected error when authenticating with identity provider</span></div></html>`;

console.log("\nWhat the pages say");
{
  const identifier = readLoginPage(IDENTIFIER_PAGE);
  check(
    "the email page yields its state and no password field",
    identifier.state === "s-one" && !identifier.hasPasswordField,
    JSON.stringify(identifier),
  );
  check(
    "a page that only ships the captcha script is not a captcha",
    !identifier.hasCaptcha,
    "script present, no widget container",
  );
  const password = readLoginPage(PASSWORD_PAGE);
  check(
    "the password page has a password field and its own state",
    password.hasPasswordField && password.state === "s-two",
    JSON.stringify(password),
  );
  check(
    "a rendered captcha widget is recognised",
    readLoginPage(CAPTCHA_PAGE).hasCaptcha,
    "data-captcha-sitekey container",
  );
  check(
    "the page's own error message is read",
    readLoginPage(WRONG_PASSWORD_PAGE).errors.join() === "Wrong email or password",
    JSON.stringify(readLoginPage(WRONG_PASSWORD_PAGE).errors),
  );
  check(
    "Keycloak's error is read",
    readKeycloakError(KEYCLOAK_ERROR_PAGE) ===
      "Unexpected error when authenticating with identity provider",
    String(readKeycloakError(KEYCLOAK_ERROR_PAGE)),
  );
}

interface Posted {
  readonly path: string;
  readonly fields: URLSearchParams;
}

type PasswordOutcome = "signedIn" | "wrongPassword" | "keycloakError" | "noCallback";

/**
 * The site's sign-in chain, hop for hop as the live one answered this client. `passwordPage`
 * picks what the password step serves; `outcome` what posting the password leads to.
 */
function stubSite(
  passwordPage: string,
  outcome: PasswordOutcome,
  posted: Posted[],
): typeof globalThis.fetch {
  const redirect = (location: string): Response =>
    new Response(null, { status: 302, headers: { location } });
  const page = (html: string): Response =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });

  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(
      input instanceof URL ? input.href : input instanceof Request ? input.url : input,
    );
    const key = `${init?.method ?? "GET"} ${url.host}${url.pathname}`;
    if (init?.method === "POST") {
      posted.push({
        path: url.pathname,
        fields: new URLSearchParams(typeof init.body === "string" ? init.body : ""),
      });
    }
    switch (key) {
      case "GET www.woolworths.co.nz/api/v1.0/bff/initiate-oidc-signin":
        return Promise.resolve(
          redirect(
            "https://iam.woolworths.co.nz/realms/wwnz-customers/protocol/openid-connect/auth",
          ),
        );
      case "GET iam.woolworths.co.nz/realms/wwnz-customers/protocol/openid-connect/auth":
        return Promise.resolve(
          redirect("https://auth.woolworths.co.nz/u/login/identifier?state=s-one"),
        );
      case "GET auth.woolworths.co.nz/u/login/identifier":
        return Promise.resolve(page(IDENTIFIER_PAGE));
      case "POST auth.woolworths.co.nz/u/login/identifier":
        return Promise.resolve(redirect("/u/login/password?state=s-two"));
      case "GET auth.woolworths.co.nz/u/login/password":
        return Promise.resolve(
          page(posted.some((p) => p.fields.has("password")) ? WRONG_PASSWORD_PAGE : passwordPage),
        );
      case "POST auth.woolworths.co.nz/u/login/password":
        switch (outcome) {
          case "wrongPassword":
            return Promise.resolve(redirect("/u/login/password?state=s-two"));
          case "keycloakError":
            return Promise.resolve(
              redirect("https://iam.woolworths.co.nz/realms/wwnz-customers/broker/gigya/endpoint"),
            );
          case "noCallback":
            return Promise.resolve(redirect("https://www.woolworths.co.nz/"));
          case "signedIn":
            return Promise.resolve(redirect("/authorize/resume?state=s-two"));
        }
        break;
      case "GET auth.woolworths.co.nz/authorize/resume":
        return Promise.resolve(
          redirect(
            "https://iam.woolworths.co.nz/realms/wwnz-customers/broker/gigya/endpoint?code=c",
          ),
        );
      case "GET iam.woolworths.co.nz/realms/wwnz-customers/broker/gigya/endpoint":
        return Promise.resolve(
          url.searchParams.has("code")
            ? redirect("https://www.woolworths.co.nz/api/v1.0/bff/login-callback?code=d")
            : page(KEYCLOAK_ERROR_PAGE),
        );
      case "GET www.woolworths.co.nz/api/v1.0/bff/login-callback":
        return Promise.resolve(redirect("https://www.woolworths.co.nz/"));
      case "GET www.woolworths.co.nz/":
        return Promise.resolve(page("<html>home</html>"));
    }
    return Promise.resolve(new Response(`unexpected ${key}`, { status: 599 }));
  };
}

const realFetch = globalThis.fetch;
const credentials: Credentials = { email: "shopper@example.com", password: "p4ss" };

async function runChain(
  passwordPage: string,
  outcome: PasswordOutcome,
): Promise<{ readonly result: SignInResult; readonly posted: readonly Posted[] }> {
  const posted: Posted[] = [];
  globalThis.fetch = stubSite(passwordPage, outcome, posted);
  try {
    return { result: await performCredentialSignIn(new Session(), credentials), posted };
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nThe chain, against a stubbed site");
{
  const { result, posted } = await runChain(PASSWORD_PAGE, "signedIn");
  check(
    "a clean chain through the BFF callback signs in",
    result.kind === "signedIn",
    JSON.stringify(result),
  );
  const [email, password] = posted;
  check(
    "the email is posted alone first, saying JavaScript is unavailable",
    email?.path === "/u/login/identifier" &&
      email.fields.get("username") === credentials.email &&
      !email.fields.has("password") &&
      email.fields.get("js-available") === "false",
    email === undefined ? "(nothing posted)" : [...email.fields.keys()].join(","),
  );
  check(
    "the password is posted second, with the password page's own state",
    password?.path === "/u/login/password" &&
      password.fields.get("password") === credentials.password &&
      password.fields.get("state") === "s-two",
    password === undefined ? "(nothing posted)" : [...password.fields.keys()].join(","),
  );

  const captcha = await runChain(CAPTCHA_PAGE, "signedIn");
  check(
    "a captcha stops the sign-in before the password is sent",
    captcha.result.kind === "refused" &&
      captcha.result.reason.includes("captcha") &&
      !captcha.posted.some((p) => p.fields.has("password")),
    JSON.stringify(captcha.result),
  );

  const wrong = await runChain(PASSWORD_PAGE, "wrongPassword");
  check(
    "a wrong password is refused in the site's words",
    wrong.result.kind === "refused" && wrong.result.reason.includes("Wrong email or password"),
    JSON.stringify(wrong.result),
  );

  const keycloak = await runChain(PASSWORD_PAGE, "keycloakError");
  check(
    "Keycloak stopping the chain is refused with its message",
    keycloak.result.kind === "refused" && keycloak.result.reason.includes("Unexpected error"),
    JSON.stringify(keycloak.result),
  );

  const skipped = await runChain(PASSWORD_PAGE, "noCallback");
  check(
    "arriving back on the site without the BFF callback is not a sign-in",
    skipped.result.kind === "refused" && skipped.result.reason.includes("login-callback"),
    JSON.stringify(skipped.result),
  );
}

console.log("\nLimits on attempts");
{
  const dir = await mkdtemp(join(tmpdir(), "woolies-credentials-"));
  const path = join(dir, "credentials.json");
  let clock = 1_000_000_000_000;
  let calls = 0;
  let saves = 0;
  let next: SignInResult | Error = { kind: "signedIn" };
  const auto = new AutoSignIn({
    credentialsPath: path,
    now: () => clock,
    signIn: () => {
      calls += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    onSignedIn: () => {
      saves += 1;
      return Promise.resolve();
    },
  });

  const missing = await auto.recover();
  check(
    "no credentials file: nothing is attempted, and it says so",
    missing.kind === "unavailable" && missing.reason.includes("no credentials file") && calls === 0,
    JSON.stringify(missing),
  );
  check(
    "no credentials file reads as not configured",
    (await auto.status()).state === "notConfigured",
    "",
  );

  await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  const [first, second] = await Promise.all([auto.recover(), auto.recover()]);
  check(
    "concurrent refusals share one sign-in",
    first.kind === "signedIn" && second.kind === "signedIn" && calls === 1,
    `${calls} attempt(s)`,
  );
  check("a sign-in is saved", saves === 1, `${saves} save(s)`);

  clock += 5 * 60 * 1000;
  const tooSoon = await auto.recover();
  check(
    "a second sign-in within ten minutes stops instead of repeating",
    tooSoon.kind === "unavailable" && tooSoon.reason.includes("minute") && calls === 1,
    JSON.stringify(tooSoon),
  );
  check("that stop is reported with its reason", (await auto.status()).state === "stopped", "");

  auto.clearStop();
  clock += 60 * 60 * 1000;
  next = { kind: "refused", reason: "the password step said: Wrong email or password" };
  const wrong = await auto.recover();
  const again = await auto.recover();
  check(
    "a refusal stops, and the stop is not retried",
    wrong.kind === "unavailable" && again.kind === "unavailable" && calls === 2,
    `${calls} attempt(s); ${JSON.stringify(again)}`,
  );

  // Rewritten credentials are a person acting: the stop clears on the next attempt.
  await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
  await utimes(path, new Date(), new Date(Date.now() + 60_000));
  next = { kind: "signedIn" };
  const afterFix = await auto.recover();
  check(
    "rewriting the credentials file clears the stop",
    afterFix.kind === "signedIn" && calls === 3,
    `${calls} attempt(s)`,
  );

  clock += 60 * 60 * 1000;
  next = new Error("socket hang up");
  const thrown = await auto.recover();
  check(
    "a sign-in that throws stops too, and says why",
    thrown.kind === "unavailable" && thrown.reason.includes("socket hang up"),
    JSON.stringify(thrown),
  );

  await writeFile(path, '{"email":""}');
  let malformed = "";
  try {
    auto.clearStop();
    await auto.recover();
  } catch (error: unknown) {
    malformed = error instanceof Error ? error.message : String(error);
  }
  check(
    "a malformed credentials file throws rather than reading as absent",
    malformed.includes("need non-empty"),
    malformed,
  );
  await rm(dir, { recursive: true });
}

console.log("\nThe transport's one retry");
{
  const banned = JSON.stringify({
    data: null,
    errors: [{ message: "banned", extensions: { code: "BANNED_OPERATION" } }],
  });
  const signedIn = JSON.stringify({ data: { me: { id: "shopper" } } });

  async function transportRun(
    outcome: RecoveryOutcome,
    answers: readonly string[],
  ): Promise<{ readonly result: string; readonly recoveries: number; readonly mints: number }> {
    let graphqlCalls = 0;
    let mints = 0;
    let recoveries = 0;
    globalThis.fetch = (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
      const url = new URL(
        input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      );
      if (url.pathname === "/cart") {
        mints += 1;
        return Promise.resolve(
          new Response("<html/>", {
            status: 200,
            headers: { "set-cookie": `__session__0=m${mints}; Path=/` },
          }),
        );
      }
      const body = answers[Math.min(graphqlCalls, answers.length - 1)] ?? banned;
      graphqlCalls += 1;
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    };
    const transport = new SessionGraphQlTransport(new Session(), new Throttle(0), {
      recover: () => {
        recoveries += 1;
        return Promise.resolve(outcome);
      },
    });
    try {
      const data = await transport.send(IDENTITY_OPERATION, IDENTITY_DOCUMENT, {});
      return { result: `ok ${data.me?.id ?? "?"}`, recoveries, mints };
    } catch (error: unknown) {
      return {
        result: error instanceof NotSignedInError ? `NotSignedIn: ${error.message}` : String(error),
        recoveries,
        mints,
      };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const healed = await transportRun({ kind: "signedIn" }, [banned, signedIn]);
  check(
    "a refused session is signed in again, the Next.js session re-minted, and the call retried",
    healed.result === "ok shopper" && healed.recoveries === 1 && healed.mints === 2,
    `${healed.result}; ${healed.recoveries} recovery, ${healed.mints} mints`,
  );

  const stillBanned = await transportRun({ kind: "signedIn" }, [banned, banned]);
  check(
    "a refusal after signing in again is reported, not chased",
    stillBanned.result.startsWith("NotSignedIn") && stillBanned.recoveries === 1,
    `${stillBanned.recoveries} recovery`,
  );

  const stopped = await transportRun(
    { kind: "unavailable", reason: "automatic sign-in is stopped: a captcha" },
    [banned],
  );
  check(
    "when sign-in cannot help, the error carries its reason",
    stopped.result.includes("automatic sign-in is stopped: a captcha"),
    stopped.result.slice(0, 120),
  );
}

console.log("\nSaving a session the server signed in itself");
{
  const original = new Session();
  await original.importCookies([
    { setCookie: "aga=1; Path=/; HttpOnly; Secure", url: "https://www.woolworths.co.nz/" },
    {
      setCookie: "auth0=2; Path=/; Secure; Expires=Wed, 01 Jan 2099 00:00:00 GMT",
      url: "https://auth.woolworths.co.nz/",
    },
    { setCookie: "_abck=3; Domain=woolworths.co.nz; Path=/", url: "https://www.woolworths.co.nz/" },
    { setCookie: "other=4; Path=/", url: "https://example.com/" },
  ]);
  const exported = await original.exportCookies();
  const restored = new Session();
  await restored.importCookies(exported);
  const names = [...(await restored.cookieNames())].sort().join(",");
  check(
    "every woolworths.co.nz cookie survives export and import, and nothing else is exported",
    names === "_abck,aga" &&
      exported.length === 3 &&
      !exported.some((c) => c.url.includes("example.com")),
    `www sees ${names}; ${exported.length} exported`,
  );
}

console.log(
  `\n${failures.length === 0 ? "All credential sign-in checks passed." : `${failures.length} failed:`}`,
);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
