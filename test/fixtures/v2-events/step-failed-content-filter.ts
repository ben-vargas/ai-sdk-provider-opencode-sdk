import type { SessionStructuredError } from "@opencode/client";
import {
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_cf1";
const BLOCK = `${MSG}:text:0`;
const ERROR: SessionStructuredError = {
  type: "content_filter",
  message: "response blocked by content filter",
};

/**
 * `step.failed` is not error-only: it carries `finish: "content-filter"`,
 * cost, and tokens, which must be consumed. On `execution.failed`, the
 * failing step's own finish wins over a generic error, and the open text
 * block is closed before the finish part.
 */
export const stepFailedContentFilter: V2EventFixture = {
  name: "step failed with content filter",
  description:
    "step.failed finish/usage consumed; execution.failed maps to content-filter",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.textStarted(MSG, 0),
    f.textDelta(MSG, 0, "I cannot"),
    f.stepFailed(MSG, ERROR, {
      finish: "content-filter",
      rawFinish: "content_filter",
      tokens: tokens(40, 5),
      cost: 0.5,
    }),
    f.executionFailed(ERROR),
  ],
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "I cannot" },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "content-filter", raw: "content_filter" },
      usage: { input: 40, output: 5, cost: 0.5 },
      messageId: MSG,
      outcome: "failed",
      finish: "content-filter",
      rawFinish: "content_filter",
      error: ERROR,
    }),
  ],
};
