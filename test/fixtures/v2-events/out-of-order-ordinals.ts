import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_o1";
const BLOCK0 = `${MSG}:text:0`;
const BLOCK1 = `${MSG}:text:1`;

/**
 * Ordinal 1 starts streaming before ordinal 0, and their deltas interleave.
 * Blocks are keyed by `${assistantMessageID}:text:${ordinal}` so each
 * event routes to its own stable AI SDK id regardless of arrival order —
 * no block is closed or restarted by another block's events.
 */
export const outOfOrderOrdinals: V2EventFixture = {
  name: "out-of-order ordinals across two text blocks",
  description: "interleaved blocks keep stable ids; no forced closes",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.textStarted(MSG, 1),
    f.textDelta(MSG, 1, "second block "),
    f.textStarted(MSG, 0),
    f.textDelta(MSG, 0, "first block"),
    f.textDelta(MSG, 1, "continues"),
    f.textEnded(MSG, 1, "second block continues"),
    f.textEnded(MSG, 0, "first block"),
    f.stepEnded(MSG, "stop", tokens(8, 6), 0),
    f.executionSucceeded(),
  ],
  expected: [
    { type: "text-start", id: BLOCK1 },
    { type: "text-delta", id: BLOCK1, delta: "second block " },
    { type: "text-start", id: BLOCK0 },
    { type: "text-delta", id: BLOCK0, delta: "first block" },
    { type: "text-delta", id: BLOCK1, delta: "continues" },
    { type: "text-end", id: BLOCK1 },
    { type: "text-end", id: BLOCK0 },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 8, output: 6 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
