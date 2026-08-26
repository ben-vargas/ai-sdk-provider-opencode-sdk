import type { SessionLogItem } from "@opencode-ai/client";
import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_l1";
const BLOCK = `${MSG}:text:0`;

// A durable-log replay: SessionLogItem is the durable union plus the
// `log.synced` sentinel. Deltas are live-only, so text content arrives via
// the `ended` event's full text.
const events: SessionLogItem[] = [
  f.executionStarted(),
  f.stepStarted(MSG),
  f.textStarted(MSG, 0),
  f.textEnded(MSG, 0, "Replayed text"),
  f.stepEnded(MSG, "stop", tokens(12, 4), 0.25),
  f.executionSucceeded(),
  f.logSynced(),
];

/**
 * `session.log` replay: the reducer consumes `SessionLogItem`s (no deltas),
 * reconstructs full block content from `ended`, and treats the `log.synced`
 * sentinel as a state flag with no stream parts.
 */
export const logSyncedReplay: V2EventFixture = {
  name: "log.synced sentinel",
  description: "durable-log replay ends with the log.synced sentinel",
  sessionId: SESSION_ID,
  events,
  expectLogSynced: true,
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "Replayed text" },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 12, output: 4, cost: 0.25 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
