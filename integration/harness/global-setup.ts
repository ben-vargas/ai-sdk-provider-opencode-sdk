/**
 * Vitest global setup for the integration suite: start one `opencode2`
 * server for the whole run and provide its endpoint to tests via
 * `inject(...)`. When the harness cannot come up (CLI devDependency missing
 * or at the wrong build, port/health failure), it provides an unavailability
 * reason instead and every test auto-skips with that message — the suite
 * never hard-fails on missing infrastructure.
 *
 * Alongside the endpoint it resolves the model generation tests should use
 * (env override → pinned test model → server default; see `test-model.ts`)
 * and provides both that and the raw server default — the latter feeds the
 * `default-model.test.ts` canary.
 */
import type { TestProject } from "vitest/node";
import {
  startBetaServer,
  type BetaServerHandle,
  type ServeCommand,
} from "./beta-server.js";
import { resolveTestModel, type ResolvedTestModel } from "./test-model.js";

declare module "vitest" {
  export interface ProvidedContext {
    opencodeBaseUrl: string | null;
    opencodeAuthHeader: string;
    opencodeWorkdir: string;
    opencodeAuthAvailable: boolean;
    opencodeDefaultModel: { providerID: string; modelID: string } | null;
    opencodeTestModel: ResolvedTestModel | null;
    opencodeServeCommand: ServeCommand | null;
    opencodeUnavailableReason: string | null;
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  let handle: BetaServerHandle | undefined;
  try {
    handle = await startBetaServer();
    const testModel = await resolveTestModel({
      baseUrl: handle.baseUrl,
      authHeader: handle.authHeader,
      workdir: handle.workdir,
      defaultModel: handle.defaultModel ?? null,
      mode: handle.mode,
    });
    project.provide("opencodeBaseUrl", handle.baseUrl);
    project.provide("opencodeAuthHeader", handle.authHeader);
    project.provide("opencodeWorkdir", handle.workdir);
    project.provide("opencodeAuthAvailable", handle.authAvailable);
    project.provide("opencodeDefaultModel", handle.defaultModel ?? null);
    project.provide("opencodeTestModel", testModel);
    project.provide("opencodeServeCommand", handle.serveCommand ?? null);
    project.provide("opencodeUnavailableReason", null);
    console.log(
      `[integration] opencode2 server ready at ${handle.baseUrl} ` +
        `(test model: ${testModel ? `${testModel.providerID}/${testModel.modelID} [${testModel.source}]` : "NONE — generation tests will skip"}, ` +
        `default model: ${handle.defaultModel ? `${handle.defaultModel.providerID}/${handle.defaultModel.modelID}` : "unknown"}, ` +
        `zen: ${handle.authAvailable ? "yes" : "NO"})`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    project.provide("opencodeBaseUrl", null);
    project.provide("opencodeAuthHeader", "");
    project.provide("opencodeWorkdir", "");
    project.provide("opencodeAuthAvailable", false);
    project.provide("opencodeDefaultModel", null);
    project.provide("opencodeTestModel", null);
    project.provide("opencodeServeCommand", null);
    project.provide("opencodeUnavailableReason", reason);
    console.warn(
      `[integration] opencode2 harness unavailable — all integration tests will skip.\n` +
        `[integration] reason: ${reason}`,
    );
  }
  return async () => {
    await handle?.stop();
  };
}
