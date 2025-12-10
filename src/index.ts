// Provider exports
export { createOpencode, opencode, OpencodeModels } from './opencode-provider.js';
export type { OpencodeModelShortcut } from './opencode-provider.js';

// Language model export
export { OpencodeLanguageModel } from './opencode-language-model.js';

// Client manager exports
export {
  OpencodeClientManager,
  createClientManager,
  createClientManagerFromSettings,
} from './opencode-client-manager.js';
export type { ClientManagerOptions } from './opencode-client-manager.js';

// Type exports
export type {
  OpencodeModelId,
  OpencodeSettings,
  OpencodeProviderSettings,
  OpencodeProvider,
  ParsedModelId,
  OpencodeProviderMetadata,
  Logger,
  ToolStreamState,
  StreamingUsage,
} from './types.js';

// Validation exports
export {
  validateSettings,
  validateProviderSettings,
  validateModelId,
  isValidSessionId,
  mergeSettings,
} from './validation.js';

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
} from './errors.js';

// Logger exports
export {
  getLogger,
  defaultLogger,
  silentLogger,
  createContextLogger,
  logUnsupportedFeature,
  logUnsupportedParameter,
  logUnsupportedCallOptions,
} from './logger.js';

// Message conversion exports
export {
  convertToOpencodeMessages,
  extractTextFromParts,
} from './convert-to-opencode-messages.js';
export type {
  TextPartInput,
  FilePartInput,
  OpencodePartInput,
  ConversionResult,
} from './convert-to-opencode-messages.js';

// Event conversion exports
export {
  convertEventToStreamParts,
  createStreamState,
  createFinishParts,
  createStreamStartPart,
  isEventForSession,
  isSessionComplete,
} from './convert-from-opencode-events.js';
export type {
  OpencodeEvent,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionStatus,
  EventSessionIdle,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  StepFinishPart,
  FilePart,
  Part,
  Message,
  StreamState,
} from './convert-from-opencode-events.js';

// Finish reason mapping exports
export {
  mapOpencodeFinishReason,
  mapErrorToFinishReasonFromUnknown,
  hasToolCalls,
} from './map-opencode-finish-reason.js';
export type { MessageInfo } from './map-opencode-finish-reason.js';
