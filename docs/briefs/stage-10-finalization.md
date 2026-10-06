# Stage 10 — Pre-push finalization (user decisions 1–3)

Three user-decided changes. All must pass the codex+grok sign-off loop.

## 1. Integration-suite test model: pin with fallback + default-model canary (decision C)

The suite currently takes its model from the server's `/api/model/default`, which is
`opencode/nemotron-3.5-lightning-free` — a model that accepts prompts and never answers,
so 12/15 tests time out for an upstream reason (see `docs/v2-spike-findings.md`).

- Harness test-model resolution order: `OPENCODE_TEST_MODEL` env override → pinned
  **`ollama-cloud/minimax-m3`** → server default (with a loud warning that the pin was
  unavailable). Verify at harness setup that the resolved model exists in the live
  catalog and produces an assistant message (bounded probe, max 2 attempts) before
  handing it to tests.
- The pin requires `OLLAMA_API_KEY` in the _server's_ env: pass it through from the host
  into the sandboxed server env (document this in the harness header; skip-with-message
  when absent). **Scope guard:** this pin is machine-local test infrastructure ONLY. It
  must NOT reintroduce `ollama-cloud/*` ids into `OpencodeModels` or any shipped code —
  the stage-8 decontamination stands.
- `// TODO:` comment at the pin: swap to `ollama-cloud/glm-5.3-flash` once it appears on
  models.dev (user request; cheaper).
- New `integration/default-model.test.ts`: a canary asserting the server's own default
  model produces an assistant message within a bounded window. When it fails, its
  message must say plainly "upstream default model appears broken" — so an upstream
  outage reads as exactly that, not as provider regressions.
- `approval.test.ts`: when the resolved model answers without calling the tool, the skip
  must be LOUD (console warning naming the untested approval path), not a silent pass.
- Run the full integration suite once with the pin (foreground, 1800s timeout, max 2
  attempts) and record the tally in your summary. If minimax-m3 itself won't tool-call
  or generate, record INCONCLUSIVE with evidence and leave the resolution chain in place.

## 2. Remove `sessionMode: "persistent"` (decision A)

It is a documented no-op. Remove the enum value everywhere: `src/types.ts`, validation,
README, migration guide (add a "removed in 5.0.0-beta.1" note with the `sessionId`
alternative), CHANGELOG, JSDoc, and any tests that reference it. Remaining values:
`"ephemeral" | "existing"`. `npm run typecheck` must prove nothing else referenced it.

## 3. Upstream-issue drafts → locally tracked known issues in `docs/known-upstream-issues/` (decision 3)

The user will NOT file these upstream; they become a local known-issues register to
re-check later. Rename the directory to `docs/known-upstream-issues/` and:

- **Keep (rewrite header + framing):** `structured-output.md`,
  `inbox-execution-correlation.md`, `client-cli-version-skew.md` (discoverability/tag
  framing — the "no published binary" claim is refuted; keep the two-package-names and
  stale-`latest`-tag facts).
- **`per-prompt-system.md`:** keep ONLY what is still genuinely open (undocumented
  precedence/compaction semantics of instruction entries — our empirical answers are in
  the findings doc); if nothing material remains open, delete it and say so.
- **Delete:** `file-ingestion.md` (withdrawn — described dev-CLI behavior the real
  server doesn't have).
- Each kept file gets a consistent header: status (`Known upstream issue — tracked
locally, not filed`), last-verified date + build (`opencode2 0.0.0-beta-18286`), a
  one-command "how to re-check" recipe, and evidence pointers. Add a short
  `README.md` index in the directory explaining its purpose.
- Remove every "[DRAFT — do not post yet]" framing; fix any remaining inaccuracies
  against the verified findings. Update references to the old path (grep the repo).

## Checks

`npm run ci` green; integration run per §1. Do NOT push. Summary: per-item outcome,
integration tally with the pin, and anything left open.
