import { z } from "zod";
import type {
  Logger,
  OpencodeDataUri,
  OpencodeFormAnswer,
  OpencodeFormRequest,
  OpencodeProviderSettings,
  OpencodeSessionLocation,
  OpencodeSessionMode,
  OpencodeSettings,
} from "./types.js";

/**
 * Schema for Logger interface.
 */
const loggerSchema = z.object({
  warn: z.any().refine((val) => typeof val === "function", {
    message: "warn must be a function",
  }),
  error: z.any().refine((val) => typeof val === "function", {
    message: "error must be a function",
  }),
  debug: z
    .any()
    .refine((val) => val === undefined || typeof val === "function", {
      message: "debug must be a function",
    })
    .optional(),
});

const locationSchema = z
  .object({
    directory: z.string(),
  })
  // OpenCode 2.x dropped workspaces; reject a stale `workspaceID` loudly
  // instead of letting it be stripped and silently ignored.
  .strict();

/**
 * Schema for OpencodeSettings.
 */
export const opcodeSettingsSchema = z.object({
  sessionId: z.string().optional(),
  sessionMode: z.enum(["ephemeral", "existing"]).optional(),
  createNewSession: z.boolean().optional(),
  sessionTitle: z.string().optional(),
  agent: z.string().optional(),
  systemPrompt: z.string().optional(),
  variant: z.string().optional(),
  location: locationSchema.optional(),
  directory: z.string().optional(),
  delivery: z.enum(["steer", "queue"]).optional(),
  resume: z.boolean().optional(),
  onForm: z.function().optional(),
  formPolicy: z.enum(["cancel", "wait"]).optional(),
  resolveFileToUri: z.function().optional(),
  jsonRepair: z
    .object({ maxAttempts: z.number().int().positive().optional() })
    .optional(),
  logger: z.union([loggerSchema, z.literal(false)]).optional(),
  verbose: z.boolean().optional(),
});

const serviceOptionsSchema = z.object({
  file: z.string().optional(),
  version: z.union([z.string(), z.function()]).optional(),
  command: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  onStart: z.function().optional(),
});

/**
 * Schema for OpencodeProviderSettings.
 */
export const opcodeProviderSettingsSchema = z.object({
  client: z.object({}).passthrough().optional(),
  clientManager: z.object({}).passthrough().optional(),
  baseUrl: z.string().url().optional(),
  service: serviceOptionsSchema.optional(),
  autoStart: z.boolean().optional(),
  clientOptions: z
    .object({
      fetch: z.function().optional(),
      headers: z.unknown().optional(),
    })
    .optional(),
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
  logger?: Logger | false,
): ValidationResult<OpencodeSettings> {
  const warnings: string[] = [];

  if (!settings) {
    return { value: {}, warnings };
  }

  // Validate with Zod
  const result = opcodeSettingsSchema.safeParse(settings);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    warnings.push(`Settings validation warnings: ${issues.join("; ")}`);
  }

  // Validate session ID format if provided
  if (settings.sessionId && !isValidSessionId(settings.sessionId)) {
    warnings.push(`Invalid session ID format: ${settings.sessionId}`);
  }

  if (settings.sessionId && settings.sessionMode === "ephemeral") {
    warnings.push(
      'sessionId is ignored in "ephemeral" session mode; use sessionMode "existing" to pin a session',
    );
  }

  if (settings.sessionMode === "existing" && !settings.sessionId) {
    warnings.push(
      'sessionMode "existing" requires a sessionId; falling back to "ephemeral"',
    );
  }

  if (settings.directory !== undefined) {
    warnings.push(
      settings.location !== undefined
        ? "Both directory and location were provided; location takes precedence and directory will be ignored"
        : 'directory is deprecated; use location: { directory: "..." } instead',
    );
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
 * Validate OpencodeProviderSettings, enforcing backend exclusivity:
 * exactly one of `client`, `clientManager`, `baseUrl`, or service discovery
 * is used, with precedence client > clientManager > baseUrl > service.
 */
export function validateProviderSettings(
  settings: OpencodeProviderSettings | undefined,
  logger?: Logger | false,
): ValidationResult<OpencodeProviderSettings> {
  const warnings: string[] = [];

  if (!settings) {
    return { value: {}, warnings };
  }

  // Validate with Zod
  const result = opcodeProviderSettingsSchema.safeParse(settings);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    warnings.push(
      `Provider settings validation warnings: ${issues.join("; ")}`,
    );
  }

  // Backend exclusivity
  if (settings.client && settings.clientManager) {
    warnings.push(
      "Both client and clientManager were provided; client takes precedence and clientManager will be ignored",
    );
  }

  if (settings.clientManager && !settings.client && settings.baseUrl) {
    warnings.push(
      "Both clientManager and baseUrl were provided; clientManager takes precedence and baseUrl will be ignored",
    );
  }

  if (settings.clientManager && !settings.client && settings.service) {
    warnings.push(
      "Both clientManager and service were provided; clientManager takes precedence and service discovery will be skipped",
    );
  }

  if (settings.clientManager && settings.clientOptions) {
    warnings.push(
      "Both clientManager and clientOptions were provided; clientOptions will be ignored because a manager backend supplies its own client",
    );
  }

  if (settings.client && settings.baseUrl) {
    warnings.push(
      "Both client and baseUrl were provided; client takes precedence and baseUrl will be ignored",
    );
  }

  if (settings.client && settings.service) {
    warnings.push(
      "Both client and service were provided; client takes precedence and service discovery will be skipped",
    );
  }

  if (settings.baseUrl && settings.service) {
    warnings.push(
      "Both baseUrl and service were provided; baseUrl takes precedence and service discovery will be skipped",
    );
  }

  if (settings.client && settings.clientOptions) {
    warnings.push(
      "Both client and clientOptions were provided; clientOptions will be ignored because client takes precedence",
    );
  }

  if (
    settings.autoStart &&
    (settings.client || settings.clientManager || settings.baseUrl)
  ) {
    warnings.push(
      "autoStart only applies to the service-discovery backend and will be ignored",
    );
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
  logger?: Logger | false,
): { providerID: string; modelID: string } | null {
  if (!modelId || typeof modelId !== "string" || modelId.trim().length === 0) {
    if (logger) {
      logger.error("Model ID is required and must be a non-empty string");
    }
    return null;
  }

  const trimmedId = modelId.trim();

  // Check for provider/model format
  if (trimmedId.includes("/")) {
    const parts = trimmedId.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return {
        providerID: parts[0],
        modelID: parts[1],
      };
    }
    if (logger) {
      logger.warn(
        `Model ID "${modelId}" contains multiple slashes, using first segment as provider`,
      );
    }
    const firstPart = parts[0];
    const restParts = parts.slice(1).join("/");
    return {
      providerID: firstPart || "default",
      modelID: restParts || trimmedId,
    };
  }

  // Just model ID without provider - will use default provider
  return {
    providerID: "",
    modelID: trimmedId,
  };
}

/**
 * Check if a session ID is valid.
 * Session IDs are typically UUIDs or similar alphanumeric strings.
 */
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== "string") {
    return false;
  }

  // Allow UUIDs, alphanumeric strings, and strings with hyphens/underscores
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return (
    validPattern.test(sessionId) &&
    sessionId.length > 0 &&
    sessionId.length <= 128
  );
}

/**
 * Validate a keyed form answer against the form's field definitions.
 * Checks that every answered key exists on the form, that value shapes match
 * the field type, and that required unconditional fields are answered.
 * Conditional (`when`) requirements are not evaluated client-side.
 */
export function validateFormAnswer(
  form: OpencodeFormRequest,
  answer: OpencodeFormAnswer,
): ValidationResult<OpencodeFormAnswer> {
  const warnings: string[] = [];
  const fieldsByKey = new Map(form.fields.map((field) => [field.key, field]));

  for (const [key, value] of Object.entries(answer)) {
    const field = fieldsByKey.get(key);
    if (!field) {
      warnings.push(`Answer key "${key}" does not match any form field`);
      continue;
    }

    switch (field.type) {
      case "string":
      case "external":
        if (typeof value !== "string") {
          warnings.push(`Field "${key}" (${field.type}) requires a string`);
        }
        break;
      case "number":
        if (typeof value !== "number") {
          warnings.push(`Field "${key}" (number) requires a number`);
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          warnings.push(`Field "${key}" (integer) requires an integer`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          warnings.push(`Field "${key}" (boolean) requires a boolean`);
        }
        break;
      case "multiselect":
        if (
          !Array.isArray(value) ||
          value.some((item) => typeof item !== "string")
        ) {
          warnings.push(
            `Field "${key}" (multiselect) requires an array of strings`,
          );
        }
        break;
    }
  }

  for (const field of form.fields) {
    // "external" fields carry no required/when/default metadata
    if (field.type === "external") {
      continue;
    }
    if (
      field.required &&
      !field.when?.length &&
      !(field.key in answer) &&
      field.default === undefined
    ) {
      warnings.push(`Required field "${field.key}" is missing an answer`);
    }
  }

  return { value: answer, warnings };
}

/**
 * Merge settings with defaults.
 */
export function mergeSettings(
  defaults: OpencodeSettings | undefined,
  overrides: OpencodeSettings | undefined,
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

  // location and the deprecated directory alias are one logical field:
  // an override of either supersedes both defaults.
  const overridesLocation =
    overrides.location !== undefined || overrides.directory !== undefined;

  return {
    ...defaults,
    ...overrides,
    location: overridesLocation ? overrides.location : defaults.location,
    directory: overridesLocation ? overrides.directory : defaults.directory,
  };
}

/**
 * Resolve the effective session mode from `sessionMode` and `sessionId`.
 *
 * Explicit rule for the sessionId+sessionMode ambiguity:
 * - An explicit `sessionMode` always wins. Conflicting combinations warn
 *   (in {@link validateSettings}) and the losing field is ignored:
 *   `sessionId` with mode "ephemeral" is ignored; mode
 *   "existing" without a `sessionId` falls back to "ephemeral".
 * - With no explicit mode, providing a `sessionId` pins that session and
 *   implies mode "existing".
 * - Otherwise the default is "ephemeral".
 */
export function resolveSessionMode(
  settings: OpencodeSettings,
): OpencodeSessionMode {
  if (settings.sessionMode === "existing") {
    return settings.sessionId ? "existing" : "ephemeral";
  }
  if (settings.sessionMode) {
    return settings.sessionMode;
  }
  return settings.sessionId ? "existing" : "ephemeral";
}

/**
 * Resolve the effective session location from `location` and the deprecated
 * v4 `directory` alias. `location` takes precedence when both are set.
 */
export function resolveSessionLocation(
  settings: OpencodeSettings,
): OpencodeSessionLocation | undefined {
  if (settings.location !== undefined) {
    return settings.location;
  }
  if (settings.directory !== undefined) {
    return { directory: settings.directory };
  }
  return undefined;
}

/**
 * Check whether a resolved file URI is a `data:` URI — the only scheme
 * verified to reach the model end-to-end on current OpenCode v2 builds.
 * The prompt path must reject (warn + skip) anything else before prompting,
 * since a bad attachment fails the whole turn late at the model provider.
 */
export function isDataUri(uri: string): uri is OpencodeDataUri {
  return uri.startsWith("data:");
}

/**
 * Strict well-formedness check for a `data:` URI destined for prompt
 * `files[]`. {@link isDataUri} only detects the scheme; the server admits
 * any URI verbatim and a bad attachment fails the whole turn late at the
 * model provider, so the prompt path must additionally reject malformed
 * `data:` URIs before prompting: no comma/payload, or a mediatype that is
 * not a concrete `type/subtype` (the server trusts the URI mediatype;
 * wildcards and bare top-level types are rejected).
 */
export function isAttachableDataUri(uri: string): uri is OpencodeDataUri {
  if (!isDataUri(uri)) {
    return false;
  }
  const comma = uri.indexOf(",");
  if (comma === -1 || comma === uri.length - 1) {
    return false;
  }
  const header = uri.slice("data:".length, comma);
  const mediatype = header.split(";", 1)[0]!;
  const slash = mediatype.indexOf("/");
  return slash > 0 && slash < mediatype.length - 1 && !mediatype.includes("*");
}
