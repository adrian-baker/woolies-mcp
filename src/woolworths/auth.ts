/**
 * How the account tools explain a session that is not signed in.
 *
 * There are two ways in: the server signs itself in from a credentials file when the session dies
 * (`credential-signin.ts`), and a person can hand over a browser session with `npm run login`.
 * This module makes no network calls; it only words the outcome.
 */

const HANDOVER_DETAIL =
  "This session is not signed in, so the account tools cannot work. The server signs itself in " +
  "automatically when it has a credentials file (WOOLIES_CREDENTIALS_FILE); without one, or " +
  "when that has stopped, a person runs `npm run login -- --server <server>/mcp/<path token>` " +
  "on any machine with a browser. Credentials are never accepted as tool arguments.";

/** Raised by account operations when the session is anonymous. */
export class NotSignedInError extends Error {
  /** Why automatic sign-in did not rescue the session, when it was tried. */
  readonly recovery: string | undefined;

  constructor(options?: ErrorOptions, recovery?: string) {
    super(
      recovery === undefined ? HANDOVER_DETAIL : `${HANDOVER_DETAIL} This time: ${recovery}.`,
      options,
    );
    this.name = "NotSignedInError";
    this.recovery = recovery;
  }
}
