import type { ToolContent1 } from "@opencode/client";
import {
  asJson,
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

// --- Case 1: permission arrives mid-input-stream (issue #22 ordering) ---

const f1 = eventFactory();
const MSG_A = "msg_p1";
const TOOL_A = "tool_perm1";
const INPUT_A = '{"path":"b.txt"}';

/**
 * `permission.asked` correlated via `source.id` races ahead of the input
 * stream (issue #22's observed order: input.started, permission, deltas):
 * the approval is buffered — registering the call from a partial delta
 * would publish a JSON fragment as `tool-call.input` — and flushed when
 * `input.ended` completes the input. The server will not emit `tool.called`
 * while blocked on the reply, so input completion is the flush point.
 */
export const permissionBeforeInputAvailable: V2EventFixture = {
  name: "permission before tool-input-available",
  description:
    "issue #22: approval buffered across partial deltas, flushed on input.ended",
  sessionId: SESSION_ID,
  events: [
    f1.executionStarted(),
    f1.stepStarted(MSG_A),
    f1.toolInputStarted(MSG_A, TOOL_A, "write_file"),
    f1.toolInputDelta(MSG_A, TOOL_A, '{"path":'),
    f1.permissionAsked("perm_1", {
      action: "file.write",
      resources: ["b.txt"],
      source: { type: "tool", messageID: MSG_A, id: TOOL_A },
    }),
    f1.toolInputDelta(MSG_A, TOOL_A, '"b.txt"}'),
    f1.toolInputEnded(MSG_A, TOOL_A, INPUT_A),
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
    { type: "tool-input-delta", id: TOOL_A, delta: '{"path":' },
    { type: "tool-input-delta", id: TOOL_A, delta: '"b.txt"}' },
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

// --- Case 2: permission arrives after input.ended (early registration) ---

const f2 = eventFactory();
const MSG_B = "msg_p2";
const TOOL_B = "tool_perm2";
const INPUT_B = '{"path":"c.txt"}';

/**
 * `permission.asked` arrives after the input completed but before
 * `tool.called` (the realistic blocked-turn order — the server pauses at
 * the permission gate before executing): the reducer registers the tool
 * call early from the final input so the approval lands after
 * tool-input-available (issue #22), then the blocked turn is returned to
 * the caller via finalize.
 */
export const permissionAfterInputEnded: V2EventFixture = {
  name: "permission after input.ended, before tool.called",
  description:
    "issue #22: approval triggers early tool-call registration from complete input",
  sessionId: SESSION_ID,
  events: [
    f2.executionStarted(),
    f2.stepStarted(MSG_B),
    f2.toolInputStarted(MSG_B, TOOL_B, "write_file"),
    f2.toolInputDelta(MSG_B, TOOL_B, INPUT_B),
    f2.toolInputEnded(MSG_B, TOOL_B, INPUT_B),
    f2.permissionAsked("perm_2", {
      action: "file.write",
      resources: ["c.txt"],
      source: { type: "tool", messageID: MSG_B, id: TOOL_B },
    }),
  ],
  finalize: true,
  expected: [
    {
      type: "tool-input-start",
      id: TOOL_B,
      toolName: "write_file",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL_B, delta: INPUT_B },
    { type: "tool-input-end", id: TOOL_B },
    {
      type: "tool-call",
      toolCallId: TOOL_B,
      toolName: "write_file",
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
          action: "file.write",
          resources: ["c.txt"],
        },
      },
    },
    finishPart({
      finishReason: { unified: "other", raw: undefined },
      usage: { input: 0, output: 0 },
      messageId: MSG_B,
    }),
  ],
};

// --- Case 3: permission arrives before ANY tool event (fully buffered) ---

const f3 = eventFactory();
const MSG_C = "msg_p3";
const TOOL_C = "tool_perm3";
const INPUT_C = '{"x":1}';
const CONTENT_C: [ToolContent1, ...ToolContent1[]] = [
  { type: "text", text: "ok" },
];

/**
 * `permission.asked` arrives before the tool has produced any event: the
 * approval is buffered and flushed when `input.ended` completes the input,
 * before `tool.called` and the tool result.
 */
export const permissionBeforeToolStart: V2EventFixture = {
  name: "permission buffered until tool call",
  description:
    "issue #22: approval received pre-input is buffered and flushed on input.ended",
  sessionId: SESSION_ID,
  events: [
    f3.executionStarted(),
    f3.stepStarted(MSG_C),
    f3.permissionAsked("perm_3", {
      action: "tool.execute",
      resources: ["*"],
      source: { type: "tool", messageID: MSG_C, id: TOOL_C },
    }),
    f3.toolInputStarted(MSG_C, TOOL_C, "compute"),
    f3.toolInputDelta(MSG_C, TOOL_C, INPUT_C),
    f3.toolInputEnded(MSG_C, TOOL_C, INPUT_C),
    f3.toolCalled(MSG_C, TOOL_C, { x: 1 }, true),
    f3.toolSuccess(MSG_C, TOOL_C, CONTENT_C, true),
    f3.stepEnded(MSG_C, "stop", tokens(10, 2), 0),
    f3.executionSucceeded(),
  ],
  expected: [
    {
      type: "tool-input-start",
      id: TOOL_C,
      toolName: "compute",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL_C, delta: INPUT_C },
    { type: "tool-input-end", id: TOOL_C },
    {
      type: "tool-call",
      toolCallId: TOOL_C,
      toolName: "compute",
      input: INPUT_C,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-approval-request",
      approvalId: "perm_3",
      toolCallId: TOOL_C,
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
      toolCallId: TOOL_C,
      toolName: "compute",
      result: asJson(CONTENT_C),
      isError: false,
      dynamic: true,
      providerMetadata: { opencode: { content: asJson(CONTENT_C) } },
    },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 10, output: 2 },
      messageId: MSG_C,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};

// --- Case 4: source-less permission ---

const f4 = eventFactory();
const MSG_D = "msg_p4";
const PERM_INPUT = JSON.stringify({
  action: "network.fetch",
  resources: ["https://example.com"],
  message: "Allow outbound fetch?",
});

/**
 * A `permission.asked` without a `source` has no tool to correlate with.
 * The AI SDK rejects a `tool-approval-request` whose `toolCallId` has no
 * prior `tool-call` (`ToolCallNotFoundForApprovalError`), so the reducer
 * registers a synthetic "permission" call — keyed by the request id,
 * carrying the permission payload as its input — before the approval.
 */
export const permissionSourceless: V2EventFixture = {
  name: "source-less permission",
  description:
    "permission without source registers a synthetic permission call before the approval",
  sessionId: SESSION_ID,
  events: [
    f4.executionStarted(),
    f4.stepStarted(MSG_D),
    f4.permissionAsked("perm_4", {
      action: "network.fetch",
      resources: ["https://example.com"],
      message: "Allow outbound fetch?",
    }),
  ],
  finalize: true,
  expected: [
    {
      type: "tool-input-start",
      id: "perm_4",
      toolName: "permission",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: "perm_4", delta: PERM_INPUT },
    { type: "tool-input-end", id: "perm_4" },
    {
      type: "tool-call",
      toolCallId: "perm_4",
      toolName: "permission",
      input: PERM_INPUT,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-approval-request",
      approvalId: "perm_4",
      toolCallId: "perm_4",
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
      messageId: MSG_D,
    }),
  ],
};

// --- Case 5: approval-blocked turn after an ended intermediate step ---

const f5 = eventFactory();
const MSG_E1 = "msg_p5a";
const MSG_E2 = "msg_p5b";
const TOOL_E1 = "tool_perm5a";
const TOOL_E2 = "tool_perm5b";
const INPUT_E1 = '{"path":"a.txt"}';
const INPUT_E2 = '{"path":"d.txt"}';
const CONTENT_E1: [ToolContent1, ...ToolContent1[]] = [
  { type: "text", text: "contents of a.txt" },
];

/**
 * A prior step ended with finish `"tool-calls"`, the next step started, and
 * the turn then blocks on an approval: the backstop finalize must NOT
 * finish as the intermediate step's `"tool-calls"` — `step.started` clears
 * the retained step finish, so the blocked turn finishes as `other`.
 */
export const approvalBlockedAfterIntermediateStep: V2EventFixture = {
  name: "approval blocked after intermediate tool-calls step",
  description:
    "backstop finalize never reuses an ended intermediate step's tool-calls finish",
  sessionId: SESSION_ID,
  events: [
    f5.executionStarted(),
    f5.stepStarted(MSG_E1),
    f5.toolInputStarted(MSG_E1, TOOL_E1, "read_file"),
    f5.toolInputDelta(MSG_E1, TOOL_E1, INPUT_E1),
    f5.toolInputEnded(MSG_E1, TOOL_E1, INPUT_E1),
    f5.toolCalled(MSG_E1, TOOL_E1, { path: "a.txt" }, true),
    f5.toolSuccess(MSG_E1, TOOL_E1, CONTENT_E1, true),
    f5.stepEnded(MSG_E1, "tool-calls", tokens(100, 20), 0.25),
    f5.stepStarted(MSG_E2),
    f5.toolInputStarted(MSG_E2, TOOL_E2, "write_file"),
    f5.toolInputDelta(MSG_E2, TOOL_E2, INPUT_E2),
    f5.toolInputEnded(MSG_E2, TOOL_E2, INPUT_E2),
    f5.permissionAsked("perm_5", {
      action: "file.write",
      resources: ["d.txt"],
      source: { type: "tool", messageID: MSG_E2, id: TOOL_E2 },
    }),
  ],
  finalize: true,
  expected: [
    {
      type: "tool-input-start",
      id: TOOL_E1,
      toolName: "read_file",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL_E1, delta: INPUT_E1 },
    { type: "tool-input-end", id: TOOL_E1 },
    {
      type: "tool-call",
      toolCallId: TOOL_E1,
      toolName: "read_file",
      input: INPUT_E1,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-result",
      toolCallId: TOOL_E1,
      toolName: "read_file",
      result: asJson(CONTENT_E1),
      isError: false,
      dynamic: true,
      providerMetadata: { opencode: { content: asJson(CONTENT_E1) } },
    },
    {
      type: "tool-input-start",
      id: TOOL_E2,
      toolName: "write_file",
      providerExecuted: true,
      dynamic: true,
    },
    { type: "tool-input-delta", id: TOOL_E2, delta: INPUT_E2 },
    { type: "tool-input-end", id: TOOL_E2 },
    {
      type: "tool-call",
      toolCallId: TOOL_E2,
      toolName: "write_file",
      input: INPUT_E2,
      providerExecuted: true,
      dynamic: true,
    },
    {
      type: "tool-approval-request",
      approvalId: "perm_5",
      toolCallId: TOOL_E2,
      providerMetadata: {
        opencode: {
          sessionId: SESSION_ID,
          action: "file.write",
          resources: ["d.txt"],
        },
      },
    },
    // No `finish` in metadata: the intermediate step's "tool-calls" was
    // cleared by the second step.started and is not this turn's finish.
    finishPart({
      finishReason: { unified: "other", raw: undefined },
      usage: { input: 100, output: 20, cost: 0.25 },
      messageId: MSG_E2,
    }),
  ],
};
