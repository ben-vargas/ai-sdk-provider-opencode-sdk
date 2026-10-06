# Stage 4 — OpencodeLanguageModel core (doGenerate + doStream)

## Goal

The orchestration heart: a full rewrite of `src/opencode-language-model.ts` implementing `LanguageModelV4` over the stage-1 client-port, stage-2 reducer, and stage-3 converter/error boundary. Tested entirely against scripted fake client-ports (no real server exists for this contract — see spike findings). The provider factory/client-manager backends are stage 5; this stage may keep a thin test-only port injection.

## Context (read first)

- `docs/opencode-sdk-v2-analysis.md` §2.2 (opencode-language-model entry — the doGenerate/doStream recipes, approval two-phase round-trip, session establishment), §1.3/1.6 (prompt contract, correlation gap), §2.1 table rows (structured output, system, files, busy/delivery).
- `docs/v2-spike-findings.md` (delivery default steer observed; receipt id = stored user-message id; per-step semantics).
- Stage-2 fix note: synthetic source-less permission `tool-call`s (PERMISSION_TOOL_NAME) are approval carriers, never executable tools — orchestration must not expect tool-results for them.

## Core requirements (all from the validated design; deviations must be justified in your summary)

1. **Session establishment**: `resolveSessionMode`/`resolveSessionLocation` from stage 1; one model instance = one conversation = one pinned session; `session.create({title, agent, model, location})` with the bare-model-ID rule (omit `model` when no providerID; bare-ID+variant resolves via catalog or rejects); `createNewSession` = per-call isolation EXCEPT approval-only continuation calls, which always reattach to the pinned blocked session; `providerOptions.opencode.sessionId` per-call escape hatch.
2. **doStream**: subscribe via client-port BEFORE prompting with a readiness handshake (`server.connected` if emitted, else a bounded race — the spike confirmed server.connected exists); prompt → receipt; feed the reducer; finish only from execution terminal events (idle backstop); post-dispatch failures never surface retryable (use the stage-3 `reconcile` marker → internal reconciliation via wait/log/message.list); abort → `inbox.cancel` if undelivered else `interrupt({continue:false})`; `SessionBusyError` → retry once with `delivery:"queue"` then surface non-retryable; provider default delivery `"queue"` (documented divergence from observed server default steer); `includeRawChunks` passthrough.
3. **doGenerate**: same subscribe-first skeleton driving the reducer to completion, then reconcile against `message.list`/`session.message` (fetch keyed by `assistantMessageID`s seen); map content/finish/usage/cost per the reducer + message data.
4. **Approvals (two-phase)**: phase-1 surfaces `tool-approval-request` and finishes; phase-2 detects approval-only prompts (approval responses, no new user content) → subscribe+readiness FIRST → `permission.reply({sessionID, requestID, reply})` → observe the original execution to completion → return its result; never issue `session.prompt` on an approval-only call; dedupe replied approvals per session.
5. **Forms**: `onForm` callback with keyed answers via `form.reply`; `formPolicy: "cancel"` default (cancel via `form.cancel` when unhandled); the stage-2 reducer's form slot delivers the events; port the v1 dedup/in-flight machinery keyed by form id.
6. **Structured output**: `responseFormat: json` → `{type:"unsupported"}` warning + the converter's JSON instruction; no retry loop in this stage (deferred; document).
7. **Headers**: per-call `options.headers` (undefined-filtered) merged into EVERY port request of the generation.
8. **providerMetadata**: sessionId, inboxId, messageId(s), finish/rawFinish, tokens, cost, interruptReason, retry, structured error, form/permission ids — per the types.ts contract.

## Carried stage-3 review minors (verify then fix)

- Restore a URL-looking-string guard for file `data.data` (v1 had it; attach-broken risk).
- Escape interpolated text in `prependSystemBlock` and the inline file-delimiter `name="…"` attribute.
- Either populate `OpencodeFileToResolve.data` for byte parts or remove the field (no dead public API).

## Tests

Scripted fake client-port driving full doGenerate/doStream scenarios: happy text turn; multi-step tool turn; approval phase-1→phase-2 round-trip (incl. reattach under `createNewSession`); form answer + cancel paths; abort pre/post delivery; busy→queue retry; post-dispatch wait failure → reconciliation (not retryable); readiness handshake timeout; headers propagation assertion on every port call; providerMetadata completeness. Reuse stage-2 fixtures for event scripts where possible.

## Checks

`npm run ci` green. Summary must list: any design-doc requirement deferred (and why), and the exact public surface stage 5 (provider factory/backends) must wire up.
