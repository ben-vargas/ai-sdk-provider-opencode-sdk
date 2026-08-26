import {
  eventFactory,
  finishPart,
  tokens,
  OTHER_SESSION_ID,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const other = eventFactory(OTHER_SESSION_ID);
const MSG = "msg_a1";
const BLOCK = `${MSG}:text:0`;

/**
 * One step, one text block, per-step usage on `step.ended`, terminal
 * `execution.succeeded`. Includes cross-session noise (a delta for another
 * session) that must reduce to nothing.
 */
export const simpleTextTurn: V2EventFixture = {
  name: "simple text turn",
  description: "single-step text-only turn with usage and succeeded terminal",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.textStarted(MSG, 0),
    f.textDelta(MSG, 0, "Hello"),
    other.textDelta("msg_foreign", 0, "not ours"),
    f.textDelta(MSG, 0, ", world."),
    f.textEnded(MSG, 0, "Hello, world."),
    f.stepEnded(MSG, "stop", tokens(10, 5), 0.25),
    f.executionSucceeded(),
  ],
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "Hello" },
    { type: "text-delta", id: BLOCK, delta: ", world." },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 10, output: 5, cost: 0.25 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
