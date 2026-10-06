import type { SessionStructuredError } from "@opencode/client";
import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG1 = "msg_r1";
const MSG2 = "msg_r2";
const RETRY_AT = 1756200999000;
const STEP_ERROR: SessionStructuredError = {
  type: "provider_overloaded",
  message: "upstream overloaded",
  status: 529,
};

/**
 * A step fails, the server schedules a retry, and the retried step
 * succeeds: the finish carries the `retry` record (attempt, at, error) in
 * provider metadata, the failed attempt's usage still accumulates, and the
 * failed step's error does NOT leak onto the successful finish — the retry
 * step's `step.started` supersedes it.
 */
export const retryScheduledTurn: V2EventFixture = {
  name: "retry scheduled after failed step",
  description:
    "step.failed → retry.scheduled → successful retry; retry metadata, no stale stepError",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG1),
    f.stepFailed(MSG1, STEP_ERROR, { tokens: tokens(5, 0), cost: 0.25 }),
    f.retryScheduled(MSG1, 1, RETRY_AT, STEP_ERROR),
    f.stepStarted(MSG2),
    f.textStarted(MSG2, 0),
    f.textDelta(MSG2, 0, "Recovered."),
    f.textEnded(MSG2, 0, "Recovered."),
    f.stepEnded(MSG2, "stop", tokens(10, 3), 0.5),
    f.executionSucceeded(),
  ],
  expected: [
    { type: "text-start", id: `${MSG2}:text:0` },
    { type: "text-delta", id: `${MSG2}:text:0`, delta: "Recovered." },
    { type: "text-end", id: `${MSG2}:text:0` },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 15, output: 3, cost: 0.75 },
      messageId: MSG2,
      outcome: "succeeded",
      finish: "stop",
      retry: { attempt: 1, at: RETRY_AT, error: STEP_ERROR },
    }),
  ],
};
