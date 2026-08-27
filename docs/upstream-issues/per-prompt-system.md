# [DRAFT — do not post yet] v2: document the guarantees of `session.instructions.entry` as the caller-supplied system-prompt channel

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, docs

> **Correction note (2026-08-27).** An earlier revision of this draft asked
> for a per-prompt/per-session system field on the grounds that no working
> mechanism existed. That premise is **withdrawn**: the mechanism exists and
> works. `session.instructions.entry` was previously untestable only because
> we were probing servers that did not implement it (the v1-lineage
> `opencode-ai` dev/beta CLIs route no `session.instructions.*` at all, and
> the embedded `@opencode-ai/sdk@0.0.0-beta-18286` host answers `entry.put`
> and `entry.list` with empty-body 500s). Against the published
> `@opencode-ai/cli@0.0.0-beta-18286` (`opencode2`) it behaves correctly. We
> have shipped on it. What remains is a **documentation** request.

## What we verified

Against `opencode2@0.0.0-beta-18286` with the matching client
(`spike/14b-instruction-entries.mjs`, raw capture in
`spike/artifacts/14b-instruction-entries.json`):

| Behaviour                                               | Result                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `entry.put` / `entry.list` / `entry.remove` round-trip  | works                                                                                 |
| Entry set before the first prompt reaches the model     | yes                                                                                   |
| Still applies on turn 2 of the same session             | yes                                                                                   |
| Entry put **mid-session** applies on a later turn       | observed, but not in the committed capture (its follow-up turns timed out under load) |
| A mid-session put announces a durable `system` message  | yes                                                                                   |
| `entry.remove` stops the instruction applying           | yes                                                                                   |
| Key grammar `^[a-z0-9][a-z0-9._-]*$` enforced           | yes                                                                                   |
| Value cap 8192 bytes, measured on the **JSON encoding** | yes                                                                                   |
| An entry overrides the agent's own system prompt        | **not established** — see below                                                       |

The rendered form observed on the announcing system message is

```
<context key="ai-sdk.system">
…value…
</context>
```

with `description: "Instructions updated: api/ai-sdk.system"`.

One packaging note found while building that probe, in case it is
unintentional: a config-defined `agent.<name>.system` string is surfaced as
`Agent.Info.request.body.system` — a provider request-body override, which
the OpenAI-compatible model package drops — so the agent never receives it.
The same prompt written as the body of
`$XDG_CONFIG_HOME/opencode/agent/<name>.md` populates `Agent.Info.system` and
does reach the model.

The remove test was designed to exclude transcript contamination: the entry
was put **and removed before the session was ever prompted**, so the model
could not have learned the value from conversation history. It did not
produce it.

## What is still undocumented

None of the above is stated anywhere we could find, so every one of these is
a behaviour we are relying on by observation rather than by contract:

1. **Role and precedence.** Entries appear to join the instruction baseline
   _after_ the agent's own system prompt. Is that ordering guaranteed? Can an
   entry override agent instructions, or is that incidental? We could not
   settle this by observation: a two-arm probe (an agent carrying a
   contradicting formatting rule, run with and without a contesting entry)
   showed the agent's rule being followed in the control arm, but the
   contested arm did not produce a usable answer, so we have no evidence
   either way in a reproducible capture. This is the guarantee we would most
   like written down rather than inferred.
2. **Compaction.** Do entries survive compaction — are they re-rendered into
   the compacted context, or can a long session silently lose them? This is
   the one we most need and could not practically test.
3. **The size cap is charged on the JSON encoding, not the raw value.** An
   8190-character ASCII value is accepted (8190 + 2 quotes = 8192); 8191 is
   rejected at 8193 bytes. Multi-byte characters are charged their UTF-8
   length and JSON-escaped characters their escaped length. That is a
   reasonable implementation, but a caller budgeting against "8 KiB" will
   overshoot. `InstructionEntryValueTooLargeError` does report `actualBytes`
   and `maxBytes`, which is excellent — it just is not documented that
   `actualBytes` counts the encoding.
4. **Key namespacing convention.** Multiple writers share one session's entry
   map, so keys are a collision surface. We namespace ours (`ai-sdk.system`).
   Is there an intended convention, or reserved prefixes we should avoid?
5. **Redundant writes.** We avoid re-`put`ting an unchanged value because a
   put announces a durable system message. Is a no-op put actually
   suppressed server-side, or is avoiding it the caller's job?

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). The AI
SDK contract lets every call carry a `system:` message. We now map that (and
our own `systemPrompt` setting) onto a namespaced instruction entry, which
fixed a real limitation: the previous fallback — prepending a delimited
pseudo-system block to the first user turn — lost system-role priority,
leaked into the visible transcript, and did not apply at all to reused
sessions.

## Ask

Document the guarantees above — particularly **compaction survival** and
**precedence relative to the agent prompt** — so callers can depend on them
rather than infer them. No API change requested; the mechanism is right.
