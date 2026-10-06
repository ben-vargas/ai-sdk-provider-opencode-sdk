import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_r1";
const REASONING = `${MSG}:reasoning:0`;
const TEXT = `${MSG}:text:1`;

/**
 * Reasoning (ordinal 0) and text (ordinal 1) interleaved: the text block
 * opens while the reasoning block is still streaming. Kind is part of the
 * block identity because both kinds share the ordinal keyspace.
 */
export const reasoningTextInterleaved: V2EventFixture = {
  name: "reasoning and text interleaved",
  description: "concurrent reasoning/text blocks with shared ordinal keyspace",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.reasoningStarted(MSG, 0),
    f.reasoningDelta(MSG, 0, "Thinking about it..."),
    f.textStarted(MSG, 1),
    f.textDelta(MSG, 1, "The answer"),
    f.reasoningEnded(MSG, 0, "Thinking about it..."),
    f.textDelta(MSG, 1, " is 42."),
    f.textEnded(MSG, 1, "The answer is 42."),
    f.stepEnded(MSG, "stop", tokens(20, 8, 12), 0.5),
    f.executionSucceeded(),
  ],
  expected: [
    { type: "reasoning-start", id: REASONING },
    { type: "reasoning-delta", id: REASONING, delta: "Thinking about it..." },
    { type: "text-start", id: TEXT },
    { type: "text-delta", id: TEXT, delta: "The answer" },
    { type: "reasoning-end", id: REASONING },
    { type: "text-delta", id: TEXT, delta: " is 42." },
    { type: "text-end", id: TEXT },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 20, output: 8, reasoning: 12, cost: 0.5 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
