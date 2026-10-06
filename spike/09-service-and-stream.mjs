// Review-gap captures (findings doc 0.1 / Q7 previously asserted these
// without artifacts):
//  a) `opencode serve --service` on the dev CLI: capture stdout/stderr + exit.
//  b) Registration file: does $XDG_STATE_HOME/opencode/service.json exist while
//     a plain `serve` is running? What does Service.discover() return?
//  c) CLI versions actually installed (dev CLI + beta-cli sandbox install),
//     since /doc only reports info.version "1.0.0".
//  d) Q7: break out of the `for await` event loop (no abort) — does the
//     iterator/connection close cleanly and the server stay healthy?
// Requires the dev server already running on :14096 (see findings doc repro).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { client, capture, saveArtifact, sleep } from "./lib.mjs";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = join(ROOT, "spike", "sandbox");
const CLI = join(ROOT, "node_modules", ".bin", "opencode");
const XDG_ENV = {
  ...process.env,
  XDG_DATA_HOME: join(SANDBOX, "data"),
  XDG_STATE_HOME: join(SANDBOX, "state"),
  XDG_CONFIG_HOME: join(SANDBOX, "config"),
  XDG_CACHE_HOME: join(SANDBOX, "cache"),
};

const results = {};

async function run(label, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(CLI, args, {
      env: XDG_ENV,
      cwd: join(SANDBOX, "workdir"),
      timeout: opts.timeout ?? 15000,
      killSignal: "SIGKILL",
    });
    return { label, exit: 0, stdout, stderr };
  } catch (error) {
    return {
      label,
      exit: error.code ?? null,
      killed: error.killed ?? false,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

// (c) versions
results.devCliVersion = await run("dev-cli --version", ["--version"]);
const betaCliBin = join(ROOT, "spike", "beta-cli", "node_modules", ".bin", "opencode");
results.betaCliVersion = existsSync(betaCliBin)
  ? await (async () => {
      try {
        const { stdout, stderr } = await execFileP(betaCliBin, ["--version"], {
          env: XDG_ENV,
          timeout: 15000,
        });
        return { exit: 0, stdout, stderr };
      } catch (error) {
        return { exit: error.code ?? null, stdout: error.stdout, stderr: error.stderr };
      }
    })()
  : "beta-cli not installed at spike/beta-cli";

// (a) serve --service (10s timeout: if yargs rejects the flag it exits fast;
// if it actually started serving, the timeout kill tells us that instead).
results.serveService = await run(
  "serve --service",
  ["serve", "--service", "--port", "14097"],
  { timeout: 10000 },
);
results.serveHelp = await run("serve --help", ["serve", "--help"]);

// (b) registration file + discover, while the plain `serve` on :14096 runs.
const regPath = join(SANDBOX, "state", "opencode", "service.json");
results.registrationFile = {
  path: regPath,
  exists: existsSync(regPath),
  contents: existsSync(regPath) ? readFileSync(regPath, "utf8") : null,
};
results.discover = await capture("Service.discover", async () => {
  const { Service } = await import("@opencode-ai/client/service");
  return await Service.discover();
});

// (d) loop-break: consume events, then `break` (no AbortController).
results.loopBreak = await capture("for-await break", async () => {
  const seen = [];
  const startedAt = Date.now();
  for await (const event of client.event.subscribe()) {
    seen.push(event.type);
    break; // Q7: does breaking the loop close the connection cleanly?
  }
  const brokeAfterMs = Date.now() - startedAt;
  // If break leaked the connection/iterator, node would keep the process
  // alive; also verify the server still answers.
  const health = await fetch("http://127.0.0.1:14096/api/health").then((r) => r.status);
  return { seen, brokeAfterMs, healthAfterBreak: health };
});

saveArtifact("09-service-and-stream", results);
for (const [k, v] of Object.entries(results)) {
  console.log(k, JSON.stringify(v).slice(0, 160));
}
