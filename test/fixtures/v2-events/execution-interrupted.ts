import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

// Interrupt-reason mapping is provisional (no upstream docs):
// user → stop, superseded → other, shutdown → error.

const fUser = eventFactory();
const MSG_U = "msg_iu";
const BLOCK_U = `${MSG_U}:text:0`;

export const executionInterruptedUser: V2EventFixture = {
  name: "execution interrupted (user)",
  description: "user interrupt closes open blocks and finishes with stop",
  sessionId: SESSION_ID,
  events: [
    fUser.executionStarted(),
    fUser.stepStarted(MSG_U),
    fUser.textStarted(MSG_U, 0),
    fUser.textDelta(MSG_U, 0, "Partial answ"),
    fUser.executionInterrupted("user"),
  ],
  expected: [
    { type: "text-start", id: BLOCK_U },
    { type: "text-delta", id: BLOCK_U, delta: "Partial answ" },
    { type: "text-end", id: BLOCK_U },
    finishPart({
      finishReason: { unified: "stop", raw: "interrupted:user" },
      usage: { input: 0, output: 0 },
      messageId: MSG_U,
      outcome: "interrupted",
      interruptReason: "user",
    }),
  ],
};

const fSuperseded = eventFactory();
const MSG_S = "msg_is";
const BLOCK_S = `${MSG_S}:text:0`;

/**
 * Steer supersedes the remainder of the turn at a step boundary
 * (spike-confirmed): the completed step's usage and native `"tool-calls"`
 * finish are preserved in metadata, but the finish reason is the interrupt
 * mapping — never the intermediate step's tool-calls.
 */
export const executionInterruptedSuperseded: V2EventFixture = {
  name: "execution interrupted (superseded)",
  description: "steered-over turn finishes other with step usage preserved",
  sessionId: SESSION_ID,
  events: [
    fSuperseded.executionStarted(),
    fSuperseded.stepStarted(MSG_S),
    fSuperseded.textStarted(MSG_S, 0),
    fSuperseded.textDelta(MSG_S, 0, "Working on step one."),
    fSuperseded.textEnded(MSG_S, 0, "Working on step one."),
    fSuperseded.stepEnded(MSG_S, "tool-calls", tokens(25, 9), 0.25),
    fSuperseded.executionInterrupted("superseded"),
  ],
  expected: [
    { type: "text-start", id: BLOCK_S },
    { type: "text-delta", id: BLOCK_S, delta: "Working on step one." },
    { type: "text-end", id: BLOCK_S },
    finishPart({
      finishReason: { unified: "other", raw: "interrupted:superseded" },
      usage: { input: 25, output: 9, cost: 0.25 },
      messageId: MSG_S,
      outcome: "interrupted",
      interruptReason: "superseded",
      finish: "tool-calls",
    }),
  ],
};

const fShutdown = eventFactory();
const MSG_D = "msg_id";
const BLOCK_D = `${MSG_D}:text:0`;

export const executionInterruptedShutdown: V2EventFixture = {
  name: "execution interrupted (shutdown)",
  description: "server shutdown mid-turn finishes with error",
  sessionId: SESSION_ID,
  events: [
    fShutdown.executionStarted(),
    fShutdown.stepStarted(MSG_D),
    fShutdown.textStarted(MSG_D, 0),
    fShutdown.textDelta(MSG_D, 0, "Halfway"),
    fShutdown.executionInterrupted("shutdown"),
  ],
  expected: [
    { type: "text-start", id: BLOCK_D },
    { type: "text-delta", id: BLOCK_D, delta: "Halfway" },
    { type: "text-end", id: BLOCK_D },
    finishPart({
      finishReason: { unified: "error", raw: "interrupted:shutdown" },
      usage: { input: 0, output: 0 },
      messageId: MSG_D,
      outcome: "interrupted",
      interruptReason: "shutdown",
    }),
  ],
};
