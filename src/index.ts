// Provider factory exports
export {
  createOpencode,
  opencode,
  OpencodeModels,
} from "./opencode-provider.js";
export type { OpencodeModelShortcut } from "./opencode-provider.js";

// Client-manager exports
export {
  createClientManager,
  createClientManagerFromSettings,
  createClientManagerFromPort,
  mergeDefaultHeaders,
} from "./opencode-client-manager.js";

// Client-port facade exports
export { asClientPort } from "./client-port.js";
export type {
  OpencodeClientPort,
  OpencodeRequestOptions,
} from "./client-port.js";

// Type exports
export type {
  OpencodeModelId,
  OpencodeClient,
  OpencodeClientManager,
  OpencodeClientOptions,
  OpencodeServiceOptions,
  OpencodeSessionLocation,
  OpencodeSessionMode,
  OpencodeDelivery,
  OpencodeFormRequest,
  OpencodeFormField,
  OpencodeFormValue,
  OpencodeFormAnswer,
  OpencodeFormResponse,
  OpencodeFormPolicy,
  OpencodeDataUri,
  OpencodeFileToResolve,
  OpencodeResolveFileToUri,
  OpencodeProviderOptions,
  OpencodeSettings,
  OpencodeProviderSettings,
  OpencodeProvider,
  ParsedModelId,
  OpencodeFinish,
  OpencodeProviderMetadata,
  Logger,
} from "./types.js";

// Validation exports
export {
  validateSettings,
  validateProviderSettings,
  validateModelId,
  validateFormAnswer,
  isValidSessionId,
  isDataUri,
  isAttachableDataUri,
  mergeSettings,
  resolveSessionLocation,
  resolveSessionMode,
} from "./validation.js";
export type { ValidationResult } from "./validation.js";

// Prompt converter exports
export {
  convertToOpencodePrompt,
  createJsonModeInstruction,
  prependSystemBlock,
} from "./convert-to-opencode-messages.js";
export type {
  ConvertToOpencodePromptOptions,
  OpencodePromptConversion,
  OpencodePromptFile,
} from "./convert-to-opencode-messages.js";

// Event reducer exports
export {
  convertV2EventToStreamParts,
  createV2StreamState,
  createStreamStartPart,
  extractV2EventSessionId,
  finalizeV2Stream,
  normalizeReducerInput,
  PERMISSION_TOOL_NAME,
  UNKNOWN_TOOL_NAME,
} from "./convert-from-opencode-events.js";
export type {
  NormalizedV2Event,
  NormalizedV2Input,
  OpencodeReducerInput,
  PendingV2Approval,
  V2StreamState,
  V2StreamUsage,
} from "./convert-from-opencode-events.js";

// Language-model exports
export { OpencodeLanguageModel } from "./opencode-language-model.js";
export type { OpencodeLanguageModelConfig } from "./opencode-language-model.js";

// Finish-reason exports
export {
  mapInterruptReasonToFinishReason,
  mapOpencodeFinishReason,
  mapStructuredErrorToFinishReason,
} from "./map-opencode-finish-reason.js";
export type {
  OpencodeInterruptReason,
  OpencodeV2Finish,
} from "./map-opencode-finish-reason.js";

// Error exports
export {
  isAbortError,
  isClientError,
  isTaggedError,
  needsSessionReconciliation,
  getClientErrorStatus,
  extractErrorMessage,
  normalizeStructuredError,
  wrapError,
} from "./errors.js";
export type {
  OpencodeErrorData,
  OpencodeErrorPhase,
  OpencodeWrapErrorOptions,
} from "./errors.js";

// Logger exports
export {
  getLogger,
  defaultLogger,
  silentLogger,
  createContextLogger,
  logUnsupportedFeature,
  logUnsupportedParameter,
  logUnsupportedCallOptions,
} from "./logger.js";
