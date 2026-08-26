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
  mergeSettings,
  resolveSessionLocation,
  resolveSessionMode,
} from "./validation.js";
export type { ValidationResult } from "./validation.js";

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
  isAuthenticationError,
  isTimeoutError,
  isAbortError,
  isOutputLengthError,
  createAuthenticationError,
  createAPICallError,
  createTimeoutError,
  extractErrorMessage,
  wrapError,
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
