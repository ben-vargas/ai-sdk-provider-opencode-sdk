import type { LanguageModelV3FinishReason } from "@ai-sdk/provider";
import { isAbortError, isOutputLengthError } from "./errors.js";

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
  message: MessageInfo | undefined,
): LanguageModelV3FinishReason {
  if (!message) {
    return { unified: "other", raw: undefined };
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
  return { unified: "stop", raw: undefined };
}

/**
 * Map an error to a finish reason.
 */
function mapErrorToFinishReason(error: {
  name: string;
  data?: unknown;
}): LanguageModelV3FinishReason {
  const { name } = error;

  switch (name) {
    case "MessageAbortedError":
      // User cancelled - treat as normal stop
      return { unified: "stop", raw: name };

    case "MessageOutputLengthError":
      // Token limit exceeded
      return { unified: "length", raw: name };

    case "ContextOverflowError":
      return { unified: "length", raw: name };

    case "StructuredOutputError":
      return { unified: "error", raw: name };

    case "ProviderAuthError":
    case "APIError":
    case "UnknownError":
      // Various API/provider errors
      return { unified: "error", raw: name };

    default:
      // Unknown error type
      return { unified: "error", raw: name };
  }
}

/**
 * Map finish string to finish reason.
 */
function mapFinishToReason(finish: string): LanguageModelV3FinishReason {
  const normalizedFinish = finish.toLowerCase();

  // Normal completion
  if (
    normalizedFinish === "end_turn" ||
    normalizedFinish === "stop" ||
    normalizedFinish === "end"
  ) {
    return { unified: "stop", raw: finish };
  }

  // Token limit
  if (normalizedFinish === "max_tokens" || normalizedFinish === "length") {
    return { unified: "length", raw: finish };
  }

  // Tool use
  if (normalizedFinish === "tool_use" || normalizedFinish === "tool_calls") {
    return { unified: "tool-calls", raw: finish };
  }

  // Content filter
  if (normalizedFinish === "content_filter" || normalizedFinish === "safety") {
    return { unified: "content-filter", raw: finish };
  }

  // Error states
  if (normalizedFinish === "error") {
    return { unified: "error", raw: finish };
  }

  // Default to stop for unknown values
  return { unified: "other", raw: finish };
}

/**
 * Map an error object to a finish reason.
 */
export function mapErrorToFinishReasonFromUnknown(
  error: unknown,
): LanguageModelV3FinishReason {
  if (isAbortError(error)) {
    return { unified: "stop", raw: "abort" };
  }

  if (isOutputLengthError(error)) {
    return { unified: "length", raw: "output-length" };
  }

  return { unified: "error", raw: "error" };
}

/**
 * Determine if a message has tool calls.
 * Used to determine 'tool-calls' finish reason.
 */
export function hasToolCalls(parts: Array<{ type: string }>): boolean {
  return parts.some((part) => part.type === "tool");
}
