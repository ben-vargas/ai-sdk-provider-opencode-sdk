import { z } from 'zod';
import type { OpencodeSettings, OpencodeProviderSettings, Logger } from './types.js';

/**
 * Schema for Logger interface.
 */
const loggerSchema = z.object({
  warn: z.function().args(z.string()).returns(z.void()),
  error: z.function().args(z.string()).returns(z.void()),
  debug: z.function().args(z.string()).returns(z.void()).optional(),
});

/**
 * Schema for OpencodeSettings.
 */
export const opcodeSettingsSchema = z.object({
  sessionId: z.string().optional(),
  createNewSession: z.boolean().optional(),
  sessionTitle: z.string().optional(),
  agent: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  cwd: z.string().optional(),
  logger: z.union([loggerSchema, z.literal(false)]).optional(),
  verbose: z.boolean().optional(),
});

/**
 * Schema for OpencodeProviderSettings.
 */
export const opcodeProviderSettingsSchema = z.object({
  hostname: z.string().optional(),
  port: z.number().int().positive().optional(),
  baseUrl: z.string().url().optional(),
  autoStartServer: z.boolean().optional(),
  serverTimeout: z.number().int().positive().optional(),
  defaultSettings: opcodeSettingsSchema.optional(),
});

/**
 * Validation result with warnings.
 */
export interface ValidationResult<T> {
  value: T;
  warnings: string[];
}

/**
 * Validate OpencodeSettings.
 */
export function validateSettings(
  settings: OpencodeSettings | undefined,
  logger?: Logger | false
): ValidationResult<OpencodeSettings> {
  const warnings: string[] = [];

  if (!settings) {
    return { value: {}, warnings };
  }

  // Validate with Zod
  const result = opcodeSettingsSchema.safeParse(settings);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    warnings.push(`Settings validation warnings: ${issues.join('; ')}`);
  }

  // Validate session ID format if provided
  if (settings.sessionId && !isValidSessionId(settings.sessionId)) {
    warnings.push(`Invalid session ID format: ${settings.sessionId}`);
  }

  // Log warnings if logger is provided
  if (logger && warnings.length > 0) {
    for (const warning of warnings) {
      logger.warn(warning);
    }
  }

  return { value: settings, warnings };
}

/**
 * Validate OpencodeProviderSettings.
 */
export function validateProviderSettings(
  settings: OpencodeProviderSettings | undefined,
  logger?: Logger | false
): ValidationResult<OpencodeProviderSettings> {
  const warnings: string[] = [];

  if (!settings) {
    return { value: {}, warnings };
  }

  // Validate with Zod
  const result = opcodeProviderSettingsSchema.safeParse(settings);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    warnings.push(`Provider settings validation warnings: ${issues.join('; ')}`);
  }

  // Validate port range
  if (settings.port !== undefined && (settings.port < 1 || settings.port > 65535)) {
    warnings.push(`Port ${settings.port} is outside valid range (1-65535)`);
  }

  // Validate timeout
  if (settings.serverTimeout !== undefined && settings.serverTimeout < 1000) {
    warnings.push(`Server timeout ${settings.serverTimeout}ms is very short, consider at least 5000ms`);
  }

  // Log warnings if logger is provided
  if (logger && warnings.length > 0) {
    for (const warning of warnings) {
      logger.warn(warning);
    }
  }

  return { value: settings, warnings };
}

/**
 * Validate model ID format.
 * @returns Object with providerID and modelID, or null if invalid.
 */
export function validateModelId(
  modelId: string,
  logger?: Logger | false
): { providerID: string; modelID: string } | null {
  if (!modelId || typeof modelId !== 'string' || modelId.trim().length === 0) {
    if (logger) {
      logger.error('Model ID is required and must be a non-empty string');
    }
    return null;
  }

  const trimmedId = modelId.trim();

  // Check for provider/model format
  if (trimmedId.includes('/')) {
    const parts = trimmedId.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return {
        providerID: parts[0],
        modelID: parts[1],
      };
    }
    if (logger) {
      logger.warn(`Model ID "${modelId}" contains multiple slashes, using last segment as model`);
    }
    const lastPart = parts[parts.length - 1];
    const providerParts = parts.slice(0, -1).join('/');
    return {
      providerID: providerParts || 'default',
      modelID: lastPart || trimmedId,
    };
  }

  // Just model ID without provider - will use default provider
  return {
    providerID: '',
    modelID: trimmedId,
  };
}

/**
 * Check if a session ID is valid.
 * Session IDs are typically UUIDs or similar alphanumeric strings.
 */
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }

  // Allow UUIDs, alphanumeric strings, and strings with hyphens/underscores
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return validPattern.test(sessionId) && sessionId.length > 0 && sessionId.length <= 128;
}

/**
 * Merge settings with defaults.
 */
export function mergeSettings(
  defaults: OpencodeSettings | undefined,
  overrides: OpencodeSettings | undefined
): OpencodeSettings {
  if (!defaults && !overrides) {
    return {};
  }

  if (!defaults) {
    return { ...overrides };
  }

  if (!overrides) {
    return { ...defaults };
  }

  return {
    ...defaults,
    ...overrides,
    // Merge tools object if both exist
    tools:
      defaults.tools || overrides.tools
        ? { ...defaults.tools, ...overrides.tools }
        : undefined,
  };
}
