# Stage 0 — Live-beta spike + upstream issue drafts

## Goal

Empirically answer the design-blocking open questions from `docs/opencode-sdk-v2-analysis.md` §5 against a **live OpenCode v2 beta server**, and draft (NOT post) the four upstream issues. Output is evidence, not code: every claim in your findings must cite a captured artifact.

## Deliverables (all committed with prefix `stage-0:`)

1. `spike/` — the scripts you ran (plain `.mjs` scripts using `@opencode-ai/client`), plus `spike/artifacts/*.json` capturing raw responses/events for each experiment.
2. `docs/v2-spike-findings.md` — one section per question below: verdict, evidence (artifact file + relevant excerpt), and which §5 open question it resolves. Distinguish clearly: **confirmed**, **refuted**, **inconclusive** (and why).
3. `docs/upstream-issues/{structured-output,per-prompt-system,file-ingestion,inbox-execution-correlation}.md` — GitHub-ready issue drafts for `anomalyco/opencode`: problem, provider use case, evidence from your spike, concrete API suggestion. **Do not post them or touch GitHub in any way.**
4. Do not modify `docs/opencode-sdk-v2-analysis.md` — it is a signed-off analysis; your findings doc layers on top.

## Setup

- The machine's global `opencode` is **1.18.23 — do not touch or upgrade it**. Install the beta CLI locally instead: `npm i -D opencode-ai@dev` (the dev build 202608261632 matches the SDK beta date; fall back to `opencode-ai@beta` if dev is broken) and run it via `./node_modules/.bin/opencode`. Record the exact CLI version paired with `@opencode-ai/client@0.0.0-beta-18286` (install that exact version as a devDependency too).
- Start the server per the v2 docs (`opencode serve --service` is the documented service command; check `--help` for the beta's actual flags, and note the registration file / `Service.discover()` behavior from `@opencode-ai/client/service`).
- Auth: the local opencode install is already authenticated (shared credentials likely apply to the beta). Where an experiment needs a real model generation, use the **cheapest configured model** and one-word prompts ("hi") — a handful of generations total. If no model works, mark generation-dependent questions inconclusive and answer everything observable without generation.
- Use a throwaway directory (e.g. `spike/sandbox/`) as the session `location` so experiments never touch this worktree's own files. Keep the server's working state isolated from the global 1.18 state if the beta allows (check for a data-dir/XDG override flag; if none exists, note the risk in findings and proceed carefully — read-only where possible).

## Questions (in priority order)

1. **File URIs**: which `files[].uri` schemes does `session.prompt` accept — `data:` (base64), `file://`, workspace-relative path, `https:`? Send a tiny PNG each way; check what the stored user message / model sees. This decides whether v5 keeps attachment support.
2. **`session.wait`**: does it resolve or reject when execution fails? What does it do while a permission or form is pending (hang, resolve, timeout)? Does it cover queued inbox items or only the current execution?
3. **Delivery/busy**: what is the default `delivery` when omitted? When exactly does `SessionBusyError` throw vs enqueue? Does `delivery: "steer"` interrupt the running turn with `reason: "superseded"`? What does `resume: true` actually resume?
4. **Correlation**: capture the full event stream for one prompt→completion cycle. What IDs appear on `session.execution.*` and `session.step.*`? Can the `SessionInboxUser.id` receipt be linked to the execution/assistant message by any field?
5. **Instructions**: does `session.instructions.entry.put` text reach model context (ask the model to repeat any instruction it was given)? Does it survive across turns?
6. **Forms**: does execution block on a pending form? What does `form.cancel` do to the turn (tool fails / turn fails / continues)?
7. **Event stream mechanics**: is `server.connected` emitted on subscribe (readiness handshake)? Are events replayed or live-only? Does breaking the `for await` loop close the connection?
8. **Usage semantics**: run one multi-step turn (a prompt that triggers a tool call); are `SessionStepEnded.tokens` per-step increments or cumulative? Does assistant-message `tokens` equal the sum?
9. **`migration.v1.status`** on a fresh v2 server: what does it return?

Timebox: this is a spike — prefer 9 rough answers over 4 polished ones. If the beta server won't start at all, document exactly what failed and produce the issue drafts from type-level evidence alone.

## Checks before finishing

`npm run ci` must still pass (spike scripts should not be picked up by the build/tests — keep them out of `src/`; add `spike/` to eslint/tsc ignores if needed).
