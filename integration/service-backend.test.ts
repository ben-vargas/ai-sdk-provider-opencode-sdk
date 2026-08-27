/**
 * Service-discovery backend against a REAL `opencode2 serve --service`
 * (stage-6 bonus verification, retargeted in stage-9): the v2 CLI's
 * `--service` mode — broken on the *v1* `opencode-ai` CLI (spike finding
 * 0.1) — writes a registration file whose endpoint `Service.discover`
 * resolves, including the Basic-auth credential the provider merges
 * automatically.
 *
 * The test spawns its own service instance with a fully separate sandbox
 * (own XDG homes, own fake HOME, own SQLite database, minimal environment —
 * mirroring the isolation rules in `harness/beta-server.ts`) so it cannot
 * contend with the shared harness server or reach real user configuration.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  integrationContext,
  pollUntil,
  suiteTitle,
} from "./harness/context.js";

const ctx = integrationContext();

const canRun = ctx.canGenerate && ctx.serveCommand !== null;
const suiteReason = canRun
  ? ""
  : ctx.reason !== ""
    ? ctx.reason
    : "no serve command available from the harness";

describe.skipIf(!canRun)(
  suiteTitle("service backend (serve --service)", {
    ...ctx,
    reason: suiteReason,
  }),
  () => {
    // Outside the real home: the server's config discovery walks upward
    // from the workdir to the filesystem root.
    const sandbox = join(tmpdir(), "opencode-beta-service-sandbox");
    let stopChild: (() => Promise<void>) | undefined;

    afterAll(async () => {
      await stopChild?.();
    });

    it("discovers a --service registration and generates through it", async () => {
      // Fresh, dedicated sandbox for the service instance.
      await rm(sandbox, { recursive: true, force: true });
      const dataHome = join(sandbox, "data");
      const stateHome = join(sandbox, "state");
      const workdir = join(sandbox, "workdir");
      const homeDir = join(sandbox, "home");
      await Promise.all(
        [
          join(dataHome, "opencode"),
          stateHome,
          join(sandbox, "config"),
          join(sandbox, "cache"),
          workdir,
          homeDir,
        ].map((dir) => mkdir(dir, { recursive: true })),
      );
      const authSource = join(homedir(), ".local", "share", "opencode");
      for (const file of ["auth.json", "account.json"]) {
        if (existsSync(join(authSource, file))) {
          await copyFile(
            join(authSource, file),
            join(dataHome, "opencode", file),
          );
        }
      }

      // `--service` binds the channel's fixed default port unless the
      // service config overrides it — pre-seed a free port so the test
      // cannot collide with a real local opencode service.
      const port = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          if (address === null || typeof address === "string") {
            reject(new Error("no port assigned"));
            return;
          }
          probe.close(() => resolve(address.port));
        });
      });
      await mkdir(join(sandbox, "config", "opencode"), { recursive: true });
      await writeFile(
        join(sandbox, "config", "opencode", "service-local.json"),
        JSON.stringify({ port }) + "\n",
        "utf8",
      );

      // Same launcher the harness uses, so this works on both the
      // published-binary path and the opt-in source fallback.
      const serve = ctx.serveCommand;
      if (serve === null) {
        throw new Error(
          "serve command unavailable (suite should have skipped)",
        );
      }
      const child = spawn(
        serve.command,
        [...serve.args, "serve", "--service"],
        {
          cwd: workdir,
          // Minimal allowlisted environment + fake HOME, matching the
          // harness server's isolation rules.
          env: {
            PATH: process.env.PATH ?? "",
            HOME: homeDir,
            OPENCODE_TEST_HOME: homeDir,
            ...(process.env.TMPDIR !== undefined
              ? { TMPDIR: process.env.TMPDIR }
              : {}),
            XDG_DATA_HOME: dataHome,
            XDG_STATE_HOME: stateHome,
            XDG_CONFIG_HOME: join(sandbox, "config"),
            XDG_CACHE_HOME: join(sandbox, "cache"),
          },
          stdio: "ignore",
        },
      );
      stopChild = async () => {
        // signalCode check: a signal-killed child keeps exitCode === null,
        // and waiting on "exit" after the fact would hang teardown.
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          });
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
          await exited;
          clearTimeout(killTimer);
        }
      };

      // `--service` writes the registration once the server is listening.
      const registrationFile = join(
        stateHome,
        "opencode",
        "service-local.json",
      );
      await pollUntil(
        async () => (existsSync(registrationFile) ? true : undefined),
        { timeoutMs: 60_000, label: "service registration file appears" },
      );

      const provider = ctx.makeProvider({
        baseUrl: undefined,
        clientOptions: undefined,
        service: { file: registrationFile },
        defaultSettings: { location: { directory: workdir } },
      });
      try {
        const model = provider(ctx.modelId);
        const result = await model.doGenerate({
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: "Reply with exactly: SERVICE" }],
            },
          ],
        });
        expect(result.finishReason.unified).toBe("stop");
        const manager = provider.getClientManager();
        expect(manager.getServerUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      } finally {
        await provider.dispose();
      }
    }, 180_000);
  },
);
