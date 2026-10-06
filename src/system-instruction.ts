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
 *   - a put made mid-session announces itself as a durable `system` message
 *     whose text is the rendered `<context …>` block (E4; the committed
 *     capture's follow-up turns timed out under load, so which later turn
 *     first obeys it is recorded there as unmeasured),
 *   - `remove` drops the entry from `list` and the instruction stops
 *     applying (E1/E5),
 *   - precedence vs the agent's own system prompt: E7's contested arm was
 *     inconclusive live; on the 2.0.24 source the system prompt is sent as
 *     `[agent prompt, instruction baseline]` parts with entries last in the
 *     baseline, so an entry is added after the agent prompt and never
 *     replaces it (still undocumented upstream),
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

/**
 * Server-side cap on an instruction entry value, in bytes (OpenCode 2.x:
 * 256 KiB; the pre-release betas capped at 8 KiB).
 */
export const INSTRUCTION_VALUE_MAX_BYTES = 256 * 1024;

/**
 * Byte size the server charges for an instruction value.
 *
 * The cap is measured on the **JSON encoding**, not the raw string: an
 * ASCII value of `cap - 2` characters is accepted (plus 2 quotes = cap)
 * while one more character is rejected. Multi-byte characters are charged
 * their UTF-8 length, and characters JSON must escape are charged their
 * escaped length. `JSON.stringify` reproduces all three rules exactly
 * (verified live against the 8 KiB beta cap; the 2.x server measures the
 * same encoding).
 */
export function instructionValueBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Whether `value` fits the server's instruction-entry size cap. */
export function fitsInstructionValue(value: string): boolean {
  return instructionValueBytes(value) <= INSTRUCTION_VALUE_MAX_BYTES;
}
