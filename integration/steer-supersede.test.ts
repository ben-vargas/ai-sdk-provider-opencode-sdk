/**
 * Stage-7 evidence experiment (deferred-ledger #10): steer a multi-step tool
 * turn mid-flight and capture (a) whether the remainder of the turn is
 * dropped at the step boundary and (b) whether
 * `session.execution.interrupted` fires with reason "superseded".
 *
 * Stage-0's dev-CLI observation was that steer silently drops the remaining
 * steps with no superseded event; stage-6 re-verified only the single-step
 * case on the beta source (turn completed fully, steer ran after). The
 * stage-7 capture refuted stage-0 for the beta source: the multi-step turn
 * runs to completion, the steered prompt is delivered *into* the in-flight
 * turn as context (no separate execution answers it, no superseded event).
 * This test asserts only that delivery-level structure — steered item
 * delivered, no inbox stall, turn reaches a terminal — and prints a
 * structured verdict block (including whether the model actually honored
 * the steered instruction) for the findings doc.
 *
 * Exercised at the raw-client level (like busy-queue.test.ts): steering a
 * busy session is outside the provider's exclusive-session contract, and the
 * question under test is a server-side one.
 */
import { describe, expect, it } from "vitest";
import type { V2Event } from "@opencode-ai/client";
import {
  integrationContext,
  parseModelRef,
  pollUntil,
  suiteTitle,
} from "./harness/context.js";

const ctx = integrationContext();

const MULTI_STEP_PROMPT =
  "First use the bash tool to run exactly `sleep 6 && echo STEP-ONE-DONE`. " +
  "After it completes, use the bash tool again in a separate call to run " +
  "exactly `echo STEP-TWO-RAN`. Finally reply with exactly: ALL-STEPS-DONE. " +
  "Do not skip any step.";

const STEER_PROMPT = "Reply with exactly: STEERED-REPLY";

describe.skipIf(!ctx.canGenerate)(suiteTitle("steer supersession", ctx), () => {
  it("captures multi-step steer behavior (evidence, tolerant assertions)", async (t) => {
    const raw = ctx.makeRawClient();
    const model = parseModelRef(ctx.modelId);
    const session = await raw.session.create({
      title: "integration-steer-supersede",
      location: { directory: ctx.workdir },
      model: { id: model.modelID, providerID: model.providerID },
    });

    // Collect this session's events; auto-approve bash permissions ("always"
    // so every subsequent step runs unattended).
    const subscription = new AbortController();
    const events: V2Event[] = [];
    const replied = new Set<string>();
    let lastEventAt = Date.now();
    const pump = (async () => {
      try {
        for await (const event of raw.event.subscribe({
          signal: subscription.signal,
        })) {
          const data = (event as { data?: { sessionID?: string } }).data;
          if (data?.sessionID !== session.id) {
            continue;
          }
          events.push(event);
          lastEventAt = Date.now();
          if (event.type === "permission.asked") {
            const requestID = event.data.id;
            if (!replied.has(requestID)) {
              replied.add(requestID);
              await raw.permission
                .reply({ sessionID: session.id, requestID, reply: "always" })
                .catch(() => undefined);
            }
          }
        }
      } catch {
        /* teardown */
      }
    })();

    try {
      const first = await raw.session.prompt({
        sessionID: session.id,
        text: MULTI_STEP_PROMPT,
      });

      // Wait for the first bash call to actually be running; a model that
      // never calls the tool leaves nothing to supersede — skip.
      const sawTool = await pollUntil(
        async () => {
          const called = events.some(
            (event) =>
              event.type === "session.tool.called" ||
              event.type === "session.tool.input.started",
          );
          if (called) {
            return true;
          }
          const settled = events.some(
            (event) =>
              event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed",
          );
          return settled ? false : undefined;
        },
        { timeoutMs: 120_000, label: "first tool call (or turn settled)" },
      );
      if (!sawTool) {
        t.skip();
        return;
      }

      // Steer while the (sleep-widened) first step is in flight.
      const steered = await raw.session.prompt({
        sessionID: session.id,
        text: STEER_PROMPT,
        delivery: "steer",
      });
      expect(steered.delivery).toBe("steer");

      // Settle: wait until the steered prompt is answered, the session goes
      // quiet (no events for a long stretch — the stage-0 stall signature),
      // or the hard deadline passes. Evidence is captured either way; the
      // answered invariant is asserted at the end where the verdict block
      // has already been printed.
      const deadline = Date.now() + 240_000;
      let steeredAnswered = false;
      let settleOutcome = "deadline";
      let messages: Awaited<ReturnType<typeof raw.message.list>>["data"] = [];
      for (;;) {
        const list = await raw.message.list({
          sessionID: session.id,
          order: "asc",
        });
        messages = list.data;
        steeredAnswered = messages.some(
          (message) =>
            message.type === "assistant" &&
            message.finish !== undefined &&
            message.content.some(
              (part) =>
                part.type === "text" && part.text.includes("STEERED-REPLY"),
            ),
        );
        if (steeredAnswered) {
          settleOutcome = "answered";
          break;
        }
        const sinceLastEvent = Date.now() - lastEventAt;
        const sawTerminal = events.some(
          (event) =>
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed",
        );
        // Post-terminal, a short quiet window suffices (nothing more is
        // coming); pre-terminal, wait long enough to distinguish a stall
        // from slow model latency.
        if (
          events.length > 0 &&
          sinceLastEvent > (sawTerminal ? 15_000 : 90_000)
        ) {
          settleOutcome = `quiet (${Math.round(sinceLastEvent / 1000)}s since last event)`;
          break;
        }
        if (Date.now() > deadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Is the steered item still sitting undelivered in the inbox? (The
      // beta inbox table is pending-only, so a hit here means "admitted but
      // never delivered" — the stage-0 pre-step-steer stall signature.)
      const pendingInbox = await raw.session.inbox
        .list({ sessionID: session.id })
        .then((items) =>
          items.map((item) => ({
            id: item.id,
            type: item.type,
            text: item.type === "user" ? item.payload.text : undefined,
          })),
        )
        .catch((error) => `inbox.list failed: ${String(error)}`);

      // ---- Evidence capture --------------------------------------------
      const interrupted = events
        .filter(
          (
            event,
          ): event is Extract<
            V2Event,
            { type: "session.execution.interrupted" }
          > => event.type === "session.execution.interrupted",
        )
        .map((event) => event.data.reason);
      const storedText = messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.content)
        .map((part) => JSON.stringify(part))
        .join("\n");
      const verdict = {
        experiment: "stage-7 steer multi-step supersession",
        sessionID: session.id,
        firstInboxID: first.id,
        steeredInboxID: steered.id,
        settleOutcome,
        steeredAnswered,
        stepOneRan: storedText.includes("STEP-ONE-DONE"),
        stepTwoRan: storedText.includes("STEP-TWO-RAN"),
        finalStepTextDelivered: storedText.includes("ALL-STEPS-DONE"),
        executionInterruptedReasons: interrupted,
        supersededEventFired: interrupted.includes("superseded"),
        executionTerminalEvents: events
          .filter((event) => event.type.startsWith("session.execution."))
          .map((event) => event.type),
        eventTypeCounts: events.reduce<Record<string, number>>(
          (counts, event) => {
            counts[event.type] = (counts[event.type] ?? 0) + 1;
            return counts;
          },
          {},
        ),
        pendingInboxAfterSettle: pendingInbox,
        userMessages: messages
          .filter((message) => message.type === "user")
          .map((message) => ({ id: message.id, text: message.text })),
        assistantFinishes: messages
          .filter((message) => message.type === "assistant")
          .map((message) => ({
            id: message.id,
            finish: message.finish ?? null,
            error: message.error?.type ?? null,
          })),
      };
      console.log(
        `STEER-SUPERSEDE VERDICT:\n${JSON.stringify(verdict, null, 2)}`,
      );

      // Invariants the server actually guarantees on this build (the
      // stage-7 capture refuted the drafted "steered prompt is eventually
      // answered" assumption — steer folds the prompt into the in-flight
      // turn as context; no separate execution answers it, and whether the
      // model honors it is model behavior, recorded in `steeredAnswered`):
      // step one ran (it was in flight when we steered) …
      expect(verdict.stepOneRan).toBe(true);
      // … the steered item was delivered, not stalled in the inbox
      // (stage-0's pre-step-steer stall would leave it pending forever) …
      const deliveredIds = events
        .filter(
          (
            event,
          ): event is Extract<V2Event, { type: "session.inbox.delivered" }> =>
            event.type === "session.inbox.delivered",
        )
        .map((event) => event.data.inboxID);
      expect(deliveredIds).toContain(steered.id);
      expect(pendingInbox).toEqual([]);
      // … and the turn reached a terminal execution event.
      expect(verdict.executionTerminalEvents).toContain(
        "session.execution.succeeded",
      );
    } finally {
      subscription.abort();
      await pump;
    }
  }, 300_000);
});
