/**
 * Stores the Woolworths email and password the server signs itself in with.
 *
 * The password is read with echo off and written as `{ "email", "password" }`, mode 0600: to the
 * deploy target's `data/credentials.json` over SSH stdin, owned by the container user, or with
 * `--local` to `credentials.json` here for the stdio server. It never appears in argv, shell
 * history or on screen, and nothing here prints it.
 *
 * Usage: npm run credentials [-- <ssh-alias> | --local]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

if (existsSync(".env")) process.loadEnvFile(".env");

const REMOTE_DIR = process.env["DEPLOY_REMOTE_DIR"] ?? "/volume1/docker/woolies-mcp";
/** The container runs as `node`, uid and gid 1000; the file must be readable by it alone. */
const CONTAINER_OWNER = "1000:1000";
const LOCAL_FILE = "credentials.json";

async function main(): Promise<void> {
  const target = process.argv[2] ?? process.env["DEPLOY_SSH_HOST"] ?? "";
  const local = target === "--local";
  if (!local && target.trim() === "") {
    fail("Set DEPLOY_SSH_HOST in .env, pass an ssh alias, or pass --local.");
  }

  const email = (await prompt("Woolworths email: ", false)).trim();
  if (!email.includes("@")) fail("That is not an email address. Nothing was saved.");
  const password = await prompt("Woolworths password (hidden): ", true);
  if (password === "") fail("Empty password. Nothing was saved.");

  const json = JSON.stringify({ email, password });
  if (local) {
    await writeFile(LOCAL_FILE, json, { mode: 0o600 });
    console.log(
      `Saved to ${LOCAL_FILE}. Point WOOLIES_CREDENTIALS_FILE at it for the stdio server.`,
    );
    return;
  }

  const file = `${REMOTE_DIR}/data/credentials.json`;
  await sshWithStdin(
    target,
    `sudo sh -c "umask 077; cat > '${file}'" && sudo chown ${CONTAINER_OWNER} '${file}' && sudo chmod 600 '${file}'`,
    json,
  );
  console.log(`Saved to ${target}:${file}. The running server reads it on its next sign-in.`);
}

/** One line from the terminal; with `hidden`, nothing typed is echoed. */
function prompt(question: string, hidden: boolean): Promise<string> {
  const input = process.stdin;
  process.stdout.write(question);
  if (!hidden || !input.isTTY) {
    return new Promise((resolve) => {
      input.once("data", (chunk: Buffer) => {
        input.pause();
        resolve(chunk.toString("utf8").replace(/\r?\n$/, ""));
      });
      input.resume();
    });
  }
  return new Promise((resolve) => {
    let value = "";
    input.setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}

function sshWithStdin(host: string, command: string, stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [host, command], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`ssh ${host} exited with ${String(code)}; nothing may have been saved.`));
    });
    child.stdin.end(stdin);
  });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

await main();
