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
 * Model IDs sourced from official documentation:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
 * - Google: https://ai.google.dev/gemini-api/docs/models
 * - OpenAI: https://platform.openai.com/docs/models
 */
export const OpencodeModels = {
  // Anthropic models (Claude 4.5 series)
  "claude-sonnet-4-5": "anthropic/claude-sonnet-4-5-20250929",
  "claude-haiku-4-5": "anthropic/claude-haiku-4-5-20251001",
  "claude-opus-4-5": "anthropic/claude-opus-4-5-20251101",

  // OpenAI models
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o-mini": "openai/gpt-4o-mini",

  // Google Gemini models
  "gemini-3-pro": "google/gemini-3-pro-preview",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  "gemini-2.5-pro": "google/gemini-2.5-pro",
  "gemini-2.0-flash": "google/gemini-2.0-flash",
} as const;

export type OpencodeModelShortcut = keyof typeof OpencodeModels;
