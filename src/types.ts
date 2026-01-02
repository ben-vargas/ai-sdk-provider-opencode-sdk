import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";

/**
 * Model ID format for OpenCode provider.
 * Can be:
 * - "providerID/modelID" (e.g., "anthropic/claude-opus-4-5-20251101")
 * - "modelID" (e.g., "claude-opus-4-5-20251101" - uses default provider)
 */
export type OpencodeModelId = string;

/**
 * Logger interface for the OpenCode provider.
 */
export interface Logger {
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Settings for individual model instances.
 */
export interface OpencodeSettings {
  /**
   * Resume an existing session by ID.
   * If not provided, a new session will be created on first request.
   */
  sessionId?: string;

  /**
   * Force creation of a new session, even if one already exists.
   * @default false
   */
  createNewSession?: boolean;

  /**
   * Title for newly created sessions.
   * @default "AI SDK Session"
   */
  sessionTitle?: string;

  /**
   * Agent to use for requests.
   * Options: "build", "plan", "general", "explore", or custom agent name.
   */
  agent?: string;

  /**
   * Custom system prompt to use.
   * This overrides the default agent system prompt.
   */
  systemPrompt?: string;

  /**
   * Enable or disable specific tools.
   * Keys are tool names, values are boolean (enabled/disabled).
   * @example { "Bash": true, "Write": false }
   */
  tools?: Record<string, boolean>;

  /**
   * Working directory for file operations.
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Logger instance or false to disable logging.
   */
  logger?: Logger | false;

  /**
   * Enable verbose logging.
   * @default false
   */
  verbose?: boolean;
}

/**
 * Provider-level settings applied to all model instances.
 */
export interface OpencodeProviderSettings {
  /**
   * Hostname for the OpenCode server.
   * @default "127.0.0.1"
   */
  hostname?: string;

  /**
   * Port for the OpenCode server.
   * @default 4096
   */
  port?: number;

  /**
   * Full URL to the OpenCode server.
   * If provided, overrides hostname and port.
   */
  baseUrl?: string;

  /**
   * Automatically start the OpenCode server if not running.
   * @default true
   */
  autoStartServer?: boolean;

  /**
   * Timeout in milliseconds for server startup.
   * @default 10000
   */
  serverTimeout?: number;

  /**
   * Default settings applied to all model instances.
   * Can be overridden per-model.
   */
  defaultSettings?: OpencodeSettings;
}

/**
 * Provider interface for OpenCode.
 */
export interface OpencodeProvider extends ProviderV3 {
  /**
   * Create a language model instance.
   * @param modelId - Model ID in format "providerID/modelID" or "modelID"
   * @param settings - Optional settings for this model instance
   */
  (modelId: OpencodeModelId, settings?: OpencodeSettings): LanguageModelV3;

  /**
   * Create a language model instance.
   * @param modelId - Model ID in format "providerID/modelID" or "modelID"
   * @param settings - Optional settings for this model instance
   */
  languageModel(
    modelId: OpencodeModelId,
    settings?: OpencodeSettings,
  ): LanguageModelV3;

  /**
   * Alias for languageModel().
   * @param modelId - Model ID in format "providerID/modelID" or "modelID"
   * @param settings - Optional settings for this model instance
   */
  chat(modelId: OpencodeModelId, settings?: OpencodeSettings): LanguageModelV3;
}

/**
 * Parsed model ID containing provider and model components.
 */
export interface ParsedModelId {
  providerID: string;
  modelID: string;
}

/**
 * Metadata returned in provider responses.
 */
export interface OpencodeProviderMetadata {
  opencode: {
    sessionId: string;
    messageId?: string;
    cost?: number;
    reasoning?: string;
  };
}

/**
 * Tool state tracking for streaming.
 */
export interface ToolStreamState {
  callId: string;
  toolName: string;
  inputStarted: boolean;
  inputClosed: boolean;
  callEmitted: boolean;
  resultEmitted: boolean;
  lastInput?: string;
}

/**
 * Accumulated usage data during streaming.
 */
export interface StreamingUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cachedWriteTokens: number;
  totalCost: number;
}
