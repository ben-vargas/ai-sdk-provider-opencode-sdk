import type { SessionStructuredError, ToolContent1 } from "@opencode/client";
import {
  asJson,
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_tf1";
const TOOL = "tool_fail";
const INPUT = '{"cmd":"deploy"}';
const ERROR: SessionStructuredError = {
  type: "tool.execution",
  message: "deploy failed: exit 1",
};
// A failed tool can still carry content — including a diagnostics file as a
// data: URI, which becomes a separate file part.
const CONTENT: [ToolContent1, ...ToolContent1[]] = [
  { type: "text", text: "stderr: boom" },
  {
    type: "file",
    uri: "data:text/plain;base64,Ym9vbQ==",
    mime: "text/plain",
    name: "stderr.log",
  },
];

/**
 * Tool failure: `tool.failed` yields an error tool-result (raw structured
 * error preserved) plus file parts for file content entries; the turn still
 * completes normally.
 */
export const toolFailure: V2EventFixture = {
  name: "tool failure",
  description: "tool.failed maps to isError tool-result with content files",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.toolInputStarted(MSG, TOOL, "shell"),
    f.toolInputEnded(MSG, TOOL, INPUT),
    f.toolCalled(MSG, TOOL, { cmd: "deploy" }, true),
    f.toolFailed(MSG, TOOL, ERROR, { content: CONTENT }),
    f.stepEnded(MSG, "stop", tokens(30, 10), 0.25),
    f.executionSucceeded(),
  ],
  expected: [
    {
      type: "tool-input-start",
      id: TOOL,
      toolName: "shell",
      providerExecuted: true,
      dynamic: true,
    },
    // No deltas streamed: `input.ended` reconciles the full input text.
    { type: "tool-input-delta", id: TOOL, delta: INPUT },
    { type: "tool-input-end", id: TOOL },
    {
      type: "tool-call",
      toolCallId: TOOL,
      toolName: "shell",
      input: INPUT,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-result",
      toolCallId: TOOL,
      toolName: "shell",
      result: asJson({ error: ERROR, content: CONTENT }),
      isError: true,
      dynamic: true,
      providerMetadata: {
        opencode: { content: asJson(CONTENT), error: asJson(ERROR) },
      },
    },
    {
      type: "file",
      mediaType: "text/plain",
      data: { type: "data", data: "Ym9vbQ==" },
    },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 30, output: 10, cost: 0.25 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};
