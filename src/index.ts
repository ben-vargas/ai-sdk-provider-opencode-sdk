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
  mergeSettings,
} from "./validation.js";
export type { ValidationResult } from "./validation.js";

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
