# Stage 2 — V2 event reducer + fixture library

## Goal

The heart of v5: a pure, deterministic reducer that turns `V2Event` streams into AI SDK `LanguageModelV4StreamPart`s, developed against a hand-built fixture library. No language-model orchestration yet (that's stage 3+) — this stage is the reducer, its state, and its tests.

## Context (read first)

- `docs/opencode-sdk-v2-analysis.md` §1.6 (event model, durable split, correlation), §2.2 (convert-from rewrite spec), §3.1–3.4.
- `docs/v2-spike-findings.md` — **caution**: the spike's captured event streams came from the DEV-branch server speaking a _different_ protocol (`session.next.*`). They are NOT valid fixtures for this reducer. Fixtures must be hand-built from the beta-18286 types (`node_modules/@opencode-ai/client`, cross-checked against `/Users/ben/.flowition/workflows/ai-sdk-provider-opencode-sdk/context/client-beta/package/dist/promise/generated/types.d.ts`). Behavioral answers from the spike (per-step token increments, one assistant message per step, steer-supersedes-at-step-boundaries) DO inform expected semantics.
- Stage-1 code: `src/client-port.ts`, `src/types.ts`.

## Deliverables (commits prefixed `stage-2:`)

1. **`src/convert-from-opencode-events.ts`** — full rewrite per the analysis:
   - Typed on the `V2Event` union imported from `@opencode-ai/client`; a normalization layer accepting live `V2Event` OR `SessionLogItem` (durable events + `log.synced` sentinel) — never assume log replay yields `V2Event`.
   - Per-event-type session-ID extraction (`data.sessionID` for most; `data.form.sessionID` for `form.created`).
   - Delta mapping: text/reasoning keyed `${assistantMessageID}:{text|reasoning}:${ordinal}` (kind in the identity — shared ordinal keyspace); tool input keyed by tool `id` with `name` captured at `input.started`.
   - Tool lifecycle → `tool-input-start/delta/end`, `tool-call` (map `executed` → `providerExecuted`), `tool-result` from success/failed content arrays (serialize the `ToolContent` array as structured JSON; emit file entries — `data:` handling per stage-1's `isDataUri` policy — as separate parts; raw array into providerMetadata). No v1 `title` enrichment (no typed v2 source).
   - Approval buffering (issue #22 semantics): `PermissionAsked` correlates via `data.source?.id`, buffered until the tool call is registered; source-less requests emit immediately keyed by request id.
   - Form events route to a handler callback slot in the reducer state (no fabricated model content).
   - Usage/finish: consume `SessionStepEnded` AND `SessionStepFailed` (finish `"content-filter"`, cost, tokens); per-step increments accumulate (spike-confirmed). Terminal state from `session.execution.succeeded/failed/interrupted` (map reasons: user→stop, superseded→other, shutdown→error; provisional, note in code) with `session.idle` as backstop only; never finish on an intermediate step's `"tool-calls"`.
   - `includeRawChunks` support: optionally emit `{type: "raw", rawValue: event}` before semantic parts.
   - Duplicate durable events must be idempotent.
2. **`test/fixtures/v2-events/`** — hand-built, type-checked fixture sequences (each a `.ts` exporting a typed event array + expected stream parts): simple text turn; reasoning+text interleaved; multi-step tool turn with per-step usage; tool failure; step-failed with content-filter; permission before tool-input-available (the #22 matrix) and source-less permission; form created mid-turn; execution interrupted (all three reasons); duplicate durable events; delta after a missed `started` (tolerate or resync deliberately — document which); `log.synced` sentinel; out-of-order ordinals across two text blocks.
3. **`src/map-opencode-finish-reason.ts`** — shrink to the table map (5 direct + unknown→other, `raw = rawFinish ?? finish`) plus `SessionStructuredError` normalization; delete v1 error-name switching and structured-output overrides.
4. **Client-port additions** (carrying stage-1 review minors): add `session.inbox.cancel` and `session.log` to `src/client-port.ts`; annotate the delivery-default divergence (design doc recommends provider-default `queue`; spike observed server default `steer`) at the `delivery` setting; resolve the `sessionId`+`sessionMode` ambiguity with an explicit rule + warning (pinning an existing session implies mode "existing"; conflicting combinations warn).
5. **`docs/known-upstream-issues/client-cli-version-skew.md`** (directory renamed from `upstream-issues` in stage-10) — new short draft: npm `@opencode-ai/client@beta` (build 18286, from the `beta` branch) has no published CLI/server binary at the same contract generation (`opencode-ai@dev` = dev branch/older protocol; `opencode-ai@beta` = Aug 11 build); ask for paired publishes or a documented compatibility matrix. Cite spike artifacts. Do NOT post.

## Checks

`npm run ci` green. Reducer tests must be table-driven over the fixture library and deterministic. State in your summary any fixture whose expected output required an interpretation the design doc doesn't settle — those become stage-3 inputs.
