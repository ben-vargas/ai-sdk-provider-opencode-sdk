# A reasonless rejection or dismissed form is reported as `interrupted: "shutdown"`

**Status:** Known upstream issue — tracked locally, not filed.
**Last verified:** 2026-10-06, live against `@opencode/cli@2.0.24` and its source.
**How to re-check** (a server with `permission: { shell: "ask" }`, see `examples/env.ts`):

```bash
# Reject the approval (edit `approved: true` → `false` in a copy first) and
# print phase 2's finishReason / providerMetadata.opencode.interruptReason.
npx tsx examples/tool-approval.ts
# Or dismiss a question form: return { type: "cancel" } from onForm.
npx tsx examples/form-handling.ts
```

**Evidence:** `packages/core/src/session/runner/step.ts` (`tools.declines.length > 0` → `Effect.interrupt`) and `packages/core/src/session/execution.ts:52` (`reason ?? "shutdown"`) at `v2.0.24`.

## Behavior

When the user declines a tool permission **without feedback**
(`permission.reply` with `decision: "reject"` and no `message` — the
provider sends `approved: false` without a `reason`) or dismisses a form
raised by the built-in `question` tool (`form.cancel`), 2.0.24 fails the
tool (`type: "aborted"`), fails the
step (`"Step interrupted"`), and ends the execution with a bare fiber
interrupt. The execution layer labels any interrupt without an explicit
reason as `"shutdown"`, so the turn ends with:

```text
session.execution.interrupted { reason: "shutdown" }
```

That is the same label a real server shutdown produces, so a client cannot
tell "the user said no" from "the server went away" by the reason alone.
The turn does not continue with the denial as model-visible feedback — it
ends. The session itself stays usable: a follow-up prompt on the same
session completes normally (verified live).

A rejection **with** feedback is different and works as expected: a
non-empty `message` makes `Permission` raise a `CorrectedError` instead of
a `DeclinedError` (`packages/core/src/permission.ts` at `v2.0.24`), the
tool fails with that message as model-visible output, and the turn
continues (verified live: `{ approved: false, reason: "…" }` → finish
`stop`). Likewise a form dismissal that carries a message is ordinary tool
feedback; `form.cancel` from this provider carries none.

## Provider impact

The provider maps `interrupted: "shutdown"` to finish reason `error`
(raw `interrupted:shutdown`), with `providerMetadata.opencode.outcome:
"interrupted"` and `interruptReason: "shutdown"`. It does not remap the
reason, and it cannot tell the two causes apart: a real shutdown can race
a rejection, `repliedApprovalIds` lists approvals and rejections alike, and
`formIds` lists every form surfaced in the call, answered or cancelled.
Treat those IDs as correlation context only. Callers that need to know
should keep their own record of the decisions they returned — and accept
that even then a coincident real shutdown is indistinguishable. To let the
model continue after a "no", reject with a `reason`.
