# [DRAFT — do not post yet] v2: no correlation key from prompt receipt → execution/steps → assistant messages

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, api, events

## Problem

v2's `session.prompt` returns an inbox receipt and completion is observed via events — but no event ties an execution/step back to the inbox item that caused it:

- Beta types (`@opencode-ai/client@0.0.0-beta-18286`): `session.execution.started/succeeded/failed/interrupted` carry only `sessionID`; `session.step.*` add `assistantMessageID`; neither carries the receipt/inbox id. `SessionInboxUser.id` appears only on inbox events.
- Live dev build (`0.0.0-dev-202608261632`, 2026-08-26): `session.next.prompt.admitted` / `session.next.prompted` do carry `messageID` (= the receipt id = the stored user message id — nice!), but `step.started {assistantMessageID}` still has no back-reference, and there are no execution-level events at all. Correlation is purely _ordering-based_: "the `step.started` after my `prompted` is probably mine."

Ordering-based attribution is only sound if the client exclusively owns the session. The moment a TUI, another SDK client, or a queued/steered inbox item shares the session, an event consumer can attribute another actor's execution (its deltas, usage, permission asks, and outcome) to its own prompt. Failure modes we hit while prototyping: a steered prompt admitted before `step.started` left ambiguous which prompt the eventual step belonged to; and on shared sessions there is no way to know whose turn an interrupt killed.

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). Each AI SDK call must return exactly the text/usage/finish of _its own_ turn. Today we can only guarantee that by creating a private session per conversation and forbidding shared-session use — an artificial restriction, and it still leaves a race between two calls on our own session (queue + steer). A single correlation field would eliminate the whole class.

## Ask

Add the originating inbox/user-message id to the turn-execution lifecycle:

1. `session.execution.started/succeeded/failed/interrupted` → include `inboxID` (or `messageID`) of the prompt being executed. This alone is sufficient.
2. Ideally also on `session.step.started` (steps already carry `assistantMessageID`; adding the trigger id makes step→turn grouping trivial and makes multi-assistant-message turns — which we observed: one message per step — reconstructable without ordering heuristics).
3. And/or on the assistant message itself (e.g. `SessionMessageAssistant.trigger: {messageID}`), so the durable record is self-describing after the fact.

The dev build's `prompted {messageID}` event shows the data is already available at dispatch time; it just needs to be propagated one hop further.
