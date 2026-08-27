/**
 * Vitest global setup for the integration suite: start one beta-source
 * server for the whole run and provide its endpoint to tests via
 * `inject(...)`. When the harness cannot come up (no bun, clone/build
 * failure, no network), it provides an unavailability reason instead and
 * every test auto-skips with that message — the suite never hard-fails on
 * missing infrastructure.
 */
import type { TestProject } from "vitest/node";
import { startBetaServer, type BetaServerHandle } from "./beta-server.js";

declare module "vitest" {
  export interface ProvidedContext {
    opencodeBaseUrl: string | null;
    opencodeAuthHeader: string;
    opencodeWorkdir: string;
    opencodeAuthAvailable: boolean;
    opencodeDefaultModel: { providerID: string; modelID: string } | null;
    opencodeUnavailableReason: string | null;
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  let handle: BetaServerHandle | undefined;
  try {
    handle = await startBetaServer();
    project.provide("opencodeBaseUrl", handle.baseUrl);
    project.provide("opencodeAuthHeader", handle.authHeader);
    project.provide("opencodeWorkdir", handle.workdir);
    project.provide("opencodeAuthAvailable", handle.authAvailable);
    project.provide("opencodeDefaultModel", handle.defaultModel ?? null);
    project.provide("opencodeUnavailableReason", null);
    console.log(
      `[integration] beta-source server ready at ${handle.baseUrl} ` +
        `(default model: ${handle.defaultModel ? `${handle.defaultModel.providerID}/${handle.defaultModel.modelID}` : "unknown"}, ` +
        `zen auth: ${handle.authAvailable ? "yes" : "NO — generation tests will skip"})`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    project.provide("opencodeBaseUrl", null);
    project.provide("opencodeAuthHeader", "");
    project.provide("opencodeWorkdir", "");
    project.provide("opencodeAuthAvailable", false);
    project.provide("opencodeDefaultModel", null);
    project.provide("opencodeUnavailableReason", reason);
    console.warn(
      `[integration] beta-source harness unavailable — all integration tests will skip.\n` +
        `[integration] reason: ${reason}`,
    );
  }
  return async () => {
    await handle?.stop();
  };
}
