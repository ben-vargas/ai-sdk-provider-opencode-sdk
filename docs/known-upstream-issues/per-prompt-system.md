# `session.instructions.entry` precedence and compaction semantics are undocumented

**Status:** Known upstream issue — tracked locally, not filed.
**Last verified:** 2026-10-06, against the `@opencode/cli@2.0.24` source — both guarantees are now **answered from source**, still undocumented upstream (see "2.0.24 source answers" below). First verified 2026-08-27 on `opencode2 0.0.0-beta-18286`.
**How to re-check** (re-runs the entry round-trip and the E7 precedence probe; see the script header for the server + agent setup):

```bash
OC2_URL=http://127.0.0.1:14396 OC2_PASSWORD=<pw> OC2_WORKDIR=/tmp/oc2-verify/workdir \
  node spike/14b-instruction-entries.mjs
```

**Evidence:** `spike/artifacts/14b-instruction-entries.json`; settled behaviors written up in `docs/v2-spike-findings.md` (instruction-entries section).

## Scope

The mechanism itself **works** and this provider ships on it:
`session.instructions.entry` is the real caller-supplied system-prompt
channel (`put`/`list`/`remove` round-trip, applies before the first prompt
and on later turns, `remove` stops it applying, key grammar and the
JSON-encoded value cap are enforced — 8192 bytes on the betas, 256 KiB on
2.x). Those behaviors are settled
empirically — the answers live in `docs/v2-spike-findings.md`, not here.

What remains open is that none of it is documented upstream, and two
load-bearing guarantees could not be settled by observation at all:

1. **Precedence relative to the agent's own system prompt.** Entries appear
   to join the instruction baseline _after_ the agent's system prompt. Is
   that ordering guaranteed? Can an entry override agent instructions, or is
   that incidental? A two-arm probe (an agent carrying a contradicting
   formatting rule, run with and without a contesting entry) showed the
   agent's rule being followed in the control arm, but the contested arm did
   not produce a usable answer, so there is no evidence either way in a
   reproducible capture. This is the guarantee we would most like written
   down rather than inferred.
2. **Compaction.** Do entries survive compaction — are they re-rendered into
   the compacted context, or can a long session silently lose them? This is
   the one we most need and could not practically test.

Both are behaviors this provider relies on by observation rather than by
contract: every AI SDK `system:` message and the `systemPrompt` setting are
written to a namespaced `ai-sdk.system` entry, and a session that silently
dropped or deprioritized it would degrade every later turn with no signal.

Three smaller documentation gaps, empirically characterized but nowhere
stated as contract: the value cap is charged on the **JSON
encoding** of the value, not the raw string (`actualBytes` in
`InstructionEntryValueTooLargeError` counts the encoding); there is no
stated key-namespacing convention or reserved-prefix list for the shared
per-session entry map (we namespace ours as `ai-sdk.system`); and it is
unstated whether a no-op re-`put` of an unchanged value is suppressed
server-side or announces another durable system message (we avoid re-puts
client-side to be safe).

## 2.0.24 source answers

Read from the `v2.0.24` source (not yet re-verified live, and not contract):

- **Precedence:** the model request's system prompt is
  `[agent.system || default, instruction baseline]` as separate parts
  (`packages/core/src/session/model-request.ts`), and entries are the last
  source in the baseline (`context.ts`). An entry is added after the agent
  prompt and never replaces it.
- **Compaction:** entries survive — `Compaction.Ended` rebases the
  instruction baseline to the current entry values (`projector.ts`,
  `instruction-state.ts`). This was already true at the beta commit.
- **No-op re-put:** a `put` of an unchanged value is a no-op server-side
  (`instruction-entry.ts`), so it does not announce another system message.
- **Cap:** `MaxValueBytes = 256 * 1024`, still charged on the JSON encoding.

## What would fix it upstream

Documentation of the two guarantees above — particularly compaction survival
and precedence relative to the agent prompt. No API change needed; the
mechanism is right.
