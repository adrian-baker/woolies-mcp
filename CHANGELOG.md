# Changelog

## 1.1.0 — 2026-09-27

The server now keeps itself signed in, and a hosted client can authorise itself instead of holding
a secret URL.

### Added

- **Automatic sign-in.** Given your Woolworths email and password (`npm run credentials`), the
  server signs itself in whenever the site refuses the session, proves the new session with a real
  account call, saves it, and retries the call that failed. It stops at the first failure — a wrong
  password, a captcha, a sign-in that still answers as a guest, or a second sign-in within ten
  minutes — and never retries a stop against your account. A stop clears when the credentials are
  rewritten, a browser session is handed over, or the server restarts. Without a credentials file,
  nothing changes: `npm run login` works as before.
- **OAuth for hosted clients** (optional). Setting `MCP_PUBLIC_URL` and `MCP_AUTH_PASSPHRASE` serves
  MCP at `/mcp` behind a standard authorisation flow: discovery, dynamic registration, a consent
  page that asks for the passphrase, PKCE, rotating refresh tokens. The secret path then serves only
  the `npm run login` handover.
- `npm run credentials` stores the login with the password unechoed: on the deploy target over
  SSH, or `--local` for the stdio server.
- `npm run deploy` prints the connector URL the running service actually serves.

### Changed

- `auth_status` and `sign_in` report `autoSignIn` (`ready`, `stopped` with its reason, or
  `notConfigured`). `sign_in` now signs in when it can, rather than only describing how.
- A refused account call says why automatic sign-in did not rescue it.

### Removed

- `cookieExpiresAt`, from `auth_status`, `sign_in` and the session handover response. The cookie
  it read is no longer set by the site, so it reported nothing.

## Upgrading from 1.0

For a Docker deployment (the NAS path in the README):

1. **Deploy.** `git pull` and `npm run deploy`. `docker-compose.yml` now sets
   `WOOLIES_CREDENTIALS_FILE` and `MCP_OAUTH_FILE` under `/data`; nothing else is required, and
   with neither file present the server behaves as 1.0 did.
2. **Store your login** (recommended). `npm run credentials` — it prompts for your email and your
   password, hidden, and writes `data/credentials.json` on the target, readable only by the
   container. From then on a dead session repairs itself; `auth_status` shows
   `autoSignIn.state: "ready"`.
3. **Turn on OAuth** (optional). `npm run deploy` never overwrites an existing `.env`, so add these
   two lines to the target's `.env` yourself, then deploy again:

   ```
   MCP_PUBLIC_URL=https://<your-public-host>
   MCP_AUTH_PASSPHRASE=<12+ characters, generated and kept in your password manager>
   ```

   The connector URL becomes `https://<your-public-host>/mcp` and the old `/mcp/<token>` URL stops
   serving MCP. Remove the connector from your client and add it again at the new URL; connecting
   opens the consent page, which asks for the passphrase.
4. **Reconnect the client** even if you skip step 3, so it picks up the new tool descriptions.

For the stdio server: `git pull`, `npm run build`, then `npm run credentials -- --local` and set
`WOOLIES_CREDENTIALS_FILE` to the `credentials.json` it wrote.

To go back: remove `data/credentials.json` to turn automatic sign-in off, and remove the two OAuth
lines from `.env` and redeploy to return to the path-token URL.

## 1.0.0

The server as it stood before versioned releases: every call on the site's GraphQL API, a secret
path guarding the HTTP endpoint, and sign-in by browser handover (`npm run login`).
