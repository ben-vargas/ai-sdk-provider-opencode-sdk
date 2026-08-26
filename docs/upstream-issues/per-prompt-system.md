# [DRAFT — do not post yet] v2: no per-prompt/per-session system prompt on the network API

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, api, feature

## Problem

v1 accepted `system` on `session.prompt`. In the v2 beta (`@opencode-ai/client@0.0.0-beta-18286`) there is no way to inject a system prompt over the network API:

- `SessionPromptInput` has no `system` field; `SessionCreateInput` is `{id?, title?, agent?, model?, location?}` — no system/instructions either.
- The closest candidate, `session.instructions.entry.put({sessionID, key, value})`, is undocumented as to whether entries reach model context, with what role/priority, and whether they survive compaction. We tried to verify empirically (2026-08-26) and could not: the dev-channel CLI (`0.0.0-dev-202608261632`) does not route `session.instructions.*` at all, and on the embedded host (`@opencode-ai/sdk@0.0.0-beta-18286`) both `entry.put` and `entry.list` return empty-body 500s.
- Plugins restore this in embedded mode via the session `context` hook — `session.hook("context", (ctx) => { ctx.system.push(...) })`, where `SessionContext.system` is a mutable `Array<SystemPart>` (`@opencode-ai/plugin@beta-18286`) — but network-only clients have no equivalent.

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). The AI SDK contract lets every call carry a `system:` message; today we forward it to v1's `prompt.system`. Without a v2 equivalent our only option is prepending a delimited pseudo-system block to the first user turn — which loses system-role priority, leaks into the visible transcript, and breaks on reused sessions where the first turn is long gone. Any AI SDK app that sets `system:` (nearly all of them) silently degrades.

## Ask

1. What is the intended v2 story for caller-supplied system context on the network API?
2. If `session.instructions` is that story, please document/confirm:
   - whether entries are injected into model context (as system role? where in priority order?),
   - persistence across turns and compaction,
   - and implement it in the served builds.
3. Otherwise, concrete suggestion: `session.create({ …, instructions?: string })` and/or `session.prompt({ …, system?: string })` (applied for that turn only), mirroring what agents already get via config. Either placement unblocks us; per-session is enough if per-turn is philosophically off the table.
