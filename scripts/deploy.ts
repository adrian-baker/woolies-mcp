/**
 * Deploys to a Synology NAS over SSH: ships HEAD, builds the image there, restarts the compose
 * service, waits for health.
 *
 * Synology-specific: DSM disables SFTP, hence the tarball over SSH rather than scp, and gives
 * non-login SSH a minimal PATH, hence the absolute docker path and sudo. Any host that runs
 * `docker compose` can serve this image; this script is one way, not the only one.
 *
 * `.env` is copied only when the target has none, and its contents are never printed.
 *
 * Usage: npm run deploy [-- <ssh-alias>]
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const HOST = resolveHost();
const REMOTE_DIR = process.env["DEPLOY_REMOTE_DIR"] ?? "/volume1/docker/woolies-mcp";
const PUBLIC_URL = process.env["PUBLIC_BASE_URL"];
/** Synology gives non-login SSH a minimal PATH; docker is not on it. */
const DOCKER = process.env["DEPLOY_DOCKER_PATH"] ?? "/usr/local/bin/docker";
const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 2000;

function resolveHost(): string {
  const host = process.argv[2] ?? process.env["DEPLOY_SSH_HOST"];
  if (host === undefined || host.trim() === "") {
    console.error("Set DEPLOY_SSH_HOST in .env, or pass an ssh alias: npm run deploy -- <host>");
    process.exit(1);
  }
  return host;
}

async function main(): Promise<void> {
  await assertCleanTree();

  step("Clearing the previous source");
  // `tar -x` writes over the top and never removes anything, so a file deleted in HEAD survives
  // on the target and is still compiled there. Everything git owns goes first; `.env` and the
  // signed-in session under `data/` are the only state and are kept.
  await ssh(
    `cd '${REMOTE_DIR}' && find . -mindepth 1 -maxdepth 1 ! -name .env ! -name data -exec rm -rf {} +`,
  );

  step("Shipping HEAD");
  await pipeline(
    ["git", ["archive", "--format=tar", "HEAD"]],
    ["ssh", [HOST, `tar -x -C '${REMOTE_DIR}'`]],
  );

  await copyEnvIfMissing();

  step(`Building the image on ${HOST}`);
  await ssh(`cd '${REMOTE_DIR}' && sudo ${DOCKER} compose build`);

  step("Starting the service");
  await ssh(`cd '${REMOTE_DIR}' && sudo ${DOCKER} compose up -d`);

  step("Waiting for health");
  await waitForHealth();

  step(
    PUBLIC_URL === undefined
      ? "Deployed."
      : `Deployed. Public URL: ${PUBLIC_URL}/mcp/<MCP_PATH_TOKEN>`,
  );
}

/** HEAD is what ships, so a dirty tree would deploy something other than what was just built. */
async function assertCleanTree(): Promise<void> {
  const changed = await capture("git", ["status", "--porcelain"]);
  if (changed.trim() === "") return;
  console.error("Refusing to deploy: the working tree has uncommitted changes.");
  console.error("HEAD is what ships, so commit (or stash) first:\n");
  console.error(changed);
  process.exit(1);
}

async function copyEnvIfMissing(): Promise<void> {
  const present = await sshStatus(`test -f '${REMOTE_DIR}/.env'`);
  if (present === 0) {
    step(`.env already on ${HOST}, leaving it alone`);
    return;
  }
  if (!existsSync(".env")) {
    console.error("No local .env, and none on the NAS. Create one from .env.example first.");
    process.exit(1);
  }
  step("Copying .env (contents not shown)");
  await run("ssh", [HOST, `cat > '${REMOTE_DIR}/.env' && chmod 600 '${REMOTE_DIR}/.env'`], {
    stdin: createReadStream(".env"),
  });
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    const status = await sshStatus("curl -fsS http://127.0.0.1:8480/healthz >/dev/null 2>&1");
    if (status === 0) {
      step("healthy");
      return;
    }
    await delay(HEALTH_INTERVAL_MS);
  }
  console.error(
    `Service did not become healthy within ${(HEALTH_ATTEMPTS * HEALTH_INTERVAL_MS) / 1000}s.`,
  );
  console.error(`Check: ssh ${HOST} 'sudo ${DOCKER} logs --tail 50 woolies-mcp'`);
  process.exit(1);
}

function ssh(command: string): Promise<void> {
  return run("ssh", [HOST, command]);
}

/** Exit status of a remote command, for the cases where non-zero is an answer rather than a fault. */
async function sshStatus(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [HOST, command], { stdio: "ignore" });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
    child.on("error", () => {
      resolve(1);
    });
  });
}

function run(
  command: string,
  args: readonly string[],
  options: { stdin?: NodeJS.ReadableStream } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: [options.stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    if (options.stdin !== undefined) {
      if (child.stdin === null) {
        reject(new Error(`${command} was given no stdin to write to`));
        return;
      }
      options.stdin.pipe(child.stdin);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

/** Runs a producer into a consumer, failing if either end fails. */
function pipeline(
  producer: readonly [string, readonly string[]],
  consumer: readonly [string, readonly string[]],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = spawn(producer[0], [...producer[1]], { stdio: ["inherit", "pipe", "inherit"] });
    const sink = spawn(consumer[0], [...consumer[1]], { stdio: ["pipe", "inherit", "inherit"] });
    source.stdout.pipe(sink.stdin);

    let failed = false;
    const fail = (error: Error): void => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    source.on("error", fail);
    sink.on("error", fail);
    source.on("close", (code) => {
      if (code !== 0) fail(new Error(`${producer[0]} exited with ${code}`));
    });
    sink.on("close", (code) => {
      if (failed) return;
      if (code === 0) resolve();
      else fail(new Error(`${consumer[0]} exited with ${code}`));
    });
  });
}

function capture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function step(message: string): void {
  console.log(`==> ${message}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
