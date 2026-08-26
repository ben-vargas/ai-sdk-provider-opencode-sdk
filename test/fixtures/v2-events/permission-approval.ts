import type { ToolContent1 } from "@opencode-ai/client";
import {
  asJson,
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

// --- Case 1: permission arrives mid-input (issue #22 early registration) ---

const f1 = eventFactory();
const MSG_A = "msg_p1";
const TOOL_A = "tool_perm1";
const INPUT_A = '{"path":"b.txt"}';

/**
 * `permission.asked` correlated via `source.id` arrives after input has
 * streamed but before `input.ended`/`called`: the reducer registers the
 * tool call early from the buffered input so the approval lands after
 * tool-input-available (issue #22), then the blocked turn is returned to
 * the caller via finalize.
 */
export const permissionBeforeInputAvailable: V2EventFixture = {
  name: "permission before tool-input-available",
  description:
    "issue #22: approval triggers early tool-call registration from buffered input",
  sessionId: SESSION_ID,
  events: [
    f1.executionStarted(),
    f1.stepStarted(MSG_A),
    f1.toolInputStarted(MSG_A, TOOL_A, "write_file"),
    f1.toolInputDelta(MSG_A, TOOL_A, INPUT_A),
    f1.permissionAsked("perm_1", {
      action: "file.write",
      resources: ["b.txt"],
      source: { type: "tool", messageID: MSG_A, id: TOOL_A },
    }),
  ],
  finalize: true,
  expected: [
    {
      type: "tool-input-start",
      id: TOOL_A,
      toolName: "write_file",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL_A, delta: INPUT_A },
    { type: "tool-input-end", id: TOOL_A },
    {
      type: "tool-call",
      toolCallId: TOOL_A,
      toolName: "write_file",
      input: INPUT_A,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-approval-request",
      approvalId: "perm_1",
      toolCallId: TOOL_A,
      providerMetadata: {
        opencode: {
          sessionId: SESSION_ID,
          action: "file.write",
          resources: ["b.txt"],
        },
      },
    },
    // The turn is blocked on the approval; the caller finalizes the stream
    // with no terminal execution event and no step usage yet.
    finishPart({
      finishReason: { unified: "other", raw: undefined },
      usage: { input: 0, output: 0 },
      messageId: MSG_A,
    }),
  ],
};

// --- Case 2: permission arrives before ANY tool event (fully buffered) ---

const f2 = eventFactory();
const MSG_B = "msg_p2";
const TOOL_B = "tool_perm2";
const INPUT_B = '{"x":1}';
const CONTENT_B: [ToolContent1, ...ToolContent1[]] = [
  { type: "text", text: "ok" },
];

/**
 * `permission.asked` arrives before the tool has produced any event: the
 * approval is buffered and flushed immediately after the tool call is
 * registered (`tool.called`), before the tool result.
 */
export const permissionBeforeToolStart: V2EventFixture = {
  name: "permission buffered until tool call",
  description:
    "issue #22: approval received pre-input is buffered and flushed after tool-call",
  sessionId: SESSION_ID,
  events: [
    f2.executionStarted(),
    f2.stepStarted(MSG_B),
    f2.permissionAsked("perm_2", {
      action: "tool.execute",
      resources: ["*"],
      source: { type: "tool", messageID: MSG_B, id: TOOL_B },
    }),
    f2.toolInputStarted(MSG_B, TOOL_B, "compute"),
    f2.toolInputDelta(MSG_B, TOOL_B, INPUT_B),
    f2.toolInputEnded(MSG_B, TOOL_B, INPUT_B),
    f2.toolCalled(MSG_B, TOOL_B, { x: 1 }, true),
    f2.toolSuccess(MSG_B, TOOL_B, CONTENT_B, true),
    f2.stepEnded(MSG_B, "stop", tokens(10, 2), 0),
    f2.executionSucceeded(),
  ],
  expected: [
    {
      type: "tool-input-start",
      id: TOOL_B,
      toolName: "compute",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL_B, delta: INPUT_B },
    { type: "tool-input-end", id: TOOL_B },
    {
      type: "tool-call",
      toolCallId: TOOL_B,
      toolName: "compute",
      input: INPUT_B,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-approval-request",
      approvalId: "perm_2",
      toolCallId: TOOL_B,
      providerMetadata: {
        opencode: {
          sessionId: SESSION_ID,
          action: "tool.execute",
          resources: ["*"],
        },
      },
    },
    {
      type: "tool-result",
      toolCallId: TOOL_B,
      toolName: "compute",
      result: asJson(CONTENT_B),
      isError: false,
      dynamic: true,
      providerMetadata: { opencode: { content: asJson(CONTENT_B) } },
    },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 10, output: 2 },
      messageId: MSG_B,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};

// --- Case 3: source-less permission ---

const f3 = eventFactory();
const MSG_C = "msg_p3";

/**
 * A `permission.asked` without a `source` has no tool to correlate with:
 * it is emitted immediately, keyed by the request id.
 */
export const permissionSourceless: V2EventFixture = {
  name: "source-less permission",
  description:
    "permission without source emits immediately keyed by request id",
  sessionId: SESSION_ID,
  events: [
    f3.executionStarted(),
    f3.stepStarted(MSG_C),
    f3.permissionAsked("perm_3", {
      action: "network.fetch",
      resources: ["https://example.com"],
      message: "Allow outbound fetch?",
    }),
  ],
  finalize: true,
  expected: [
    {
      type: "tool-approval-request",
      approvalId: "perm_3",
      toolCallId: "perm_3",
      providerMetadata: {
        opencode: {
          sessionId: SESSION_ID,
          action: "network.fetch",
          resources: ["https://example.com"],
          message: "Allow outbound fetch?",
        },
      },
    },
    finishPart({
      finishReason: { unified: "other", raw: undefined },
      usage: { input: 0, output: 0 },
      messageId: MSG_C,
    }),
  ],
};
