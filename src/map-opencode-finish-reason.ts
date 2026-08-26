import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type {
  SessionExecutionInterrupted,
  SessionStepEnded,
  SessionStructuredError,
} from "@opencode-ai/client";

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
  const unified =
    finish !== undefined && finish in FINISH_TABLE
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
  }
}
