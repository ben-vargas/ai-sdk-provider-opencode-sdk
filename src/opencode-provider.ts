import type { LanguageModelV3 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import type {
  OpencodeModelId,
  OpencodeSettings,
  OpencodeProviderSettings,
  OpencodeProvider,
} from "./types.js";
import { OpencodeLanguageModel } from "./opencode-language-model.js";
import {
  OpencodeClientManager,
  createClientManagerFromSettings,
} from "./opencode-client-manager.js";
import { validateProviderSettings, mergeSettings } from "./validation.js";
import { getLogger } from "./logger.js";

/**
 * Create an OpenCode provider.
 *
 * @param options - Provider settings
 * @returns OpenCode provider instance
 *
 * @example
 * ```ts
 * import { createOpencode } from 'ai-sdk-provider-opencode-sdk';
 *
 * const opencode = createOpencode();
 * const model = opencode('anthropic/claude-opus-4-5-20251101');
 *
 * // Or with settings
 * const opencode = createOpencode({
 *   hostname: 'localhost',
 *   port: 4096,
 *   defaultSettings: { agent: 'build' }
 * });
 * ```
 */
export function createOpencode(
  options?: OpencodeProviderSettings,
): OpencodeProvider {
  const logger = getLogger(options?.defaultSettings?.logger);

  // Validate provider settings
  const { warnings } = validateProviderSettings(options, logger);

  // Log any validation warnings
  for (const warning of warnings) {
    logger.warn(warning);
  }

  // Create client manager
  const clientManager = createClientManagerFromSettings(options ?? {}, logger);

  /**
   * Create a language model instance.
   */
  const createModel = (
    modelId: OpencodeModelId,
    settings?: OpencodeSettings,
  ): LanguageModelV3 => {
    // Merge default settings with provided settings
    const mergedSettings = mergeSettings(options?.defaultSettings, settings);

    return new OpencodeLanguageModel({
      modelId,
      settings: mergedSettings,
      clientManager,
    });
  };

  // Create provider function that's also an object with methods
  const provider = Object.assign(
    // Main callable function
    (
      modelId: OpencodeModelId,
      settings?: OpencodeSettings,
    ): LanguageModelV3 => {
      return createModel(modelId, settings);
    },
    {
      // languageModel method
      languageModel: (
        modelId: OpencodeModelId,
        settings?: OpencodeSettings,
      ): LanguageModelV3 => {
        return createModel(modelId, settings);
      },

      // chat alias for languageModel
      chat: (
        modelId: OpencodeModelId,
        settings?: OpencodeSettings,
      ): LanguageModelV3 => {
        return createModel(modelId, settings);
      },

      // Provider info
      provider: "opencode" as const,
      specificationVersion: "v3" as const,

      // Required ProviderV3 methods that are not supported
      embeddingModel: (modelId: string): never => {
        throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
      },
      imageModel: (modelId: string): never => {
        throw new NoSuchModelError({ modelId, modelType: "imageModel" });
      },

      // Get the client manager (for advanced usage)
      getClientManager: (): OpencodeClientManager => {
        return clientManager;
      },

      // Dispose resources
      dispose: async (): Promise<void> => {
        await clientManager.dispose();
      },
    },
  );

  return provider as OpencodeProvider;
}

/**
 * Default OpenCode provider instance.
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
  // Anthropic models (Claude 4.5 series - latest)
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
