/**
 * System-prompt support via OpenCode v2 **session instruction entries**.
 *
 * v2 has no per-prompt `system` field, but it does have a per-session
 * instruction store (`session.instructions.entry.{put,list,remove}`). An
 * entry renders as
 *
 *     <context key="ai-sdk.system">…value…</context>
 *
 * into the session's instruction baseline — after the agent's own system
 * prompt, ahead of the user turn — and is re-rendered on **every** turn, not
 * just the first. That is real system-prompt semantics, so the provider uses
 * it in preference to the v4-era delimited-prepend degradation.
 *
 * Verified live against the published `opencode2@0.0.0-beta-18286` binary
 * (spike/14b-instruction-entries.mjs → spike/artifacts/14b-instruction-entries.json):
 *   - a put before the first prompt is honoured on turn 1 and still honoured
 *     on turn 2 (E2/E3),
 *   - a put made mid-session takes effect on the next turn and announces
 *     itself as a durable `system` message whose text is the rendered
 *     `<context …>` block (E4),
 *   - `remove` drops the entry from `list` and the instruction stops
 *     applying (E1/E5),
 *   - an entry instruction overrides default agent formatting behaviour
 *     (E7),
 *   - keys must match {@link INSTRUCTION_KEY_PATTERN}; uppercase, empty and
 *     leading `_`/`.` keys are rejected (E6),
 *   - values are capped at {@link INSTRUCTION_VALUE_MAX_BYTES} bytes
 *     measured on the **JSON encoding** (E6 — see
 *     {@link instructionValueBytes}).
 */

/**
 * The key this provider writes its system prompt under.
 *
 * Namespaced so a caller's own entries on a pinned session are never
 * clobbered, and matching {@link INSTRUCTION_KEY_PATTERN}.
 */
export const SYSTEM_INSTRUCTION_KEY = "ai-sdk.system";

/**
 * Key grammar the server enforces (verified: `AI-SDK`, `ai-sdk.System`,
 * `_leading`, `.dot` and `""` are all rejected; `a`, `ai-sdk.system` and
 * `a1._-x` are accepted).
 */
export const INSTRUCTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Server-side cap on an instruction entry value, in bytes. */
export const INSTRUCTION_VALUE_MAX_BYTES = 8192;

/**
 * Byte size the server charges for an instruction value.
 *
 * The cap is measured on the **JSON encoding**, not the raw string: an
 * 8190-character ASCII value is accepted (8190 + 2 quotes = 8192) while an
 * 8191-character one is rejected at 8193 bytes. Multi-byte characters are
 * charged their UTF-8 length (4095 × `é` = 8190 bytes + quotes = 8192, and
 * is accepted), and characters JSON must escape are charged their escaped
 * length. `JSON.stringify` reproduces all three rules exactly.
 */
export function instructionValueBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Whether `value` fits the server's instruction-entry size cap. */
export function fitsInstructionValue(value: string): boolean {
  return instructionValueBytes(value) <= INSTRUCTION_VALUE_MAX_BYTES;
}
