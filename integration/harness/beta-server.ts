/**
 * Integration harness for the only server that speaks the pinned client's
 * contract: the `anomalyco/opencode` beta branch built from source.
 *
 * Responsibilities (stage-6 brief, deliverable 1):
 *   - shallow-clone the beta branch pinned at {@link BETA_PIN} into a cache
 *     directory OUTSIDE the worktree (idempotent; reuses a clone already at
 *     the right commit),
 *   - `bun install` it,
 *   - start `opencode serve` from source with isolated XDG homes and a
 *     sandbox workspace directory (never the global opencode state, never
 *     this worktree),
 *   - health-check and expose the endpoint (+ Basic-auth header — the beta
 *     server requires a password on every route),
 *   - tear down cleanly.
 *
 * Environment overrides:
 *   - `OPENCODE_BETA_URL` + `OPENCODE_BETA_PASSWORD`: use an already-running
 *     beta-source server instead of cloning/spawning (fast iteration).
 *   - `OPENCODE_BETA_SRC_DIR`: clone cache location
 *     (default `~/.cache/opencode-beta-src`).
 *   - `OPENCODE_BETA_SANDBOX_DIR`: sandbox root for XDG homes + workdir
 *     (default `~/.cache/opencode-beta-sandbox`).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Upstream commit matching the pinned `@opencode-ai/client@0.0.0-beta-18286`. */
export const BETA_PIN = "f4a9b93013695aa7a1b56ab5d91855965d5cc727";
const BETA_REPO_URL = "https://github.com/anomalyco/opencode.git";
const HEALTH_TIMEOUT_MS = 60_000;

/**
 * Server-side permission rules for the sandbox server, injected via
 * `OPENCODE_CONFIG_CONTENT` (v1 `permission` shape; the beta config loader
 * migrates it). `bash: ask` lets the approval-round-trip test trigger a real
 * `permission.asked` without affecting text-only turns.
 */
const SANDBOX_CONFIG = { permission: { bash: "ask" } };

export interface BetaServerHandle {
  baseUrl: string;
  /** `Basic` auth header value for every request (beta serve is passworded). */
  authHeader: string;
  /** Sandbox directory sessions must bind to (`location.directory`). */
  workdir: string;
  /** Whether zen credentials were found and copied (generation possible). */
  authAvailable: boolean;
  /** Server default model, when the catalog is reachable. */
  defaultModel?: { providerID: string; modelID: string };
  /** Kill the spawned server (no-op for externally provided servers). */
  stop: () => Promise<void>;
}

function run(
  command: string,
  args: string[],
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function fail(step: string, detail: string): never {
  throw new Error(`beta-source harness: ${step} failed — ${detail}`);
}

/**
 * Idempotently materialize the pinned beta source in `dir`. Reuses an
 * existing clone already at {@link BETA_PIN}; otherwise fetches the pin
 * (shallow) and checks it out detached.
 */
export function ensureBetaSource(dir: string): void {
  if (existsSync(join(dir, ".git"))) {
    const head = run("git", ["-C", dir, "rev-parse", "HEAD"]);
    if (head.ok && head.stdout === BETA_PIN) {
      return;
    }
    if (!run("git", ["-C", dir, "cat-file", "-e", BETA_PIN]).ok) {
      const fetch = run("git", [
        "-C",
        dir,
        "fetch",
        "--depth",
        "1",
        "origin",
        BETA_PIN,
      ]);
      if (!fetch.ok) {
        fail("git fetch of pinned commit", fetch.stderr);
      }
    }
    const checkout = run("git", ["-C", dir, "checkout", "-q", BETA_PIN]);
    if (!checkout.ok) {
      fail("git checkout of pinned commit", checkout.stderr);
    }
    return;
  }

  // Fresh shallow clone at the exact pin: init + fetch-by-sha stays shallow
  // even though the branch tip has moved past the pin.
  const init = run("git", ["init", "-q", dir]);
  if (!init.ok) {
    fail("git init", init.stderr);
  }
  run("git", ["-C", dir, "remote", "add", "origin", BETA_REPO_URL]);
  const fetch = run("git", [
    "-C",
    dir,
    "fetch",
    "--depth",
    "1",
    "origin",
    BETA_PIN,
  ]);
  if (!fetch.ok) {
    // Fallback: some git/proxy setups refuse fetch-by-sha; take the branch.
    const branchFetch = run("git", [
      "-C",
      dir,
      "fetch",
      "origin",
      "beta",
      "--no-tags",
    ]);
    if (!branchFetch.ok) {
      fail("git fetch", `${fetch.stderr}\n${branchFetch.stderr}`);
    }
  }
  const checkout = run("git", ["-C", dir, "checkout", "-q", BETA_PIN]);
  if (!checkout.ok) {
    fail("git checkout of pinned commit", checkout.stderr);
  }
}

/** `bun install` the monorepo unless its lockfile install already ran. */
export function ensureInstalled(dir: string): void {
  if (existsSync(join(dir, "node_modules"))) {
    return;
  }
  const bun = run("bun", ["--version"]);
  if (!bun.ok) {
    fail("bun check", "bun is not installed (the upstream repo is bun-only)");
  }
  const install = run("bun", ["install"], dir);
  if (!install.ok) {
    fail("bun install", install.stderr.slice(-2000));
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port assigned"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function copyZenAuth(dataHome: string): Promise<boolean> {
  const source =
    process.env.XDG_DATA_HOME !== undefined
      ? join(process.env.XDG_DATA_HOME, "opencode")
      : join(homedir(), ".local", "share", "opencode");
  const target = join(dataHome, "opencode");
  await mkdir(target, { recursive: true });
  let copied = false;
  for (const file of ["auth.json", "account.json"]) {
    if (existsSync(join(source, file))) {
      await copyFile(join(source, file), join(target, file));
      copied = copied || file === "auth.json";
    }
  }
  return copied;
}

async function waitForHealth(
  baseUrl: string,
  authHeader: string,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child !== undefined && child.exitCode !== null) {
      fail("server start", `serve exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const body = (await response.json()) as { healthy?: boolean };
        if (body.healthy === true) {
          return;
        }
        lastError = `healthy=${String(body.healthy)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("health check", `timed out after ${HEALTH_TIMEOUT_MS}ms (${lastError})`);
}

async function fetchDefaultModel(
  baseUrl: string,
  authHeader: string,
): Promise<{ providerID: string; modelID: string } | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/model/default`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as {
      data?: { providerID?: string; modelID?: string };
    };
    if (
      typeof body.data?.providerID === "string" &&
      typeof body.data.modelID === "string"
    ) {
      return { providerID: body.data.providerID, modelID: body.data.modelID };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start (or attach to) a beta-source server and return its endpoint handle.
 */
export async function startBetaServer(): Promise<BetaServerHandle> {
  const sandboxRoot =
    process.env.OPENCODE_BETA_SANDBOX_DIR ??
    join(homedir(), ".cache", "opencode-beta-sandbox");
  const workdir = join(sandboxRoot, "workdir");
  await mkdir(workdir, { recursive: true });

  // Attach mode: an external server was provided.
  const externalUrl = process.env.OPENCODE_BETA_URL;
  if (externalUrl !== undefined) {
    const password = process.env.OPENCODE_BETA_PASSWORD ?? "";
    const authHeader =
      "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    await waitForHealth(externalUrl, authHeader);
    return {
      baseUrl: externalUrl,
      authHeader,
      workdir,
      authAvailable: true,
      defaultModel: await fetchDefaultModel(externalUrl, authHeader),
      stop: async () => {},
    };
  }

  const sourceDir =
    process.env.OPENCODE_BETA_SRC_DIR ??
    join(homedir(), ".cache", "opencode-beta-src");
  ensureBetaSource(sourceDir);
  ensureInstalled(sourceDir);

  const dataHome = join(sandboxRoot, "data");
  const stateHome = join(sandboxRoot, "state");
  const configHome = join(sandboxRoot, "config");
  const cacheHome = join(sandboxRoot, "cache");
  await Promise.all(
    [dataHome, stateHome, configHome, cacheHome].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const authAvailable = await copyZenAuth(dataHome);

  const password = randomBytes(24).toString("base64url");
  const authHeader =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logFile = join(sandboxRoot, "server.log");

  const child = spawn(
    "bun",
    [
      "run",
      "--cwd",
      join(sourceDir, "packages", "cli"),
      "--conditions=browser",
      "src/index.ts",
      "serve",
      "--port",
      String(port),
    ],
    {
      cwd: workdir,
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        OPENCODE_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(SANDBOX_CONFIG),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logChunks: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) =>
    logChunks.push(chunk.toString("utf8")),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    logChunks.push(chunk.toString("utf8")),
  );

  try {
    await waitForHealth(baseUrl, authHeader, child);
  } catch (error) {
    child.kill("SIGKILL");
    await writeFile(logFile, logChunks.join(""), "utf8").catch(() => {});
    throw error instanceof Error
      ? new Error(`${error.message}\nserver log: ${logFile}`, { cause: error })
      : error;
  }

  return {
    baseUrl,
    authHeader,
    workdir,
    authAvailable,
    defaultModel: await fetchDefaultModel(baseUrl, authHeader),
    stop: async () => {
      await writeFile(logFile, logChunks.join(""), "utf8").catch(() => {});
      if (child.exitCode !== null) {
        return;
      }
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(killTimer);
    },
  };
}
