import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WoolworthsApi } from "./woolworths/api.js";
import type { ImportedCookie } from "./woolworths/session.js";

/**
 * Where `npm run login` writes and both entry points read, when WOOLIES_SESSION_FILE is unset.
 *
 * Resolved against this module rather than the working directory: an MCP client launches the
 * stdio server from wherever it happens to be, and a relative path would then miss the file.
 */
export function defaultSessionFilePath(): string {
  return fileURLToPath(new URL("../session.json", import.meta.url));
}

/**
 * Persists the signed-in session across restarts. Cookies only, written 0600.
 *
 * A missing file is a cold start. A file that cannot be read or parsed throws: starting anonymous
 * is indistinguishable from a healthy server until an account tool reports nothing.
 */
export class SessionStore {
  private readonly path: string | undefined;

  constructor(path: string | undefined) {
    this.path = path?.trim() === "" ? undefined : path;
  }

  get isEnabled(): boolean {
    return this.path !== undefined;
  }

  get location(): string | undefined {
    return this.path;
  }

  /** Returns undefined only when persistence is off or no session has been stored yet. */
  async load(): Promise<readonly ImportedCookie[] | undefined> {
    const path = this.path;
    if (path === undefined) return undefined;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) return undefined;
      throw new Error(`Stored session at ${path} could not be read: ${describe(error)}`, {
        cause: error,
      });
    }

    const parsed: unknown = JSON.parse(raw);
    const cookies = readCookies(parsed);
    if (cookies === undefined) {
      throw new Error(`Stored session at ${path} is not { cookies: [{ setCookie, url }] }.`);
    }
    return cookies;
  }

  async save(cookies: readonly ImportedCookie[]): Promise<void> {
    const path = this.path;
    if (path === undefined) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ cookies }, null, 2), { mode: 0o600 });
  }
}

function readCookies(parsed: unknown): readonly ImportedCookie[] | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const list = (parsed as Record<string, unknown>)["cookies"];
  if (!Array.isArray(list)) return undefined;

  const cookies: ImportedCookie[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    const setCookie = record["setCookie"];
    const url = record["url"];
    if (typeof setCookie !== "string" || typeof url !== "string") return undefined;
    cookies.push({ setCookie, url });
  }
  return cookies;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads a stored sign-in into a running server. Shared by both entry points so stdio and HTTP
 * cannot drift apart on it.
 *
 * An unreadable stored session exits: starting anonymous is indistinguishable from a healthy
 * server until an account tool quietly reports nothing.
 */
export async function restoreStoredSession(
  api: WoolworthsApi,
  store: SessionStore,
  serverName: string,
): Promise<void> {
  const cookies = await store.load().catch((error: unknown) => {
    console.error(`[${serverName}] stored session unusable:`, error);
    process.exit(1);
  });
  if (cookies === undefined) {
    console.error(
      `[${serverName}] no stored session at ${store.location ?? "(persistence off)"}; ` +
        "run `npm run login` to sign in. Catalogue tools work without one.",
    );
    return;
  }
  // One probe, not two: `importSession` already makes the account call that demonstrates access,
  // and asking again cost a second throttled round trip at every start-up for the same answer.
  const access = await api.importSession(cookies);
  console.error(
    `[${serverName}] restored session from ${store.location}: accountToolsUsable=${access.usable}` +
      (access.usable ? "" : " (run `npm run login` again)"),
  );
}
