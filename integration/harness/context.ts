/**
 * Shared per-file plumbing for integration tests: reads the harness endpoint
 * provided by global-setup and builds real providers against it. Every test
 * file gates on `ctx.available` (harness up) and — for tests that hit a
 * model — `ctx.canGenerate` (zen credentials + a resolvable default model).
 */
import { inject } from "vitest";
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client";
import { createOpencode } from "../../src/index.js";
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
  /** Generation-capable: harness up + zen auth + default model known. */
  canGenerate: boolean;
  baseUrl: string;
  authHeader: string;
  /** Sandbox directory every session must bind to. */
  workdir: string;
  /** `providerID/modelID` of the server default (cheapest zen free model). */
  modelId: string;
  /** Model settings every test should start from (sandbox location). */
  baseSettings: OpencodeSettings;
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
  const unavailableReason = inject("opencodeUnavailableReason");

  const available = baseUrl !== null;
  const modelId =
    defaultModel === null
      ? ""
      : `${defaultModel.providerID}/${defaultModel.modelID}`;
  const reason = !available
    ? `beta-source harness unavailable: ${unavailableReason ?? "unknown"}`
    : !authAvailable
      ? "no zen credentials in the local opencode data home — generation tests skip"
      : modelId === ""
        ? "server default model unavailable — generation tests skip"
        : "";

  const baseSettings: OpencodeSettings = {
    location: { directory: workdir },
    sessionTitle: "integration-test",
  };

  return {
    available,
    reason,
    canGenerate: available && authAvailable && modelId !== "",
    baseUrl: baseUrl ?? "",
    authHeader,
    workdir,
    modelId,
    baseSettings,
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
