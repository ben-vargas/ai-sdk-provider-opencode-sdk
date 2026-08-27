# Stage 6 — Beta-source integration harness + spike re-verification

> **Stage-9 correction (2026-08-27).** This brief's premise — that the only
> server speaking the pinned client's contract is the `anomalyco/opencode`
> `beta` branch built from source — is **wrong**, and was wrong when written.
> The matching server is published as **`@opencode-ai/cli`** (binary
> **`opencode2`**) at the same build number as the pinned client. The earlier
> conclusion came from probing **`opencode-ai`**, the *v1* package name.
> Stage 9 retargeted the harness to the published binary; the source build
> survives only as an opt-in fallback behind `OPENCODE_BETA_SRC_DIR`. The
> deliverables below were executed as written and their *findings* stand —
> only the "source-build-only" framing is superseded.


## Goal

Real integration tests against the only server that speaks our contract: the `anomalyco/opencode` **`beta` branch built from source**. Then re-verify the spike answers that came from the mismatched dev CLI, and correct any design decision they change.

## Context (read first)

- `docs/v2-spike-findings.md` — which answers came from the dev-branch server (different protocol) vs type-level evidence. The dev-derived behavioral answers (delivery default steer, busy/409 behavior, correlation observations, step semantics) are the ones needing re-verification.
- Upstream facts (verified): branch `beta` on `github.com/anomalyco/opencode` is the v2 line; commit `f4a9b930` (2026-08-26T15:12Z) matches our pinned `@opencode-ai/client@0.0.0-beta-18286`; the repo is bun-based; bun 1.3.14 is installed locally.
- `docs/briefs/deferred.md` — do NOT implement deferred items this stage; stage 7 does, informed by your findings.
- Embedded entrypoint is upstream-blocked (Bun-only ESM in the beta sdk) — out of scope; see deliverable 5.

## Deliverables (commits prefixed `stage-6:`)

1. **Harness** (`integration/harness/`): scripts that (a) shallow-clone the beta branch pinned at `f4a9b930` into `~/.cache/opencode-beta-src` (OUTSIDE the worktree; never committed; idempotent — reuse an existing clone at the right commit), (b) `bun install` it, (c) locate and start the server package from source with an isolated XDG/data home and a sandbox workspace directory, (d) health-check and export the endpoint for tests, (e) tear down cleanly. Timebox realism: if source build/run proves impossible (build errors, missing internal tooling), capture exactly what failed, fall back to documenting the blocker, and still ship the gated test scaffolding.
2. **Gated integration suite** (`integration/*.test.ts`, separate vitest config + `npm run test:integration`; auto-skips with a clear message when the harness is unavailable; NOT part of `npm run ci`): prompt→stream→finish round-trip via the real provider; doGenerate reconciliation; abort (pre/post delivery); busy/Conflict + queue behavior; file `data:` URI attach; approval round-trip if permissions can be triggered; usage/finish assertions.
3. **Spike re-verification** (`docs/v2-spike-findings.md` — append a "Beta-source server verification" section, do not rewrite history): re-run the delivery-default, busy-semantics, correlation-ID, `session.wait`, `server.connected`, and step-token experiments against the true beta server. For each: confirms/contradicts the earlier answer. **Where a contradiction changes a shipped default (e.g. provider queue default, readiness handshake, ConflictError-vs-SessionBusyError), fix the code in this stage** with tests, and say so loudly in your summary.
4. **Contract snapshot check**: assert the source-built server's OpenAPI (if it exposes one) against the pinned client's expectations; record drift found (the branch tip is ~90 min newer than our pin) — drift is a finding, not necessarily a fix.
5. **Docs**: `docs/upstream-issues/client-cli-version-skew.md` gains the embedded-host Bun-only-ESM packaging point and the "beta branch source is the only compatible server" evidence; `docs/briefs/deferred.md` updated with anything this stage defers.

## Safety rails

Everything runs with an isolated data home and sandbox workspace; never touch the global opencode state or this worktree's files from server-side tool execution (create sessions only in the sandbox dir). Model generations: cheapest configured model, tiny prompts, few calls. The clone dir is cache — safe to delete/recreate.

## Checks

`npm run ci` stays green (integration suite excluded). Summary: harness status (works / blocked-with-evidence), re-verification verdict table (confirmed vs changed, with code changes listed), drift observations.
