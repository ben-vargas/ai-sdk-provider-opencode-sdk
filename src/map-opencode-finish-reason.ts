import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type {
  SessionExecutionInterrupted,
  SessionStepEnded,
  SessionStructuredError,
} from "@opencode/client";

/**
 * Native OpenCode v2 finish value (closed union, aligned with the AI SDK
 * except for `"unknown"`). Carried on `SessionStepEnded.data.finish` and
 * assistant messages.
 */
export type OpencodeV2Finish = SessionStepEnded["data"]["finish"];

/**
 * Interrupt reason from `session.execution.interrupted`.
 */
export type OpencodeInterruptReason =
  SessionExecutionInterrupted["data"]["reason"];

const FINISH_TABLE: Record<
  OpencodeV2Finish,
  LanguageModelV4FinishReason["unified"]
> = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool-calls",
  "content-filter": "content-filter",
  error: "error",
  unknown: "other",
};

/**
 * Map a native OpenCode v2 finish value to an AI SDK finish reason.
 * Five values map 1:1; `"unknown"` (and anything outside the closed union,
 * for forward compatibility) maps to `other`. The raw value prefers the
 * provider-native `rawFinish` when the server reports one.
 */
export function mapOpencodeFinishReason(
  finish: string | undefined,
  rawFinish?: string,
): LanguageModelV4FinishReason {
  // Own-property check: `in` would also match inherited Object.prototype
  // names ("toString", "constructor", ...), returning a function as the
  // unified reason for such arbitrary inputs.
  const unified =
    finish !== undefined && Object.hasOwn(FINISH_TABLE, finish)
      ? FINISH_TABLE[finish as OpencodeV2Finish]
      : "other";
  return { unified, raw: rawFinish ?? finish };
}

/**
 * Normalize a v2 `SessionStructuredError` (execution/step/tool failures) to
 * an AI SDK finish reason. v2 has no error-name taxonomy to switch on —
 * `type` is a free-form string — so every structured error is `error` with
 * the native type preserved as the raw value.
 */
export function mapStructuredErrorToFinishReason(
  error: SessionStructuredError,
): LanguageModelV4FinishReason {
  return { unified: "error", raw: error.type };
}

/**
 * Map a `session.execution.interrupted` reason to an AI SDK finish reason.
 *
 * Provisional (upstream does not document these semantics yet):
 * - `"user"` → `stop`: the user deliberately ended the turn.
 * - `"superseded"` → `other`: another inbox item steered over this turn;
 *   surfaced in provider metadata so callers can distinguish it.
 * - `"shutdown"` → `error`: the server went away mid-turn.
 * - `"inactivity"` → `error`: the server evicted the session's idle location
 *   and stopped its executions.
 */
export function mapInterruptReasonToFinishReason(
  reason: OpencodeInterruptReason,
): LanguageModelV4FinishReason {
  switch (reason) {
    case "user":
      return { unified: "stop", raw: "interrupted:user" };
    case "superseded":
      return { unified: "other", raw: "interrupted:superseded" };
    case "shutdown":
      return { unified: "error", raw: "interrupted:shutdown" };
    case "inactivity":
      return { unified: "error", raw: "interrupted:inactivity" };
  }
}
