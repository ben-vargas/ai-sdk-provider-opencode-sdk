/**
 * Integration harness for a server that speaks the pinned client's contract.
 *
 * The default (and intended) path is the **published** OpenCode v2 CLI:
 * `@opencode-ai/cli@0.0.0-beta-18286`, binary `opencode2`, installed as a
 * devDependency at the exact same build number as the pinned
 * `@opencode-ai/client@0.0.0-beta-18286`. Same build ⇒ same wire contract,
 * verified live (spike/14-opencode2-verification.mjs).
 *
 * Package-name trap: `opencode-ai` on npm is the **v1** CLI and speaks a
 * different, incompatible protocol. The v2 CLI is `@opencode-ai/cli` and its
 * binary is `opencode2`. Probing `opencode-ai` is what produced this repo's
 * earlier "no published server serves this contract" conclusion; it was
 * wrong about the package, not about the contract.
 *
 * Responsibilities:
 *   - resolve the `opencode2` binary from the devDependency and assert its
 *     version matches the pinned client build,
 *   - start `opencode2 serve` with isolated XDG homes, an isolated
 *     HOME/`OPENCODE_TEST_HOME`, a minimal environment, and a sandbox
 *     workspace directory OUTSIDE the real home (the server's config
 *     discovery walks upward from `location.directory` to the filesystem
 *     root looking for `.opencode`/`.claude`/`.agents`, and loads
 *     `$HOME/.claude` + `$HOME/.agents` directly — so isolation requires
 *     both a fake home and a workdir whose ancestors hold no real config),
 *   - health-check and expose the endpoint (+ Basic-auth header — v2 serve
 *     requires a password on every route; username is `opencode`),
 *   - tear down cleanly.
 *
 * Environment overrides:
 *   - `OLLAMA_API_KEY`: forwarded from the host into the sandboxed server
 *     env (the one deliberate hole in the allowlist). It enables the
 *     server's `ollama-cloud` provider, which the suite's pinned test model
 *     needs (see `test-model.ts`). Without it the spawned server does not
 *     list the pin in its catalog, so resolution falls back (with a
 *     message) to the server default model. In attach mode the external
 *     server's own env decides — the host key is irrelevant there.
 *   - `OPENCODE_TEST_MODEL`: `providerID/modelID` override for the model
 *     generation tests use (resolved and probe-verified in `test-model.ts`).
 *   - `OPENCODE_BETA_URL` + `OPENCODE_BETA_PASSWORD`: use an already-running
 *     v2 server instead of spawning one (fast iteration). Independent of
 *     every local launcher — it resolves neither the devDependency binary
 *     nor the source checkout, so attach mode works on a machine that has
 *     neither. Tests that spawn a server variant of their own skip unless a
 *     local binary happens to be installed.
 *   - `OPENCODE_BETA_SANDBOX_DIR`: sandbox root for XDG homes + workdir
 *     (default `$TMPDIR/opencode-beta-sandbox` — deliberately outside the
 *     real home so upward config discovery cannot reach it).
 *   - `OPENCODE_BETA_SRC_DIR`: opt-in fallback ONLY. When set, the harness
 *     builds and serves the pinned beta branch from source instead of using
 *     the published binary. Kept for the case where a future published
 *     build proves unusable; it is not the default path and requires `bun`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The published CLI build the harness expects, and the same build as the
 * pinned `@opencode-ai/client`. Kept in lockstep with the `@opencode-ai/cli`
 * devDependency in package.json.
 */
export const OPENCODE_CLI_PIN = "0.0.0-beta-18286";
/** Upstream commit matching {@link OPENCODE_CLI_PIN} (source-fallback only). */
export const BETA_PIN = "f4a9b93013695aa7a1b56ab5d91855965d5cc727";
const BETA_REPO_URL = "https://github.com/anomalyco/opencode.git";
const HEALTH_TIMEOUT_MS = 60_000;

/**
 * Server-side permission rules for the sandbox server, injected via
 * `OPENCODE_CONFIG_CONTENT` (v1 `permission` shape; the v2 config loader
 * migrates it). `bash: ask` lets the approval-round-trip test trigger a real
 * `permission.asked` without affecting text-only turns.
 */
const SANDBOX_CONFIG = { permission: { bash: "ask" } };

/**
 * How to start a server process: spawn `command` with
 * `[...args, "serve", ...serveFlags]`. Tests that need their own server
 * variant (e.g. `serve --service`) use this instead of hard-coding a
 * launcher, so they work on both the published-binary and source paths.
 */
export interface ServeCommand {
  command: string;
  args: string[];
}

export interface BetaServerHandle {
  /** `"spawned"` sandbox child vs `"attach"` (`OPENCODE_BETA_URL`). */
  mode: "spawned" | "attach";
  baseUrl: string;
  /** `Basic` auth header value for every request (v2 serve is passworded). */
  authHeader: string;
  /** Sandbox directory sessions must bind to (`location.directory`). */
  workdir: string;
  /** Whether zen credentials were found and copied (generation possible). */
  authAvailable: boolean;
  /** Server default model, when the catalog is reachable. */
  defaultModel?: { providerID: string; modelID: string };
  /** How this harness starts a server, for tests that spawn a variant. */
  serveCommand?: ServeCommand;
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
  throw new Error(`opencode2 harness: ${step} failed — ${detail}`);
}

const require = createRequire(import.meta.url);

/**
 * Resolve the published `opencode2` binary and verify its build number.
 *
 * The version gate is the whole value of this path: a mismatched binary
 * speaks a different contract and would produce failures that look like
 * provider bugs. Resolution goes through the package's own `bin` entry (the
 * postinstall copies the platform build there) rather than `node_modules/
 * .bin`, so it works even when bin links were not created.
 */
export function resolveOpencode2(): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@opencode-ai/cli/package.json");
  } catch {
    return fail(
      "resolve @opencode-ai/cli",
      `not installed — run \`npm install\` (devDependency, pinned ${OPENCODE_CLI_PIN})`,
    );
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
    bin?: Record<string, string>;
  };
  if (manifest.version !== OPENCODE_CLI_PIN) {
    fail(
      "@opencode-ai/cli version check",
      `installed ${String(manifest.version)}, expected ${OPENCODE_CLI_PIN} ` +
        `(the binary must be the same build as the pinned @opencode-ai/client)`,
    );
  }
  const relative = manifest.bin?.opencode2;
  if (relative === undefined) {
    fail("@opencode-ai/cli bin lookup", "package declares no `opencode2` bin");
  }
  const binary = join(dirname(packageJsonPath), relative);
  if (!existsSync(binary)) {
    fail(
      "opencode2 binary lookup",
      `${binary} missing — the package postinstall did not run ` +
        `(reinstall without --ignore-scripts)`,
    );
  }
  return binary;
}

/**
 * Idempotently materialize the pinned beta source in `dir`. Reuses an
 * existing clone already at {@link BETA_PIN}; otherwise fetches the pin
 * (shallow) and checks it out detached. Source-fallback path only.
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

/**
 * The serve launcher for the opt-in source fallback
 * (`OPENCODE_BETA_SRC_DIR`): clone + `bun install` the pinned branch and run
 * the CLI entrypoint from source.
 */
function sourceServeCommand(sourceDir: string): ServeCommand {
  ensureBetaSource(sourceDir);
  ensureInstalled(sourceDir);
  return {
    command: "bun",
    args: [
      "run",
      "--cwd",
      join(sourceDir, "packages", "cli"),
      "--conditions=browser",
      "src/index.ts",
    ],
  };
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

/** A child is gone once it has either an exit code or a fatal signal. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Build the `Basic` header v2 serve expects (username is always `opencode`). */
export function basicAuthHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

async function waitForHealth(
  baseUrl: string,
  authHeader: string,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child !== undefined && hasExited(child)) {
      fail(
        "server start",
        `serve exited with code ${child.exitCode} signal ${child.signalCode}`,
      );
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
 * The password `serve` printed, if it printed one.
 *
 * `OPENCODE_PASSWORD` is honoured by the pinned build (verified: the env
 * password authenticates and no `server password` line is emitted), so this
 * is a safety net — if a build ever ignored the env var it would generate
 * its own and announce it here, and the harness adopts that instead of
 * failing every request with 401.
 */
function parseAnnouncedPassword(log: string): string | undefined {
  const match = /^server password (\S+)$/m.exec(log);
  return match?.[1];
}

/**
 * Start (or attach to) a v2 server and return its endpoint handle.
 */
export async function startBetaServer(): Promise<BetaServerHandle> {
  const sandboxRoot =
    process.env.OPENCODE_BETA_SANDBOX_DIR ??
    join(tmpdir(), "opencode-beta-sandbox");
  const workdir = join(sandboxRoot, "workdir");
  await mkdir(workdir, { recursive: true });

  // Attach mode: an external server was provided. Resolved FIRST, and
  // without touching any local launcher — the whole point of this path is a
  // server that is already running, so requiring the devDependency (or
  // worse, cloning and installing the source fallback) would defeat it.
  const externalUrl = process.env.OPENCODE_BETA_URL;
  if (externalUrl !== undefined) {
    const authHeader = basicAuthHeader(
      process.env.OPENCODE_BETA_PASSWORD ?? "",
    );
    await waitForHealth(externalUrl, authHeader);
    // Only for the few tests that spawn a server variant of their own
    // (e.g. `serve --service`); when no local binary is installed they skip
    // rather than fail, because attach mode does not require one.
    const localLauncher = ((): ServeCommand | undefined => {
      try {
        return { command: resolveOpencode2(), args: [] };
      } catch {
        return undefined;
      }
    })();
    return {
      mode: "attach",
      baseUrl: externalUrl,
      authHeader,
      workdir,
      authAvailable: true,
      defaultModel: await fetchDefaultModel(externalUrl, authHeader),
      ...(localLauncher !== undefined ? { serveCommand: localLauncher } : {}),
      stop: async () => {},
    };
  }

  // Opt-in source fallback; the published binary is the default.
  const sourceDir = process.env.OPENCODE_BETA_SRC_DIR;
  const serveCommand: ServeCommand =
    sourceDir === undefined
      ? { command: resolveOpencode2(), args: [] }
      : sourceServeCommand(sourceDir);

  const dataHome = join(sandboxRoot, "data");
  const stateHome = join(sandboxRoot, "state");
  const configHome = join(sandboxRoot, "config");
  const cacheHome = join(sandboxRoot, "cache");
  const homeDir = join(sandboxRoot, "home");
  await Promise.all(
    [dataHome, stateHome, configHome, cacheHome, homeDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const authAvailable = await copyZenAuth(dataHome);

  const password = randomBytes(24).toString("base64url");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logFile = join(sandboxRoot, "server.log");

  const child = spawn(
    serveCommand.command,
    [...serveCommand.args, "serve", "--port", String(port)],
    {
      cwd: workdir,
      // Minimal allowlisted environment: the server (and every tool it
      // spawns) must not inherit the real HOME or ambient variables. The
      // fake HOME + OPENCODE_TEST_HOME redirect `$HOME/.claude`,
      // `$HOME/.agents`, and `~` expansion into the sandbox.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: homeDir,
        OPENCODE_TEST_HOME: homeDir,
        ...(process.env.TMPDIR !== undefined
          ? { TMPDIR: process.env.TMPDIR }
          : {}),
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        OPENCODE_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(SANDBOX_CONFIG),
        // Enables the `ollama-cloud` provider for the pinned test model
        // (env-gated on models.dev) — see the header and `test-model.ts`.
        ...(process.env.OLLAMA_API_KEY !== undefined
          ? { OLLAMA_API_KEY: process.env.OLLAMA_API_KEY }
          : {}),
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

  // Give `serve` a moment to announce a self-generated password before the
  // first health probe, so the announced value (if any) is used from the
  // start rather than after a round of 401s.
  const announceDeadline = Date.now() + 10_000;
  while (Date.now() < announceDeadline && !hasExited(child)) {
    if (/^server (password|listening)/m.test(logChunks.join(""))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const authHeader = basicAuthHeader(
    parseAnnouncedPassword(logChunks.join("")) ?? password,
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
    mode: "spawned",
    baseUrl,
    authHeader,
    workdir,
    authAvailable,
    defaultModel: await fetchDefaultModel(baseUrl, authHeader),
    serveCommand,
    stop: async () => {
      await writeFile(logFile, logChunks.join(""), "utf8").catch(() => {});
      if (hasExited(child)) {
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
