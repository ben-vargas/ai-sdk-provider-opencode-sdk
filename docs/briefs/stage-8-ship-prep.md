# Stage 8 — Ship prep: docs, examples, migration guide, version

## Goal

Make the package presentable and honest: README, examples, migration guide, CHANGELOG, model shortcuts, version metadata. **No publishing** — everything stops at a commit; the user decides when/whether to publish.

## Context (read first)

- `docs/opencode-sdk-v2-analysis.md` §2.2 docs list (what the README must stop claiming) and the v4→v5 settings table.
- `docs/v2-spike-findings.md` incl. the stage-6/7 beta-source addenda — the docs must describe **verified** behavior: steer is mid-turn context injection (NOT supersession/interrupt); `data:`-URI-only attachments; no native structured output; delivery default queue (provider) vs steer (server); wait-as-watchdog only.
- `docs/briefs/deferred.md` items 7 (model shortcuts) and 8 (examples/README) — resolve both; the rest of the ledger stays with its recorded reasons.
- The integration harness can serve a live catalog for model-shortcut verification (`model.list`).

## Deliverables (commits prefixed `stage-8:`)

1. **README rewrite** for the v5 surface: what it is (AI SDK v7 provider for OpenCode v2 beta), status banner (beta; requires an OpenCode v2 server — currently only the upstream beta branch built from source; link the harness docs), quickstart (baseUrl + caller-client backends first; discover/ensure documented with the published-binary caveat), settings reference, forms (`onForm`), approvals flow, structured-output honesty (degraded prompt-mode + opt-in `jsonRepair`; never claim native enforcement), files (`data:` URIs; `supportedUrls` semantics), sessions/exclusivity/`providerOptions.opencode.sessionId`, limitations section (per-prompt system degradation, tools not forwarded, steer semantics as verified). Remove every v1-era claim (questions, `createOpencodeServer`, hostname/port, native json_schema, per-request tools).
2. **Migration guide** `docs/migrating-v4-to-v5.md`: every removed/renamed/changed setting with before/after snippets, sourced from the analysis's v4→v5 table + what stages actually shipped (verify against `src/types.ts` — the code wins over the doc where they diverge, and note any divergence found).
3. **Examples**: rewrite `examples/` for v5 — basic-usage, streaming, form-handling (replaces question-handling), tool-approval round-trip, client-options (headers/fetch/baseUrl), abort; each runnable against the harness (`OPENCODE_BETA_URL`/`_PASSWORD` envs) with a clear header comment on server requirements; update the `example:*` npm scripts. Remove examples for features that no longer exist rather than porting them dishonestly.
4. **Model shortcuts (ledger #7)**: refresh `OpencodeModels` against the live harness catalog (`model.list`); keep only IDs verified present, note the catalog snapshot date in the JSDoc; drop unverifiable entries.
5. **CHANGELOG.md**: a real 5.0.0-beta entry — headline breaks, new features, the contract-first caveat (client pinned to beta-18286; no published compatible server binary yet), link to the migration guide.
6. **Version/meta**: `5.0.0-beta.1` in package.json (still no publish); verify `npm pack --dry-run` file list is sane (no spike/, integration/, docs/briefs leakage — adjust `files` if needed); description/keywords updated for v2.
7. **Ledger**: mark items 7/8 resolved; final pass that every remaining item carries a current reason.

## Checks

`npm run ci` green; `npm run build` + the dist smoke test green; `npm pack --dry-run` reviewed in the summary. Summary lists: every README claim you could NOT verify against code or artifacts (there should be none — if one exists, flag it rather than shipping it).
