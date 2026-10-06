import type { ToolContent1 } from "@opencode/client";
import {
  asJson,
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG1 = "msg_s1";
const MSG2 = "msg_s2";
const TOOL = "tool_1";
const TEXT = `${MSG2}:text:0`;
const INPUT = '{"path":"a.txt"}';
const CONTENT: [ToolContent1, ...ToolContent1[]] = [
  { type: "text", text: "contents of a.txt" },
];

/**
 * Two-step turn (one assistant message per step): a provider-executed tool
 * call, then a text step. Per-step usage increments accumulate; the
 * intermediate step's `"tool-calls"` finish never finishes the stream —
 * only `execution.succeeded` does.
 */
export const multiStepToolTurn: V2EventFixture = {
  name: "multi-step tool turn",
  description:
    "tool step + text step; per-step usage sums; no finish on intermediate tool-calls",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG1),
    f.toolInputStarted(MSG1, TOOL, "read_file"),
    f.toolInputDelta(MSG1, TOOL, '{"path":'),
    f.toolInputDelta(MSG1, TOOL, '"a.txt"}'),
    f.toolInputEnded(MSG1, TOOL, INPUT),
    f.toolCalled(MSG1, TOOL, { path: "a.txt" }, true),
    f.toolSuccess(MSG1, TOOL, CONTENT, true),
    f.stepEnded(MSG1, "tool-calls", tokens(100, 20, 0, 50), 0.25),
    f.stepStarted(MSG2),
    f.textStarted(MSG2, 0),
    f.textDelta(MSG2, 0, "The file says hi."),
    f.textEnded(MSG2, 0, "The file says hi."),
    f.stepEnded(MSG2, "stop", tokens(150, 12, 0, 60), 0.5),
    f.executionSucceeded(),
  ],
  expected: [
    {
      type: "tool-input-start",
      id: TOOL,
      toolName: "read_file",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL, delta: '{"path":' },
    { type: "tool-input-delta", id: TOOL, delta: '"a.txt"}' },
    { type: "tool-input-end", id: TOOL },
    {
      type: "tool-call",
      toolCallId: TOOL,
      toolName: "read_file",
      input: INPUT,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-result",
      toolCallId: TOOL,
      toolName: "read_file",
      result: asJson(CONTENT),
      isError: false,
      dynamic: true,
      providerMetadata: { opencode: { content: asJson(CONTENT) } },
    },
    { type: "text-start", id: TEXT },
    { type: "text-delta", id: TEXT, delta: "The file says hi." },
    { type: "text-end", id: TEXT },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 250, output: 32, cacheRead: 110, cost: 0.75 },
      messageId: MSG2,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
