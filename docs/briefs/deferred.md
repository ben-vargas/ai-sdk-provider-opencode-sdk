# Deferred-item ledger

Items intentionally deferred by earlier stages. Stage 6 (docs, examples,
hardening) picks these up explicitly; anything it defers further must stay on
this list with a reason.

## Deferred from stage 4 (language model)

1. **`session.wait` watchdog.** The non-streaming path completes via
   execution events with idle/silence backstops; `session.wait` as an
   additional watchdog (design doc §2.2 doGenerate row) is not wired in. Any
   post-dispatch `wait` failure must be reconciled internally (never surfaced
   retryable) per the stage-3 phase rule.
2. **`session.log` catch-up.** SSE-drop recovery via the durable log
   (`session.log({after, follow})`, sequence numbers) is not implemented; the
   reducer's input layer already normalizes `SessionLogItem` vs live
   `V2Event` (stage 2), so this is wiring work in the model's recovery path.
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
   rewrite around the v5 surface is stage-6 work.
