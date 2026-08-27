# Deferred-item ledger

Items intentionally deferred by earlier stages. Stage 7 (docs, examples,
hardening) picks these up explicitly, informed by the stage-6 beta-source
findings; anything it defers further must stay on this list with a reason.

## Deferred from stage 4 (language model)

1. **`session.wait` watchdog.** The non-streaming path completes via
   execution events with idle/silence backstops; `session.wait` as an
   additional watchdog (design doc §2.2 doGenerate row) is not wired in. Any
   post-dispatch `wait` failure must be reconciled internally (never surfaced
   retryable) per the stage-3 phase rule.
   _Stage-6 evidence:_ `wait` is now implemented on the beta-source server
   but **resolved before turn completion** (~2.8 s into a 7–14 s turn) — it
   must not be treated as a completion signal without first pinning down its
   semantics upstream (`spike/artifacts/12-beta-src-verification.json`).
2. **`session.log` catch-up.** SSE-drop recovery via the durable log
   (`session.log({after, follow})`, sequence numbers) is not implemented; the
   reducer's input layer already normalizes `SessionLogItem` vs live
   `V2Event` (stage 2), so this is wiring work in the model's recovery path.
   _Stage-6 evidence:_ on the beta-source server the route yields **only**
   the `log.synced` sentinel even with `after: 0` on a session holding 16
   durable events — historical replay is unimplemented upstream, so recovery
   must keep using the message store until that lands.
3. **`inbox.list` delivery-uncertainty reconciliation.** After a transport
   failure with uncertain prompt delivery, the model does not yet consult the
   inbox to determine whether the prompt was enqueued before erroring
   non-retryably.
4. **JSON validate/repair loop.** `responseFormat: json` degrades to the
   prompt-engineered instruction + unsupported warning only. The opt-in
   client-side parse/validate + `generate.text` repair pass (safe: documented
   as no-tools/no-history) is not built; replaying the original turn stays
   gated on side-effect-freeness (design doc §2.1).

## Deferred from stage 5 (provider + backends)

5. **Embedded backend / `./embedded` entrypoint.** Per the brief, only the
   seam ships: `createClientManagerFromPort(port)` wraps an injected port in
   a manager the factory accepts via the `clientManager` setting. The actual
   in-process host construction (`OpenCode.create()`, optional peer on
   `@opencode-ai/sdk`, plugin hooks for true system prompts / tool filtering /
   permission policy) is future work.
6. **Version-predicate gating outside the service backend.** The health
   preflight gates on `service.version` only for the service backend (where
   the option lives; discovery/ensure gate on it too — the health re-check
   catches stale registrations). `baseUrl` and caller-supplied clients log
   the version but have no gating knob; add one if a real need appears.
7. **Model shortcut refresh.** `OpencodeModels` retains the v4 catalog ids
   (Claude 4.5 / GPT-4o / Gemini families) verbatim; no newer ids were added
   because live-catalog ids for newer model families could not be verified
   against a running v2 server in this stage.
8. **Examples + README rewrite.** `examples/` and README still describe the
   v1/v4 protocol (questions, `createOpencodeServer`, hostname/port); full
   rewrite around the v5 surface is stage-7 work.

## Deferred from stage 6 (integration harness)

9. **`file:` URI passthrough in `resolveFileToUri`.** The beta-source server
   now reads and normalizes readable `file:` URIs server-side (and rejects
   unreadable ones at prompt time), so a `file:` return from the resolver
   hook would work against beta servers. The hook's type and the provider's
   preflight still allow `data:` only — loosening it is a deliberate surface
   change (server-filesystem coupling, older servers store the raw URI and
   fail the turn late) deferred until the beta contract is the only one we
   target (`spike/artifacts/12b-beta-src-file-uris.json`).
10. **Steer multi-step supersession re-test.** Stage-0's dev-CLI finding
    (steer drops the remainder of a multi-step turn at the step boundary,
    with no superseded event) was only re-verified for the single-step case
    on the beta source (turn completes fully, steer runs after). The
    multi-step case needs a dedicated experiment before any steer-dependent
    feature ships.
11. **`input`-excludes-`cache.read` disjointness on beta.** All beta-source
    runs returned `cache: {read: 0, write: 0}`, so the dev-CLI evidence for
    the usage summing assumption could not be re-confirmed; re-check when a
    cache-hitting model is available on the zen catalog.
