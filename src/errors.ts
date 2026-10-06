/**
 * Typed error boundary for the OpenCode v2 client.
 *
 * v2 throws typed errors — `_tag` unions for API errors and `ClientError`
 * (five `reason` values) for transport/protocol failures. This module maps
 * them onto AI SDK error types with **phase-aware retryability**:
 *
 * The AI SDK auto-retries the entire call when `APICallError.isRetryable`
 * is set. A retried call re-issues `session.prompt` (or the permission
 * reply), enqueueing duplicate work on the session. The rule is therefore
 * universal, not Transport-specific: **no error of any kind may surface as
 * retryable once the prompt (or a permission reply) has been dispatched** —
 * e.g. a 503 from the post-prompt `session.wait` watchdog must be retried
 * internally against the pinned session (re-wait/log/message
 * reconciliation), never via an AI SDK call retry. Post-dispatch failures of
 * a transient class instead carry a reconciliation marker
 * ({@link needsSessionReconciliation}) that the orchestration layer uses to
 * trigger that internal recovery. Tool-capable executions are never
 * auto-replayed after a transport failure — the turn may already have
 * mutated the workspace.
 */
import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import {
  ClientError,
  isConflictError,
  isForbiddenError,
  isServiceUnavailableError,
  isSessionBusyError,
  isUnauthorizedError,
  type ClientErrorReason,
  type SessionStructuredError,
} from "@opencode/client";

/**
 * Where in the generation lifecycle the error was thrown.
 *
 * - "pre-dispatch": before the prompt (or a permission reply) was sent —
 *   subscribe, `session.create`, catalog/preflight calls. Nothing is
 *   running server-side, so a transient failure may surface as a retryable
 *   `APICallError`.
 * - "post-dispatch": the prompt (or a permission reply) has been sent — or
 *   its delivery is uncertain. An AI SDK retry would enqueue duplicate
 *   work, so nothing is retryable; transient-class failures get the
 *   reconciliation marker instead.
 */
export type OpencodeErrorPhase = "pre-dispatch" | "post-dispatch";

/**
 * Context for {@link wrapError}. `phase` is mandatory — retryability cannot
 * be decided without it.
 */
export interface OpencodeWrapErrorOptions {
  phase: OpencodeErrorPhase;
  /** Operation being attempted, e.g. "session.prompt" (for messages/url). */
  operation?: string;
  sessionId?: string;
  messageId?: string;
  modelId?: string;
}

/**
 * Structured payload attached as `APICallError.data` by this module.
 */
export interface OpencodeErrorData {
  phase: OpencodeErrorPhase;
  /**
   * True when the orchestration layer must reconcile the pinned session's
   * state internally (re-wait/log/message) instead of retrying the call:
   * a transient-class failure (transport, busy/conflict, unavailable,
   * 429/5xx) that occurred post-dispatch, where retrying would duplicate
   * work but the turn may still be running server-side.
   */
  reconcile: boolean;
  /** `_tag` of a typed v2 API error, when the cause was one. */
  errorTag?: string;
  /** `ClientError.reason`, when the cause was a ClientError. */
  clientReason?: ClientErrorReason;
  /** Status recovered by guarded cause inspection, when available. */
  statusCode?: number;
  operation?: string;
  sessionId?: string;
  messageId?: string;
  modelId?: string;
  /** Structured error type, when normalized from an event-carried failure. */
  errorType?: string;
}

const VERSION_SKEW_HINT =
  "This usually indicates a server/client contract mismatch — check that the OpenCode server version matches the client this provider was built against (client/CLI version skew).";

/**
 * Detect a caller-signal abort. Covers the standard `AbortError` shapes and
 * the v2 client's abort surface: aborting `event.subscribe`'s request signal
 * makes the iterator throw `ClientError{reason: "Transport"}` with the abort
 * error as its cause (spike-confirmed) — that is normal shutdown, not a
 * transport failure.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;

  if (err["name"] === "AbortError") {
    return true;
  }
  if (
    typeof err["code"] === "string" &&
    err["code"].toUpperCase() === "ABORT_ERR"
  ) {
    return true;
  }
  if (isClientError(error) && error.reason === "Transport") {
    return isAbortError(error.cause);
  }
  return false;
}

/**
 * Guard for the v2 `ClientError`. `instanceof` plus a structural fallback
 * (name + string reason) to survive dual-package/multi-realm instances.
 */
export function isClientError(error: unknown): error is ClientError {
  if (error instanceof ClientError) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as Record<string, unknown>;
  return err["name"] === "ClientError" && typeof err["reason"] === "string";
}

/**
 * Guard for any typed v2 API error (`_tag` union member).
 */
export function isTaggedError(
  error: unknown,
): error is { _tag: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  );
}

/**
 * True when the error is this module's post-dispatch marker for internal
 * session reconciliation: the call must not be retried, but the turn may
 * still be running — recover through the pinned session's wait/log/message
 * state.
 */
export function needsSessionReconciliation(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    return false;
  }
  const data = error.data as OpencodeErrorData | undefined;
  return data?.reconcile === true;
}

/**
 * Recover a status code from a `ClientError` by guarded cause inspection.
 * The public `ClientError` type promises only `reason` and an untyped
 * `cause` — there is NO status contract. Treat as unknown-status when
 * absent.
 */
export function getClientErrorStatus(error: ClientError): number | undefined {
  const cause = error.cause;
  if (!cause || typeof cause !== "object") {
    return undefined;
  }
  const err = cause as Record<string, unknown>;
  if (typeof err["status"] === "number") {
    return err["status"];
  }
  if (typeof err["statusCode"] === "number") {
    return err["statusCode"];
  }
  return undefined;
}

/**
 * True when the server said the route itself does not exist, rather than
 * rejecting the request it carried.
 *
 * Used for optional-capability feature detection (e.g. session instruction
 * entries): a route that is absent is absent for the rest of the
 * conversation, so the provider can stop probing it — while a rejected
 * *request* (a typed `_tag` error such as a value-too-large or
 * session-not-found) says nothing about the route and must not disable it.
 *
 * Conservative by construction: only an explicit 404/405/501 counts. An
 * unknown status is treated as "not proven absent", which costs one failed
 * request per turn in the worst case but never disables a working route.
 */
export function isMissingRouteError(error: unknown): boolean {
  if (isTaggedError(error)) {
    return false;
  }
  if (!isClientError(error)) {
    return false;
  }
  const status = getClientErrorStatus(error);
  return status === 404 || status === 405 || status === 501;
}

/**
 * Extract a human-readable message from an unknown error.
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
    if (typeof err["message"] === "string") {
      return err["message"];
    }
  }
  return "Unknown error";
}

/** Internal classification of a cause before wrapping. */
interface ErrorClassification {
  message: string;
  /** May surface as retryable — pre-dispatch only (the universal rule). */
  transient: boolean;
  auth?: boolean;
  errorTag?: string;
  clientReason?: ClientErrorReason;
  statusCode?: number;
}

function classifyClientError(error: ClientError): ErrorClassification {
  const causeMessage = extractErrorMessage(error.cause);
  const detail = causeMessage !== "Unknown error" ? `: ${causeMessage}` : "";

  switch (error.reason) {
    case "Transport":
      return {
        message: `OpenCode transport failure${detail}`,
        transient: true,
        clientReason: error.reason,
      };
    case "UnexpectedStatus": {
      const status = getClientErrorStatus(error);
      // No status promise: 429/5xx (recovered via guarded cause inspection)
      // are transient; anything else — including unknown status — is not.
      const transient =
        status !== undefined && (status === 429 || status >= 500);
      return {
        message: `OpenCode server returned an unexpected status${status !== undefined ? ` ${status}` : ""}${detail}`,
        transient,
        clientReason: error.reason,
        ...(status !== undefined ? { statusCode: status } : {}),
      };
    }
    case "UnsupportedContentType":
      return {
        message: `OpenCode server responded with an unsupported content type${detail}. ${VERSION_SKEW_HINT}`,
        transient: false,
        clientReason: error.reason,
      };
    case "MalformedResponse":
      return {
        message: `OpenCode server response could not be parsed${detail}. ${VERSION_SKEW_HINT}`,
        transient: false,
        clientReason: error.reason,
      };
    case "SseEventTooLarge":
      return {
        message: `OpenCode SSE event exceeded the client's size limit${detail}. Not retryable without a different transport strategy.`,
        transient: false,
        clientReason: error.reason,
      };
  }
}

function classifyTaggedError(error: {
  _tag: string;
  message: string;
}): ErrorClassification {
  const base = {
    message: `OpenCode ${error._tag}: ${error.message}`,
    errorTag: error._tag,
  };

  if (isUnauthorizedError(error) || isForbiddenError(error)) {
    return { ...base, transient: false, auth: true };
  }
  // Busy/conflict clear on their own (the in-flight turn finishes) and
  // ServiceUnavailable may recover — transient, so retryable pre-dispatch
  // and reconcile-marked post-dispatch. Note `session.wait` unavailability
  // arrives as ServiceUnavailableError too (spike Q2) — always
  // post-dispatch, so the universal rule already keeps it off the AI SDK
  // retry path.
  if (
    isSessionBusyError(error) ||
    isConflictError(error) ||
    isServiceUnavailableError(error)
  ) {
    return { ...base, transient: true };
  }
  // Everything else — validation, not-found, form-invalid, unknown — is a
  // definitive server verdict; retrying the same call cannot succeed.
  return { ...base, transient: false };
}

/** The first typed client/API error in an error's `cause` chain (bounded). */
function typedCause(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!(current instanceof Error)) {
      return undefined;
    }
    const cause: unknown = current.cause;
    if (isClientError(cause) || isTaggedError(cause)) {
      return cause;
    }
    current = cause;
  }
  return undefined;
}

function classifyUnknown(error: unknown): ErrorClassification {
  return {
    message: `OpenCode request failed: ${extractErrorMessage(error)}`,
    transient: false,
  };
}

/**
 * Wrap an error thrown by the v2 client (or anything else on the request
 * path) into an AI SDK error, applying the phase rule.
 *
 * - Abort errors (caller signal) pass through unchanged.
 * - Already-wrapped AI SDK errors pass through unchanged — EXCEPT a
 *   retryable `APICallError` post-dispatch, which is demoted to
 *   non-retryable with `data.reconcile: true` (the universal phase rule
 *   admits no bypass).
 * - `UnauthorizedError`/`ForbiddenError` → `LoadAPIKeyError`.
 * - Everything else → `APICallError` with `isRetryable` true ONLY for
 *   transient-class failures pre-dispatch; post-dispatch transient-class
 *   failures are non-retryable with `data.reconcile: true`.
 */
export function wrapError(
  error: unknown,
  options: OpencodeWrapErrorOptions,
): Error {
  if (isAbortError(error)) {
    return error instanceof Error
      ? error
      : new Error(extractErrorMessage(error));
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return error;
  }
  if (APICallError.isInstance(error)) {
    // The universal phase rule applies to already-wrapped errors too: a
    // retryable APICallError must not surface post-dispatch. Its retryable
    // classification means it was transient-class, so demote it to
    // non-retryable with the reconciliation marker.
    if (options.phase === "pre-dispatch" || !error.isRetryable) {
      return error;
    }
    const prior =
      error.data && typeof error.data === "object"
        ? (error.data as Partial<OpencodeErrorData>)
        : {};
    const demotedData: OpencodeErrorData = {
      ...prior,
      phase: "post-dispatch",
      reconcile: true,
      ...(prior.operation === undefined && options.operation
        ? { operation: options.operation }
        : {}),
      ...(prior.sessionId === undefined && options.sessionId
        ? { sessionId: options.sessionId }
        : {}),
      ...(prior.messageId === undefined && options.messageId
        ? { messageId: options.messageId }
        : {}),
      ...(prior.modelId === undefined && options.modelId
        ? { modelId: options.modelId }
        : {}),
    };
    return new APICallError({
      message: error.message,
      url: error.url,
      requestBodyValues: error.requestBodyValues,
      ...(error.statusCode !== undefined
        ? { statusCode: error.statusCode }
        : {}),
      ...(error.responseHeaders !== undefined
        ? { responseHeaders: error.responseHeaders }
        : {}),
      ...(error.responseBody !== undefined
        ? { responseBody: error.responseBody }
        : {}),
      isRetryable: false,
      data: demotedData,
      cause: error,
    });
  }

  // A plain Error that wraps a typed one (e.g. the client manager's
  // preflight "Failed to reach OpenCode server" with the ClientError as its
  // cause) is classified by that cause, so transience and auth survive the
  // wrapping; its own, more specific message is kept.
  const typed =
    isClientError(error) || isTaggedError(error) ? error : typedCause(error);
  const typedClassification =
    typed === undefined
      ? undefined
      : isClientError(typed)
        ? classifyClientError(typed)
        : classifyTaggedError(typed as { _tag: string; message: string });
  const classification =
    typedClassification === undefined
      ? classifyUnknown(error)
      : typed === error
        ? typedClassification
        : { ...typedClassification, message: extractErrorMessage(error) };

  if (classification.auth) {
    return new LoadAPIKeyError({
      message: classification.message,
    });
  }

  const isRetryable =
    options.phase === "pre-dispatch" && classification.transient;
  const reconcile =
    options.phase === "post-dispatch" && classification.transient;

  const data: OpencodeErrorData = {
    phase: options.phase,
    reconcile,
    ...(classification.errorTag ? { errorTag: classification.errorTag } : {}),
    ...(classification.clientReason
      ? { clientReason: classification.clientReason }
      : {}),
    ...(classification.statusCode !== undefined
      ? { statusCode: classification.statusCode }
      : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
  };

  return new APICallError({
    message: classification.message,
    url: `opencode://${options.operation ?? "request"}`,
    requestBodyValues: {},
    ...(classification.statusCode !== undefined
      ? { statusCode: classification.statusCode }
      : {}),
    isRetryable,
    data,
    cause: error,
  });
}

/**
 * Normalize an event-carried `SessionStructuredError` (execution/step
 * failures, retry records) to an `APICallError`. These arrive through the
 * event stream, so they are post-dispatch by nature and describe a turn the
 * server already concluded — never retryable, no reconciliation (the failure
 * IS the reconciled outcome).
 */
export function normalizeStructuredError(
  error: SessionStructuredError,
  options: Omit<OpencodeWrapErrorOptions, "phase">,
): APICallError {
  const data: OpencodeErrorData = {
    phase: "post-dispatch",
    reconcile: false,
    errorType: error.type,
    ...(error.status !== undefined ? { statusCode: error.status } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
  };

  return new APICallError({
    message: `OpenCode execution failed (${error.type}): ${error.message}`,
    url: `opencode://${options.operation ?? "session"}`,
    requestBodyValues: {},
    ...(error.status !== undefined ? { statusCode: error.status } : {}),
    isRetryable: false,
    data,
  });
}
