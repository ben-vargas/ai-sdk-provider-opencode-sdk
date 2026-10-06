import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_a1";
const BLOCK = `${MSG}:text:0`;

/**
 * Content and tool events arriving after the terminal execution event must
 * reduce to nothing: finish is the stream's last semantic part (a
 * reducer-owned invariant), so post-finish stragglers — late deltas, a new
 * block start, a tool input — produce no new parts and no new blocks.
 */
export const contentAfterFinish: V2EventFixture = {
  name: "content after finish",
  description: "post-finish content/tool events reduce to nothing",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.textStarted(MSG, 0),
    f.textDelta(MSG, 0, "Done."),
    f.textEnded(MSG, 0, "Done."),
    f.stepEnded(MSG, "stop", tokens(6, 2), 0.1),
    f.executionSucceeded(),
    // Stragglers after the terminal event: none may produce parts.
    f.textDelta(MSG, 0, " trailing"),
    f.textStarted(MSG, 1),
    f.textDelta(MSG, 1, "new block"),
    f.toolInputStarted(MSG, "call_late", "write"),
    f.toolInputDelta(MSG, "call_late", '{"path'),
    f.stepStarted("msg_a2"),
  ],
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "Done." },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 6, output: 2, cost: 0.1 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};

/**
 * Same stragglers with `includeRawChunks`: post-finish events still surface
 * as raw parts (advanced consumers see everything), just never as semantic
 * parts.
 */
const raw = eventFactory();
const RAW_MSG = "msg_a1";
const RAW_BLOCK = `${RAW_MSG}:text:0`;
const rawEvents = [
  raw.stepStarted(RAW_MSG),
  raw.textStarted(RAW_MSG, 0),
  raw.textDelta(RAW_MSG, 0, "Hi"),
  raw.textEnded(RAW_MSG, 0, "Hi"),
  raw.stepEnded(RAW_MSG, "stop", tokens(3, 1), 0),
  raw.executionSucceeded(),
  raw.textDelta(RAW_MSG, 0, "late"),
];

export const contentAfterFinishRaw: V2EventFixture = {
  name: "content after finish (raw chunks)",
  description: "post-finish events are raw-only under includeRawChunks",
  sessionId: SESSION_ID,
  includeRawChunks: true,
  events: rawEvents,
  expected: [
    { type: "raw", rawValue: rawEvents[0] },
    { type: "raw", rawValue: rawEvents[1] },
    { type: "text-start", id: RAW_BLOCK },
    { type: "raw", rawValue: rawEvents[2] },
    { type: "text-delta", id: RAW_BLOCK, delta: "Hi" },
    { type: "raw", rawValue: rawEvents[3] },
    { type: "text-end", id: RAW_BLOCK },
    { type: "raw", rawValue: rawEvents[4] },
    { type: "raw", rawValue: rawEvents[5] },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 3, output: 1, cost: 0 },
      messageId: RAW_MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
    { type: "raw", rawValue: rawEvents[6] },
  ],
};
