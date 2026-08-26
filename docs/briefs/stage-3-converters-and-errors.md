# Stage 3 — Prompt converter + error boundary (+ carried reducer minors)

## Goal

The two remaining pure modules the language model (stage 4) will orchestrate: AI SDK prompt → v2 prompt-input conversion, and the typed error boundary with phase-aware retryability. Plus three small carried-forward reducer improvements from stage-2 review.

## Context (read first)

- `docs/opencode-sdk-v2-analysis.md` §2.2 (convert-to and errors.ts entries), §2.1 gaps table (system prompt, files, history rows), the universal phase-aware retry rule in the errors entry.
- `docs/v2-spike-findings.md` Q1 (data:-URI-only; MIME from URI mediatype), Q3 (delivery/busy observations).
- Stage-1/2 code: `src/types.ts` (`OpencodeDataUri`, `isDataUri`, `resolveSessionLocation`, `resolveSessionMode`), `src/client-port.ts`, the new reducer.

## Deliverables (commits prefixed `stage-3:`)

1. **`src/convert-to-opencode-messages.ts`** — rewrite to produce `{text, files, warnings, systemBlock}`:
   - Transcript serializer with stable delimiters/escaping for multi-role history (system separated into `systemBlock` so stage 4 can degrade it network-mode — delimited prepend + `{type:"unsupported"}` warning — while a future embedded mode injects it properly).
   - Persistent/existing-session mode: only the latest user turn is serialized (OpenCode owns the transcript); ephemeral mode: full history. Take the mode from `resolveSessionMode`.
   - Files: AI SDK file parts → `data:` URIs via the stage-1 policy (`isDataUri`, `resolveFileToUri` hook for non-convertible inputs); bytes/base64 → data URI with mediaType; anything non-convertible warns and is skipped BEFORE prompting (never attach-and-fail-late). Remember `supportedUrls` stays `{}` (bytes-only; AI SDK downloads URLs).
   - Tool results/approvals in history render as delimited text context (as v1 did), with the note that OpenCode cannot consume them as real tool results.
   - The JSON-mode instruction helper survives as the structured-output degradation path (schema embedded, no enforcement claim).
2. **`src/errors.ts`** — rewrite:
   - Guards for the beta tagged errors (`_tag` + exported `isXxxError` re-use where the package provides them) and total `ClientError.reason` mapping (all five reasons per the design doc, incl. version-skew hint on `UnsupportedContentType`/`MalformedResponse`).
   - **Phase-aware retryability as an explicit API**: `wrapError(error, {phase: "pre-dispatch" | "post-dispatch", ...context})` — no error of any kind may produce `isRetryable: true` post-dispatch; post-dispatch failures get a marker stage 4 uses to trigger internal reconciliation instead. `UnexpectedStatus` promises no status code (guarded cause inspection only).
   - `SessionStructuredError` normalization path for event-carried failures; abort detection for caller signals; delete every v1 envelope/error-name relic.
3. **Carried reducer minors (stage-2 review, verified against the code before changing):**
   - `finishEmitted` gate: after finish is emitted, content/tool events produce raw-only output (no new blocks post-finish) — make the finish-is-last invariant reducer-owned.
   - `buildUsage`: add the code comment documenting that `outputTokens.total` intentionally mirrors v1/OpenCode `output` (reasoning disjoint per spike Q8 arithmetic; composition unresolved upstream — open Q7); do NOT change the arithmetic.
   - Warn (via `state.logger`) when a malformed tool-result file entry is dropped, matching the module's diagnostics discipline.
4. Tests: table-driven converter tests (roles/modes/files/system/warnings), error-boundary tests per `_tag` and per `ClientError.reason` × phase, reducer regression fixtures for the finishEmitted gate.

## Checks

`npm run ci` green. Summary must list any converter behavior the design doc leaves open that stage 4 will need to decide.
