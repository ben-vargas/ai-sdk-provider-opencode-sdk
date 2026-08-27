# Deferred-item ledger

Items intentionally deferred by earlier stages. Stage 7 (hardening) and
stage 8 (ship prep) picked these up explicitly, informed by the stage-6
beta-source findings; anything deferred further must stay on this list with
a reason. Stage-8 status: items 1, 3, 4, 7, 8, 10 resolved; items 2, 5, 6,
9, 11 remain open, each with a current reason (re-checked stage 8 — all
are upstream-blocked or no-demonstrated-need, unchanged since stage 7).

## Deferred from stage 4 (language model)

1. **`session.wait` watchdog.** ~~Not wired in.~~ **Resolved (stage 7).**
   The pump now arms a `session.wait` watchdog once `session.execution.
started` is observed (the one case whose wait semantics stage 6 pinned)
   and races it against event-driven completion. Wait resolving while
   events show no terminal drains a short grace window
   (`waitWatchdogGraceMs`, default 2000 ms), then reconciles from the
   message store — finalizing only on stored proof the turn concluded,
   never completion-by-wait (events stay primary; wait's behavior under
   steer/queue/interrupt stays unpinned upstream). Wait failures disarm the
   watchdog silently per the phase rule (never surfaced retryable); the
   silence watchdog remains the backstop. Covered by unit tests and a gated
   integration test (`integration/wait-watchdog.test.ts`) confirming the
   watchdog is a no-op on a healthy turn.
   _Stage-6 evidence (corrected on review):_ `wait` is implemented on
   the beta-source server and, with execution confirmed started before the
   call, **resolved within event-stream latency of
   `session.execution.succeeded`** on long busy turns (8317 ms vs 8320 ms,
   21229 ms vs 21229 ms) — it tracks turn completion on this build. An
   earlier mid-turn-resolution reading (~2.8 s) lacked terminal-event
   correlation and was a measurement artifact
   (`spike/artifacts/12-beta-src-verification.json` → `waitBusy`).
2. **`session.log` catch-up.** SSE-drop recovery via the durable log
   (`session.log({after, follow})`, sequence numbers) is not implemented; the
   reducer's input layer already normalizes `SessionLogItem` vs live
   `V2Event` (stage 2), so this is wiring work in the model's recovery path.
   _Stage-6 evidence:_ on the beta-source server the route yields **only**
   the `log.synced` sentinel even with `after: 0` on a session holding 16
   durable events — historical replay is unimplemented upstream, so recovery
   must keep using the message store until that lands.
   _Re-examined stage 7, still deferred:_ upstream-blocked — with no
   historical replay to wire against, the message-store recovery path
   (which stage 7 extended further) remains the only working option.
3. **`inbox.list` delivery-uncertainty reconciliation.** **Resolved
   (stage 7).** A reconcile-marked `session.prompt` failure now triggers a
   single bounded (3 s) `session.inbox.list` check before the message-store
   fallback: a pending user item matching the dispatched prompt (by
   caller-supplied id when one was sent, else exact text) is adopted as the
   turn's receipt and the pump keeps observing the running turn. Because
   the beta inbox table is **pending-only** (`projectDelivered` deletes the
   row in the same transaction that promotes it), an inbox miss is _not_
   proof of non-delivery: the miss — or the check itself failing — next
   drains the live subscription for same-session activity events
   (inbox/execution/step/content/permission/form; `session.idle` excluded
   as ambiguous) for a bounded window (`deliveryEvidenceWindowMs`, default
   3 s) and keeps observing when activity is found. Only with no pending
   row _and_ no live activity does it fall through to the prior behavior
   (reconcile, else surface the non-retryable error) — reached only when
   the subscription itself is dead, where the message store is the sole
   remaining source. Unit-tested for the enqueued, delivered-before-check,
   absent, foreign-item, and check-fails branches.
4. **JSON validate/repair loop.** **Resolved (stage 7), opt-in.** New
   `jsonRepair?: { maxAttempts?: number }` setting (default off; 1 attempt
   when enabled bare). On doGenerate with `responseFormat: json`, the final
   text is validated client-side: `JSON.parse` plus a dependency-free
   recursive structural validator against the AI SDK-supplied schema,
   covering the subset the AI SDK's zod conversion emits (`type` incl.
   unions/`integer`, `properties`, `required`, `items`, `enum`, `const`,
   `additionalProperties: false`); unsupported keywords (`$ref`,
   combinators, string/number constraints) are deliberately permissive so
   a keyword gap can never trigger a spurious repair — the AI SDK caller
   re-validates the final object regardless. Failures are repaired via the
   port's `generate.text` (documented upstream as session-less/tool-less/
   history-less — the original turn is never replayed, keeping the design
   doc §2.1 side-effect gate closed), bounded by `maxAttempts`, and a
   repair that itself fails validation is not accepted; a warning records
   attempts used. The unsupported-format warning stays regardless.
   doStream is excluded (streamed output cannot be recalled).

## Deferred from stage 5 (provider + backends)

5. **Embedded backend / `./embedded` entrypoint.** Per the brief, only the
   seam ships: `createClientManagerFromPort(port)` wraps an injected port in
   a manager the factory accepts via the `clientManager` setting. The actual
   in-process host construction (`OpenCode.create()`, optional peer on
   `@opencode-ai/sdk`, plugin hooks for true system prompts / tool filtering /
   permission policy) is future work.
   _Re-examined stage 7, still deferred:_ upstream-blocked and no
   demonstrated need — the embedded host remains half-broken at the pinned
   beta (stage-0 finding 0.2) and every stage-6/7 scenario runs through the
   network backends; the `createClientManagerFromPort` seam stays the
   supported injection point.
6. **Version-predicate gating outside the service backend.** The health
   preflight gates on `service.version` only for the service backend (where
   the option lives; discovery/ensure gate on it too — the health re-check
   catches stale registrations). `baseUrl` and caller-supplied clients log
   the version but have no gating knob; add one if a real need appears.
   _Re-examined stage 7, still deferred:_ no demonstrated need — no skew
   incident has surfaced on `baseUrl`/caller-client backends, and the
   preflight already logs the server version for diagnosis.
7. **Model shortcut refresh.** **Resolved (stage 8).** `OpencodeModels`
   was refreshed against the live beta-source harness catalog
   (`model.list`, commit `f4a9b930`, snapshot 2026-08-27 UTC): only the
   eight IDs verified present remain (six zen free-tier `opencode/*`
   models plus the two built-in ollama cloud entries), with the snapshot
   date and the catalog's server/credential dependence noted in the JSDoc.
   The v4-era Anthropic/OpenAI/Google IDs were dropped — no reachable v2
   catalog could verify them (they only appear once those providers'
   credentials are configured on a server).
8. **Examples + README rewrite.** **Resolved (stage 8).** README rewritten
   around the v5 surface (status banner with the no-published-binary
   caveat, backends, sessions/exclusivity, approvals, forms,
   structured-output honesty, `data:`-URI files, settings reference,
   limitations with verified steer semantics); every v1-era claim removed.
   `examples/` replaced with six examples runnable against the harness via
   `OPENCODE_BETA_URL`/`OPENCODE_BETA_PASSWORD` (basic-usage, streaming,
   form-handling, tool-approval, client-options, abort-signal — all
   executed green against a live beta-source server); v1/v4-only examples
   deleted. Migration guide added (`docs/migrating-v4-to-v5.md`) and a real
   5.0.0-beta.1 CHANGELOG entry written.

## Deferred from stage 6 (integration harness)

9. **`file:` URI passthrough in `resolveFileToUri`.** The beta-source server
   now reads and normalizes readable `file:` URIs server-side (and rejects
   unreadable ones at prompt time), so a `file:` return from the resolver
   hook would work against beta servers. The hook's type and the provider's
   preflight still allow `data:` only — loosening it is a deliberate surface
   change (server-filesystem coupling, older servers store the raw URI and
   fail the turn late) deferred until the beta contract is the only one we
   target (`spike/artifacts/12b-beta-src-file-uris.json`).
   _Re-examined stage 7, still deferred:_ nothing changed upstream — the
   build-dependence (dev builds still store non-`data:` URIs raw and fail
   late) is exactly the failure mode the `data:`-only preflight exists to
   prevent, so the gate stands until beta is the sole target.
10. **Steer multi-step supersession re-test.** **Resolved (stage 7) —
    stage-0 refuted for the beta source.** A dedicated live experiment
    (`integration/steer-supersede.test.ts`; evidence
    `spike/artifacts/13-steer-supersede.json`, two independent runs)
    steered a sleep-widened multi-step bash turn after its first tool call
    was observed in-flight: the remainder of the turn is **not** dropped
    (all steps plus the final text ran; one execution, terminal
    `session.execution.succeeded`), no `session.execution.interrupted`
    fired with any reason, and the steered prompt was delivered _into_ the
    in-flight turn as context (`session.inbox.delivered` mid-turn, pending
    inbox empty after) with **no separate execution and no dedicated
    answer** — whether the model honors it is model behavior (this model
    ignored it, both runs). No shipped change (the provider never steers
    into a busy session); any future steer-dependent feature must treat
    steer as mid-turn context injection, not turn replacement. See the
    stage-7 addendum in `docs/v2-spike-findings.md`.
11. **`input`-excludes-`cache.read` disjointness on beta.** All beta-source
    runs returned `cache: {read: 0, write: 0}`, so the dev-CLI evidence for
    the usage summing assumption could not be re-confirmed; re-check when a
    cache-hitting model is available on the zen catalog.
    _Re-examined stage 7, still deferred:_ upstream-blocked — the free zen
    catalog still reports no cache activity, so there is no run that could
    confirm or refute the disjointness assumption.
