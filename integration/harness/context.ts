/**
 * Shared per-file plumbing for integration tests: reads the harness endpoint
 * provided by global-setup and builds real providers against it. Every test
 * file gates on `ctx.available` (harness up) and — for tests that hit a
 * model — `ctx.canGenerate` (a probe-verified test model was resolved; see
 * `test-model.ts` for the env-override → pin → server-default order).
 */
import { inject } from "vitest";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { createOpencode } from "../../src/index.js";
import type { ServeCommand } from "./beta-server.js";
import type {
  OpencodeProvider,
  OpencodeProviderSettings,
  OpencodeSettings,
} from "../../src/index.js";

export interface IntegrationContext {
  /** Harness came up; endpoint fields below are valid. */
  available: boolean;
  /** Why the harness is unavailable (skip message). */
  reason: string;
  /** Generation-capable: harness up + a probe-verified test model. */
  canGenerate: boolean;
  baseUrl: string;
  authHeader: string;
  /** Sandbox directory every session must bind to. */
  workdir: string;
  /** `providerID/modelID` of the resolved, probe-verified test model. */
  modelId: string;
  /** `providerID/modelID` of the server's own default model (canary only). */
  defaultModelId: string;
  /** Zen credentials were copied into the sandbox (default model usable). */
  authAvailable: boolean;
  /** Model settings every test should start from (sandbox location). */
  baseSettings: OpencodeSettings;
  /** How the harness starts a server, for tests that spawn a variant. */
  serveCommand: ServeCommand | null;
  /** Provider factory preconfigured for the harness endpoint. */
  makeProvider: (overrides?: OpencodeProviderSettings) => OpencodeProvider;
  /** Raw pinned client on the same endpoint, for server-side assertions. */
  makeRawClient: () => OpenCodeClient;
}

/** Suite title with the skip reason appended when the suite will skip. */
export function suiteTitle(name: string, ctx: IntegrationContext): string {
  return ctx.reason === "" ? name : `${name} (skipped: ${ctx.reason})`;
}

export function integrationContext(): IntegrationContext {
  const baseUrl = inject("opencodeBaseUrl");
  const authHeader = inject("opencodeAuthHeader");
  const workdir = inject("opencodeWorkdir");
  const authAvailable = inject("opencodeAuthAvailable");
  const defaultModel = inject("opencodeDefaultModel");
  const testModel = inject("opencodeTestModel");
  const serveCommand = inject("opencodeServeCommand");
  const unavailableReason = inject("opencodeUnavailableReason");

  const available = baseUrl !== null;
  const modelId =
    testModel === null ? "" : `${testModel.providerID}/${testModel.modelID}`;
  const defaultModelId =
    defaultModel === null
      ? ""
      : `${defaultModel.providerID}/${defaultModel.modelID}`;
  const reason = !available
    ? `opencode2 harness unavailable: ${unavailableReason ?? "unknown"}`
    : modelId === ""
      ? "no probe-verified test model (see the [integration] setup log) — generation tests skip"
      : "";

  const baseSettings: OpencodeSettings = {
    location: { directory: workdir },
    sessionTitle: "integration-test",
  };

  return {
    available,
    reason,
    canGenerate: available && modelId !== "",
    baseUrl: baseUrl ?? "",
    authHeader,
    workdir,
    modelId,
    defaultModelId,
    authAvailable,
    baseSettings,
    serveCommand,
    makeProvider: (overrides = {}) =>
      createOpencode({
        baseUrl: baseUrl ?? "",
        clientOptions: { headers: { Authorization: authHeader } },
        ...overrides,
        defaultSettings: { ...baseSettings, ...overrides.defaultSettings },
      }),
    makeRawClient: () =>
      OpenCode.make({
        baseUrl: baseUrl ?? "",
        headers: { Authorization: authHeader },
      }),
  };
}

/** Poll until `fn` returns a value (undefined = keep polling). */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  { timeoutMs = 90_000, intervalMs = 1000, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Parse `providerID/modelID` (integration model ids always carry both). */
export function parseModelRef(modelId: string): {
  providerID: string;
  modelID: string;
} {
  const slash = modelId.indexOf("/");
  return {
    providerID: modelId.slice(0, slash),
    modelID: modelId.slice(slash + 1),
  };
}

/** Collect a LanguageModelV4 stream into an array of parts. */
export async function collectStream<T>(result: {
  stream: ReadableStream<T>;
}): Promise<T[]> {
  const parts: T[] = [];
  const reader = result.stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return parts;
    }
    parts.push(value);
  }
}
