# Stage 7 — Deferred hardening

## Goal

Work down `docs/briefs/deferred.md` items 1, 3, 4, and 10. Items 2/5/6/9/11 stay deferred (upstream-blocked or no demonstrated need — update their ledger entries with "re-examined stage 7, still deferred" and the reason); items 7/8 are stage 8.

## Context

- `docs/opencode-sdk-v2-analysis.md` §2.2 doGenerate row (wait watchdog), §2.1 structured-output row (repair-loop safety rules), errors entry (phase rule — post-dispatch failures reconcile, never retry).
- `docs/briefs/deferred.md` — the evidence notes per item, especially the corrected stage-6 wait measurements.
- The stage-6 harness (`npm run test:integration`) is available for live verification of items 1 and 10.

## Deliverables (commits prefixed `stage-7:`)

1. **`session.wait` watchdog (ledger #1).** In doGenerate (and doStream's completion path where it cheaply fits): race the event-driven completion against a `session.wait` watchdog. Wait resolving while events show no terminal → trigger message-store reconciliation (not completion-by-wait; events stay primary since wait's behavior under steer/queue/interrupt is unpinned). Any wait failure post-dispatch follows the phase rule (internal reconcile, never retryable). Unit tests with the fake port; one gated integration test confirming the watchdog is a no-op on a healthy turn.
2. **Delivery-uncertainty reconciliation (ledger #3).** On a transport failure where prompt delivery is uncertain: consult `session.inbox.list` (port method exists) to determine whether the item was enqueued; enqueued → continue observing the turn (it's running — don't error); absent → surface the non-retryable error as today. Bound the check (timeout + single attempt); unit tests both branches + inbox-check-itself-fails path.
3. **JSON validate/repair loop (ledger #4), opt-in.** New setting `jsonRepair?: {maxAttempts?: number}` (default off). When `responseFormat: json` and the final text fails `JSON.parse` (or schema validation via the AI SDK-supplied schema if present): repair via `generate.text` on the port (documented no-tools/no-history — safe) with the invalid output + schema + error; validate again; bounded attempts; never replay the original turn. Emit a warning recording attempts used. The unsupported-format warning stays regardless. Unit tests: success-first-try (no repair call), repair-success, attempts-exhausted, repair-disabled default.
4. **Steer multi-step re-test (ledger #10).** New gated integration experiment: multi-step tool turn, steer mid-turn, capture whether remaining steps are dropped at the step boundary and whether `execution.interrupted (superseded)` fires on the beta-source server. Record verdict in the findings doc's stage-6 verification section (append; label stage-7) and update the ledger. This is evidence-gathering — change no shipped behavior unless the finding contradicts one (then fix, loudly).
5. **Ledger update** for everything above + re-deferral notes for 2/5/6/9/11.

## Checks

`npm run ci` green; `npm run test:integration` green where the harness runs. Summary: per-item disposition, and the steer verdict with artifact citation.
