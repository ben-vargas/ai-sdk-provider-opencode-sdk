# v2 has no correlation key from prompt receipt → execution/steps → assistant messages

**Status:** Known upstream issue — tracked locally, not filed.
**Last verified:** 2026-10-06, against the `@opencode/cli@2.0.24` source and a live 2.0.24 run — still present: execution lifecycle events carry only `{sessionID}` and `session.step.started` has no back-reference to the prompt (`packages/schema/src/session-event.ts`). `receipt.id` still equals the stored user message id (observed live in the integration suite's steer capture). 2.x adds a durable `idle` message recording each execution's outcome, which marks turn boundaries but does not correlate them. First verified 2026-08-27 on `opencode2 0.0.0-beta-18286`.
**How to re-check** (against a newer build; issue stands while `inboxID` stays undefined on execution events):

```bash
OC2_URL=http://127.0.0.1:14396 OC2_PASSWORD=<pw> OC2_WORKDIR=/tmp/oc2-verify/workdir \
  node spike/14-opencode2-verification.mjs && \
  jq '.v2SimpleTurn.executionEventsCarryInboxID' spike/artifacts/14-opencode2-verification.json
```

(Server launch recipe: header of `spike/14b-instruction-entries.mjs`.)

**Evidence:** `spike/artifacts/14-opencode2-verification.json` → `v2SimpleTurn.events`.

## Problem

v2's `session.prompt` returns an inbox receipt and completion is observed via events — but no event ties an execution/step back to the inbox item that caused it. Verified on the wire against `opencode2@0.0.0-beta-18286`: a complete simple turn emits `session.execution.started` and `session.execution.succeeded` whose entire payload is `{sessionID}` — no `inboxID`, no `messageID`, nothing tying the execution to the receipt that caused it. `session.step.*` events add `assistantMessageID` but likewise no back-reference to the trigger. The one good correlation that _does_ exist is on the durable record: `receipt.id` equals the stored user message id (`userMessageIdEqualsReceiptId: true`) — which is why post-hoc reconciliation works and live attribution does not.

(Historical note: a 2026-08 dev-channel build — a different protocol generation — had `session.next.prompt.admitted`/`session.next.prompted` events carrying `messageID`, showing the data is available at dispatch time; it was just never propagated to the execution/step events.)

Ordering-based attribution is only sound if the client exclusively owns the session. The moment a TUI, another SDK client, or a queued/steered inbox item shares the session, an event consumer can attribute another actor's execution (its deltas, usage, permission asks, and outcome) to its own prompt. Failure modes hit while prototyping: a steered prompt admitted before `step.started` left ambiguous which prompt the eventual step belonged to; and on shared sessions there is no way to know whose turn an interrupt killed.

## Why it matters to this provider

Each AI SDK call must return exactly the text/usage/finish of _its own_ turn. Today we can only guarantee that by creating a private session per conversation and forbidding shared-session use — an artificial restriction, and it still leaves a race between two calls on our own session (queue + steer). A single correlation field would eliminate the whole class.

## What would fix it upstream

Add the originating inbox/user-message id to the turn-execution lifecycle:

1. `session.execution.started/succeeded/failed/interrupted` → include `inboxID` (or `messageID`) of the prompt being executed. This alone is sufficient.
2. Ideally also on `session.step.started` (steps already carry `assistantMessageID`; adding the trigger id makes step→turn grouping trivial and makes multi-assistant-message turns — observed: one message per step — reconstructable without ordering heuristics).
3. And/or on the assistant message itself (e.g. `SessionMessageAssistant.trigger: {messageID}`), so the durable record is self-describing after the fact.
