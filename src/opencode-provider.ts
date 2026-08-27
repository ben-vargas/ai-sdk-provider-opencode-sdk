/**
 * `createOpencode` provider factory: the public entrypoint that wires
 * provider settings → client-manager backend → `OpencodeLanguageModel`.
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import { createClientManagerFromSettings } from "./opencode-client-manager.js";
import { OpencodeLanguageModel } from "./opencode-language-model.js";
import { getLogger } from "./logger.js";
import type {
  OpencodeClientManager,
  OpencodeModelId,
  OpencodeProvider,
  OpencodeProviderSettings,
  OpencodeSettings,
} from "./types.js";
import { mergeSettings, validateProviderSettings } from "./validation.js";

/**
 * Create an OpenCode provider.
 *
 * Model instances are NOT cached: every call to the provider (or
 * `languageModel`/`chat`) returns a fresh `OpencodeLanguageModel`. One model
 * instance = one conversation = one pinned OpenCode session — reuse the same
 * instance for every call in a conversation (tool-approval continuation
 * calls must reattach to the instance's blocked session), and create a new
 * instance for a new conversation. `providerOptions.opencode.sessionId` is
 * the per-call escape hatch for callers managing sessions themselves.
 *
 * @param options - Provider settings (backend selection, defaults)
 * @returns OpenCode provider instance
 *
 * @example
 * ```ts
 * import { createOpencode } from 'ai-sdk-provider-opencode-sdk';
 *
 * // Explicit server URL
 * const opencode = createOpencode({ baseUrl: 'http://localhost:4096' });
 * const model = opencode('anthropic/claude-opus-4-5-20251101');
 *
 * // Or local-service discovery with defaults
 * const opencode = createOpencode({
 *   service: { file: '/path/to/registration.json' },
 *   defaultSettings: { agent: 'build' },
 * });
 * ```
 */
export function createOpencode(
  options?: OpencodeProviderSettings,
): OpencodeProvider {
  const logger = getLogger(
    options?.defaultSettings?.logger,
    options?.defaultSettings?.verbose,
  );

  validateProviderSettings(options, logger);

  // An injected manager is caller-owned: the provider uses it but never
  // disposes it. Caller-supplied clients are wrapped in a provider-owned
  // manager whose disposal still never closes the client itself.
  const usesInjectedManager =
    options?.clientManager !== undefined && options?.client === undefined;
  const clientManager = createClientManagerFromSettings(options ?? {}, logger);

  const createModel = (
    modelId: OpencodeModelId,
    settings?: OpencodeSettings,
  ): LanguageModelV4 => {
    const mergedSettings = mergeSettings(options?.defaultSettings, settings);
    return new OpencodeLanguageModel(modelId, mergedSettings, {
      provider: "opencode",
      getPort: () => clientManager.getPort(),
    });
  };

  const provider = Object.assign(
    (
      modelId: OpencodeModelId,
      settings?: OpencodeSettings,
    ): LanguageModelV4 => {
      return createModel(modelId, settings);
    },
    {
      provider: "opencode" as const,
      specificationVersion: "v4" as const,

      languageModel: (
        modelId: OpencodeModelId,
        settings?: OpencodeSettings,
      ): LanguageModelV4 => {
        return createModel(modelId, settings);
      },

      chat: (
        modelId: OpencodeModelId,
        settings?: OpencodeSettings,
      ): LanguageModelV4 => {
        return createModel(modelId, settings);
      },

      embeddingModel: (modelId: string): never => {
        throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
      },
      imageModel: (modelId: string): never => {
        throw new NoSuchModelError({ modelId, modelType: "imageModel" });
      },

      getClientManager: (): OpencodeClientManager => {
        return clientManager;
      },

      dispose: async (): Promise<void> => {
        if (!usesInjectedManager) {
          await clientManager.dispose();
        }
      },
    },
  );

  return provider as OpencodeProvider;
}

/**
 * Default OpenCode provider instance (local-service discovery backend).
 *
 * @example
 * ```ts
 * import { opencode } from 'ai-sdk-provider-opencode-sdk';
 *
 * const model = opencode('anthropic/claude-opus-4-5-20251101');
 * ```
 */
export const opencode = createOpencode();

/**
 * Common model shortcuts for convenience.
 *
 * Every ID below is an OpenCode zen free-tier model, cross-checked two ways
 * (snapshot 2026-08-27 UTC):
 *
 * 1. present in a live `model.list` from the beta-source server at commit
 *    `f4a9b930` (the build matching the pinned
 *    `@opencode-ai/client@0.0.0-beta-18286`), stable across repeated polls;
 * 2. present in the upstream models.dev catalog under the `opencode`
 *    provider — i.e. they exist independently of this machine.
 *
 * A live catalog alone is NOT sufficient evidence: it is server-, host- and
 * credential-dependent. Two classes of host-local contamination were found
 * and excluded here — the built-in `ollama` provider plugin discovers models
 * from a local ollama daemon over `http://127.0.0.1:11434` (a channel no
 * XDG/HOME isolation blocks), and the `ollama-cloud` provider unlocks from
 * an ambient `OLLAMA_API_KEY`. Neither yields IDs a user would have. Models
 * from other providers (Anthropic, OpenAI, Google, …) surface only once
 * their credentials are configured on the server, so the v4-era shortcuts
 * for them stay dropped as unverifiable.
 *
 * These shortcuts need zen credentials on the server and are a convenience,
 * not a limit: any `providerID/modelID` string your catalog lists works.
 */
export const OpencodeModels = {
  // OpenCode zen free tier (requires zen credentials on the server)
  "nemotron-3.5-lightning-free": "opencode/nemotron-3.5-lightning-free",
  "muse-spark-1.2-contributor-free": "opencode/muse-spark-1.2-contributor-free",
  "hy3-free": "opencode/hy3-free",
  "nemotron-3-ultra-free": "opencode/nemotron-3-ultra-free",
  "mimo-v2.5-free": "opencode/mimo-v2.5-free",
  "big-pickle": "opencode/big-pickle",
} as const;

export type OpencodeModelShortcut = keyof typeof OpencodeModels;
