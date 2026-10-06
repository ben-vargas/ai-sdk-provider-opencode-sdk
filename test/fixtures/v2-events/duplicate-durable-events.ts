import {
  duplicate,
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_d1";
const BLOCK = `${MSG}:text:0`;

const STEP_STARTED = f.stepStarted(MSG);
const TEXT_STARTED = f.textStarted(MSG, 0);
const TEXT_ENDED = f.textEnded(MSG, 0, "Hi");
const STEP_ENDED = f.stepEnded(MSG, "stop", tokens(10, 3), 0.25);
const SUCCEEDED = f.executionSucceeded();

/**
 * Redelivered durable events (same `durable.aggregateID`/`seq`) must reduce
 * to nothing: no repeated block starts/ends, no double-counted usage, one
 * finish part.
 */
export const duplicateDurableEvents: V2EventFixture = {
  name: "duplicate durable events",
  description: "durable redelivery is idempotent (blocks, usage, finish)",
  sessionId: SESSION_ID,
  events: [
    STEP_STARTED,
    duplicate(STEP_STARTED),
    TEXT_STARTED,
    duplicate(TEXT_STARTED),
    f.textDelta(MSG, 0, "Hi"),
    TEXT_ENDED,
    duplicate(TEXT_ENDED),
    STEP_ENDED,
    duplicate(STEP_ENDED),
    SUCCEEDED,
    duplicate(SUCCEEDED),
  ],
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "Hi" },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 10, output: 3, cost: 0.25 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
