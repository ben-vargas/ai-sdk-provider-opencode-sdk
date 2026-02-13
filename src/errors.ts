import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";

/**
 * Metadata for OpenCode errors.
 */
export interface OpencodeErrorMetadata {
  sessionId?: string;
  messageId?: string;
  statusCode?: number;
  isRetryable: boolean;
  errorType?: string;
  timeoutMs?: number;
}

/**
 * Check if an error is an authentication error.
 */
export function isAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check error name
  if (typeof err.name === "string" && err.name === "ProviderAuthError") {
    return true;
  }

  // Check for status code 401 or 403
  if (
    typeof err.statusCode === "number" &&
    (err.statusCode === 401 || err.statusCode === 403)
  ) {
    return true;
  }

  // Check message for auth-related keywords
  if (typeof err.message === "string") {
    const message = err.message.toLowerCase();
    return (
      message.includes("unauthorized") ||
      message.includes("authentication") ||
      message.includes("api key") ||
      message.includes("invalid key") ||
      message.includes("auth failed")
    );
  }

  return false;
}

/**
 * Check if an error is a timeout error.
 */
export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  // Check error name
  if (typeof err.name === "string") {
    const name = err.name.toLowerCase();
    if (name.includes("timeout")) {
      return true;
    }
  }

  // Check error code
  if (typeof err.code === "string") {
    const code = err.code.toUpperCase();
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
      return true;
    }
  }

  // Check message
  if (typeof err.message === "string") {
    const message = err.message.toLowerCase();
    return message.includes("timeout") || message.includes("timed out");
  }

  return false;
}

/**
 * Check if an error is an abort error (user cancelled).
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  if (typeof err.name === "string" && err.name === "AbortError") {
    return true;
  }

  if (typeof err.code === "string" && err.code.toUpperCase() === "ABORT_ERR") {
    return true;
  }

  if (typeof err.name === "string" && err.name === "MessageAbortedError") {
    return true;
  }

  return false;
}

/**
 * Check if an error indicates output length exceeded.
 */
export function isOutputLengthError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  if (typeof err.name === "string" && err.name === "MessageOutputLengthError") {
    return true;
  }

  if (typeof err.name === "string" && err.name === "ContextOverflowError") {
    return true;
  }

  if (typeof err.message === "string") {
    const message = err.message.toLowerCase();
    return (
      message.includes("output length") ||
      message.includes("max tokens") ||
      message.includes("token limit")
    );
  }

  return false;
}

/**
 * Create an authentication error from an OpenCode error.
 */
export function createAuthenticationError(error: unknown): LoadAPIKeyError {
  const message = extractErrorMessage(error);
  const providerInfo = extractProviderInfo(error);

  return new LoadAPIKeyError({
    message: providerInfo
      ? `OpenCode authentication error (${providerInfo}): ${message}`
      : `OpenCode authentication error: ${message}`,
  });
}

/**
 * Create an API call error from an OpenCode error.
 */
export function createAPICallError(
  error: unknown,
  metadata?: Partial<OpencodeErrorMetadata>,
): APICallError {
  const message = extractErrorMessage(error);
  const statusCode = extractStatusCode(error);
  const isRetryable = metadata?.isRetryable ?? isRetryableError(error);

  return new APICallError({
    message,
    url: "opencode://session",
    requestBodyValues: {},
    statusCode,
    isRetryable,
    data: {
      errorType: metadata?.errorType ?? extractErrorType(error),
      sessionId: metadata?.sessionId,
      messageId: metadata?.messageId,
    },
  });
}

/**
 * Create a timeout error.
 */
export function createTimeoutError(
  timeoutMs: number,
  operation?: string,
): APICallError {
  const operationDesc = operation ? ` during ${operation}` : "";
  return new APICallError({
    message: `OpenCode request timed out after ${timeoutMs}ms${operationDesc}`,
    url: "opencode://session",
    requestBodyValues: {},
    isRetryable: true,
  });
}

/**
 * Extract error message from unknown error.
 */
export function extractErrorMessage(error: unknown): string {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object") {
    const err = error as Record<string, unknown>;

    if (typeof err.message === "string") {
      return err.message;
    }

    if (typeof err.error === "string") {
      return err.error;
    }

    // Check for nested data.message
    if (typeof err.data === "object" && err.data !== null) {
      const data = err.data as Record<string, unknown>;
      if (typeof data.message === "string") {
        return data.message;
      }
    }
  }

  return "Unknown error";
}

/**
 * Extract status code from error.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const err = error as Record<string, unknown>;

  if (typeof err.statusCode === "number") {
    return err.statusCode;
  }

  if (typeof err.status === "number") {
    return err.status;
  }

  return undefined;
}

/**
 * Extract error type from error.
 */
function extractErrorType(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const err = error as Record<string, unknown>;

  if (typeof err.name === "string") {
    return err.name;
  }

  if (typeof err.type === "string") {
    return err.type;
  }

  return undefined;
}

/**
 * Extract provider info from authentication error.
 */
function extractProviderInfo(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const err = error as Record<string, unknown>;

  if (typeof err.data === "object" && err.data !== null) {
    const data = err.data as Record<string, unknown>;
    if (typeof data.providerID === "string") {
      return data.providerID;
    }
  }

  return undefined;
}

/**
 * Check if an error is retryable.
 */
function isRetryableError(error: unknown): boolean {
  // Abort errors are not retryable
  if (isAbortError(error)) {
    return false;
  }

  // Timeout errors are retryable
  if (isTimeoutError(error)) {
    return true;
  }

  // Auth errors are not retryable
  if (isAuthenticationError(error)) {
    return false;
  }

  // Check status code
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    // 5xx errors are generally retryable
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }

    // 429 (rate limit) is retryable
    if (statusCode === 429) {
      return true;
    }

    // 4xx errors (except 429) are generally not retryable
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }

  // Default to not retryable
  return false;
}

/**
 * Wrap an error in an appropriate AI SDK error type.
 */
export function wrapError(
  error: unknown,
  metadata?: Partial<OpencodeErrorMetadata>,
): Error {
  if (isAuthenticationError(error)) {
    return createAuthenticationError(error);
  }

  if (isTimeoutError(error)) {
    const timeoutMs =
      metadata?.timeoutMs ?? extractTimeoutMs(error) ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return createTimeoutError(timeoutMs, "request");
  }

  return createAPICallError(error, metadata);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function extractTimeoutMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const err = error as Record<string, unknown>;
  const maybeTimeout =
    typeof err.timeoutMs === "number"
      ? err.timeoutMs
      : typeof err.timeout === "number"
        ? err.timeout
        : undefined;

  if (maybeTimeout === undefined || !Number.isFinite(maybeTimeout)) {
    return undefined;
  }

  return maybeTimeout > 0 ? maybeTimeout : undefined;
}
