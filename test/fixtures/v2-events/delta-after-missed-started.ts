import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_m1";
const BLOCK = `${MSG}:text:0`;

/**
 * A delta with no preceding `started` (mid-stream attach). Decision:
 * TOLERATE — the reducer synthesizes the block start, because deltas are
 * transient (not in the durable log) and a strict resync would drop content
 * that cannot be replayed. `ended` carries the full text, so buffered
 * content that is a prefix of it is completed with a final tail delta.
 */
export const deltaAfterMissedStarted: V2EventFixture = {
  name: "delta after missed started",
  description:
    "tolerated: start is synthesized, ended reconciles the missing tail",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    // No session.text.started for this block.
    f.textDelta(MSG, 0, "Hello"),
    f.textEnded(MSG, 0, "Hello world"),
    f.stepEnded(MSG, "stop", tokens(5, 3), 0),
    f.executionSucceeded(),
  ],
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "Hello" },
    { type: "text-delta", id: BLOCK, delta: " world" },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 5, output: 3 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
