import type { LanguageModelV2FinishReason } from '@ai-sdk/provider';
import { isAbortError, isOutputLengthError } from './errors.js';

/**
 * Message info from OpenCode SDK.
 */
export interface MessageInfo {
  error?: {
    name: string;
    data?: unknown;
  };
  finish?: string;
}

/**
 * Map OpenCode message info to AI SDK finish reason.
 */
export function mapOpencodeFinishReason(
  message: MessageInfo | undefined
): LanguageModelV2FinishReason {
  if (!message) {
    return 'unknown';
  }

  // Check for errors first
  if (message.error) {
    return mapErrorToFinishReason(message.error);
  }

  // Check finish reason
  if (message.finish) {
    return mapFinishToReason(message.finish);
  }

  // Default to stop if no specific reason
  return 'stop';
}

/**
 * Map an error to a finish reason.
 */
function mapErrorToFinishReason(error: { name: string; data?: unknown }): LanguageModelV2FinishReason {
  const { name } = error;

  switch (name) {
    case 'MessageAbortedError':
      // User cancelled - treat as normal stop
      return 'stop';

    case 'MessageOutputLengthError':
      // Token limit exceeded
      return 'length';

    case 'ProviderAuthError':
    case 'APIError':
    case 'UnknownError':
      // Various API/provider errors
      return 'error';

    default:
      // Unknown error type
      return 'error';
  }
}

/**
 * Map finish string to finish reason.
 */
function mapFinishToReason(finish: string): LanguageModelV2FinishReason {
  const normalizedFinish = finish.toLowerCase();

  // Normal completion
  if (normalizedFinish === 'end_turn' || normalizedFinish === 'stop' || normalizedFinish === 'end') {
    return 'stop';
  }

  // Token limit
  if (normalizedFinish === 'max_tokens' || normalizedFinish === 'length') {
    return 'length';
  }

  // Tool use
  if (normalizedFinish === 'tool_use' || normalizedFinish === 'tool_calls') {
    return 'tool-calls';
  }

  // Content filter
  if (normalizedFinish === 'content_filter' || normalizedFinish === 'safety') {
    return 'content-filter';
  }

  // Error states
  if (normalizedFinish === 'error') {
    return 'error';
  }

  // Default to stop for unknown values
  return 'stop';
}

/**
 * Map an error object to a finish reason.
 */
export function mapErrorToFinishReasonFromUnknown(error: unknown): LanguageModelV2FinishReason {
  if (isAbortError(error)) {
    return 'stop';
  }

  if (isOutputLengthError(error)) {
    return 'length';
  }

  return 'error';
}

/**
 * Determine if a message has tool calls.
 * Used to determine 'tool-calls' finish reason.
 */
export function hasToolCalls(parts: Array<{ type: string }>): boolean {
  return parts.some((part) => part.type === 'tool');
}
