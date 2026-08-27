# Stage 10b — Resolve codex's three sign-off holdouts

Stage-10 shipped all three user decisions and grok signed off, but codex withheld
approval across three rounds, ending with exactly these findings. Fix them (or rebut
with evidence). Commits prefixed `stage-10:` (same series).

1. **(major) The model-probe timeout does not bound its API requests.** The test-model
   probe in `integration/harness/test-model.ts` claims a bounded window but the
   underlying client calls carry no AbortSignal/timeout, so a hung server call can
   exceed the bound — the same unbounded-wait class that has deadlocked this pipeline
   before. Thread an `AbortSignal.timeout(...)` (or equivalent RequestOptions signal)
   through every API request the probe makes, and make the overall probe race a hard
   deadline. Test it.
2. **(major) Attach mode can skip a probeable pinned model.** In attach mode
   (`OPENCODE_BETA_URL`) the resolution chain can bypass probing/pinning it should
   perform. Make the resolution order identical in spawned and attach modes: env
   override → pinned `ollama-cloud/minimax-m3` (catalog check + probe) → server default
   with loud warning. Test both modes' resolution paths.
3. **(minor) Stale references to the deleted `docs/upstream-issues/` directory.** Grep
   the whole repo (docs, briefs, findings, code comments) and update every reference to
   `docs/known-upstream-issues/`.

`npm run ci` must stay green; run the integration suite once (bounded 1800s foreground)
to confirm the harness changes hold. Do NOT push.
