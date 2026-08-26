import { describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { FormCreated } from "@opencode-ai/client";
import {
  convertV2EventToStreamParts,
  createStreamStartPart,
  createV2StreamState,
  extractV2EventSessionId,
  finalizeV2Stream,
  normalizeReducerInput,
  UNKNOWN_TOOL_NAME,
  type V2StreamState,
} from "./convert-from-opencode-events.js";
import {
  eventFactory,
  fixtures,
  tokens,
  OTHER_SESSION_ID,
  SESSION_ID,
  type V2EventFixture,
} from "../test/fixtures/v2-events/index.js";

function runFixture(fixture: V2EventFixture): {
  parts: LanguageModelV4StreamPart[];
  state: V2StreamState;
  forms: string[];
} {
  const forms: string[] = [];
  const state = createV2StreamState({
    sessionId: fixture.sessionId,
    includeRawChunks: fixture.includeRawChunks ?? false,
    onForm: (form: FormCreated["data"]["form"]) => forms.push(form.id),
    logger: false,
  });
  const parts = fixture.events.flatMap((event) =>
    convertV2EventToStreamParts(event, state),
  );
  if (fixture.finalize) {
    parts.push(...finalizeV2Stream(state));
  }
  return { parts, state, forms };
}

describe("convertV2EventToStreamParts (fixture library)", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const { parts, state, forms } = runFixture(fixture);
      expect(parts).toEqual(fixture.expected);
      expect(forms).toEqual(fixture.expectedForms ?? []);
      if (fixture.expectLogSynced !== undefined) {
        expect(state.logSynced).toBe(fixture.expectLogSynced);
      }
    });

    it(`${fixture.name} — deterministic on re-run`, () => {
      expect(runFixture(fixture).parts).toEqual(runFixture(fixture).parts);
    });
  }
});

describe("normalizeReducerInput", () => {
  it("maps the log.synced sentinel", () => {
    expect(
      normalizeReducerInput({
        type: "log.synced",
        aggregateID: SESSION_ID,
        seq: 7,
      }),
    ).toEqual({ kind: "log-synced", aggregateID: SESSION_ID, seq: 7 });
  });

  it("passes events through", () => {
    const f = eventFactory();
    const event = f.sessionIdle();
    expect(normalizeReducerInput(event)).toEqual({ kind: "event", event });
  });
});

describe("extractV2EventSessionId", () => {
  const f = eventFactory();

  it("reads data.sessionID for ordinary session events", () => {
    expect(extractV2EventSessionId(f.textDelta("msg", 0, "x"))).toBe(
      SESSION_ID,
    );
  });

  it("reads data.form.sessionID for form.created", () => {
    expect(
      extractV2EventSessionId(
        f.formCreated("form_x", "Title", [{ key: "k", type: "string" }]),
      ),
    ).toBe(SESSION_ID);
  });

  it("returns undefined for non-session events", () => {
    expect(
      extractV2EventSessionId({
        id: "evt_x",
        type: "server.connected",
        data: {},
      }),
    ).toBeUndefined();
  });
});

describe("session filtering", () => {
  it("ignores events for other sessions entirely (including raw)", () => {
    const other = eventFactory(OTHER_SESSION_ID);
    const state = createV2StreamState({
      sessionId: SESSION_ID,
      includeRawChunks: true,
    });
    expect(
      convertV2EventToStreamParts(other.textDelta("msg", 0, "x"), state),
    ).toEqual([]);
  });
});

describe("includeRawChunks", () => {
  it("emits a raw part before semantic parts", () => {
    const f = eventFactory();
    const state = createV2StreamState({
      sessionId: SESSION_ID,
      includeRawChunks: true,
    });
    const event = f.textDelta("msg_raw", 0, "hi");
    const parts = convertV2EventToStreamParts(event, state);
    expect(parts[0]).toEqual({ type: "raw", rawValue: event });
    expect(parts.slice(1)).toEqual([
      { type: "text-start", id: "msg_raw:text:0" },
      { type: "text-delta", id: "msg_raw:text:0", delta: "hi" },
    ]);
  });

  it("emits a raw part for the log.synced sentinel", () => {
    const state = createV2StreamState({
      sessionId: SESSION_ID,
      includeRawChunks: true,
    });
    const sentinel = { type: "log.synced" as const, aggregateID: SESSION_ID };
    expect(convertV2EventToStreamParts(sentinel, state)).toEqual([
      { type: "raw", rawValue: sentinel },
    ]);
    expect(state.logSynced).toBe(true);
  });
});

describe("permission.replied", () => {
  it("drops a buffered approval answered externally", () => {
    const f = eventFactory();
    const state = createV2StreamState({ sessionId: SESSION_ID, logger: false });
    const msg = "msg_pr";
    const tool = "tool_pr";

    convertV2EventToStreamParts(f.stepStarted(msg), state);
    // Buffered: no input yet.
    expect(
      convertV2EventToStreamParts(
        f.permissionAsked("perm_ext", {
          source: { type: "tool", messageID: msg, id: tool },
        }),
        state,
      ),
    ).toEqual([]);
    // Replied externally before the tool call registered.
    convertV2EventToStreamParts(f.permissionReplied("perm_ext", "once"), state);

    const parts = [
      ...convertV2EventToStreamParts(f.toolInputStarted(msg, tool, "t"), state),
      ...convertV2EventToStreamParts(f.toolInputEnded(msg, tool, "{}"), state),
      ...convertV2EventToStreamParts(f.toolCalled(msg, tool, {}), state),
    ];
    expect(
      parts.filter((part) => part.type === "tool-approval-request"),
    ).toEqual([]);
  });
});

describe("tolerated stream anomalies", () => {
  it("synthesizes a tool-input-start with a placeholder name on a missed input.started", () => {
    const f = eventFactory();
    const warnings: string[] = [];
    const state = createV2StreamState({
      sessionId: SESSION_ID,
      logger: { warn: (m) => warnings.push(m), error: () => {} },
    });
    const parts = convertV2EventToStreamParts(
      f.toolInputDelta("msg_x", "tool_x", '{"a":1}'),
      state,
    );
    expect(parts).toEqual([
      {
        type: "tool-input-start",
        id: "tool_x",
        toolName: UNKNOWN_TOOL_NAME,
        providerExecuted: true,
        dynamic: true,
      },
      { type: "tool-input-delta", id: "tool_x", delta: '{"a":1}' },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("keeps streamed content and warns when the final text diverges non-prefix", () => {
    const f = eventFactory();
    const warnings: string[] = [];
    const state = createV2StreamState({
      sessionId: SESSION_ID,
      logger: { warn: (m) => warnings.push(m), error: () => {} },
    });
    const msg = "msg_div";
    convertV2EventToStreamParts(f.textStarted(msg, 0), state);
    convertV2EventToStreamParts(f.textDelta(msg, 0, "streamed"), state);
    const parts = convertV2EventToStreamParts(
      f.textEnded(msg, 0, "different final"),
      state,
    );
    expect(parts).toEqual([{ type: "text-end", id: `${msg}:text:0` }]);
    expect(warnings).toHaveLength(1);
  });
});

describe("finalizeV2Stream", () => {
  it("is a no-op after a terminal execution event", () => {
    const f = eventFactory();
    const state = createV2StreamState({ sessionId: SESSION_ID });
    convertV2EventToStreamParts(f.stepStarted("msg_z"), state);
    convertV2EventToStreamParts(
      f.stepEnded("msg_z", "stop", tokens(1, 1), 0),
      state,
    );
    convertV2EventToStreamParts(f.executionSucceeded(), state);
    expect(finalizeV2Stream(state)).toEqual([]);
  });

  it("uses an explicit finish reason when given", () => {
    const state = createV2StreamState({ sessionId: SESSION_ID });
    const parts = finalizeV2Stream(state, { unified: "stop", raw: "idle" });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "idle" },
    });
  });

  it("never defaults to a retained tool-calls step finish", () => {
    // Step ended tool-calls and the stream stalled before the next
    // step.started: "tool-calls" is an intermediate finish, not a valid
    // terminal reason for a backstopped turn.
    const f = eventFactory();
    const state = createV2StreamState({ sessionId: SESSION_ID });
    convertV2EventToStreamParts(f.stepStarted("msg_bt"), state);
    convertV2EventToStreamParts(
      f.stepEnded("msg_bt", "tool-calls", tokens(1, 1), 0),
      state,
    );
    const parts = finalizeV2Stream(state);
    expect(parts[0]).toMatchObject({
      type: "finish",
      finishReason: { unified: "other", raw: "tool-calls" },
    });
  });

  it("flushes a still-buffered approval before the finish part", () => {
    // Last resort: permission.asked buffered against a tool that never
    // produced input; finalize must still surface the approval (with a
    // registered call) or the two-phase round-trip deadlocks.
    const f = eventFactory();
    const state = createV2StreamState({ sessionId: SESSION_ID });
    convertV2EventToStreamParts(f.stepStarted("msg_fa"), state);
    convertV2EventToStreamParts(
      f.permissionAsked("perm_fa", {
        source: { type: "tool", messageID: "msg_fa", id: "tool_fa" },
      }),
      state,
    );
    const parts = finalizeV2Stream(state);
    expect(parts.map((part) => part.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "tool-approval-request",
      "finish",
    ]);
    expect(parts[3]).toMatchObject({
      toolCallId: "tool_fa",
      toolName: UNKNOWN_TOOL_NAME,
      input: "{}",
    });
    expect(parts[4]).toMatchObject({
      approvalId: "perm_fa",
      toolCallId: "tool_fa",
    });
  });

  it("falls back to {} when a buffered approval's input never completed", () => {
    // A half-streamed JSON fragment must never become the published input.
    const f = eventFactory();
    const state = createV2StreamState({ sessionId: SESSION_ID, logger: false });
    convertV2EventToStreamParts(
      f.toolInputStarted("msg_pf", "tool_pf", "write_file"),
      state,
    );
    convertV2EventToStreamParts(
      f.toolInputDelta("msg_pf", "tool_pf", '{"path":'),
      state,
    );
    convertV2EventToStreamParts(
      f.permissionAsked("perm_pf", {
        source: { type: "tool", messageID: "msg_pf", id: "tool_pf" },
      }),
      state,
    );
    const parts = finalizeV2Stream(state);
    const call = parts.find((part) => part.type === "tool-call");
    expect(call).toMatchObject({ toolCallId: "tool_pf", input: "{}" });
    expect(
      parts.find((part) => part.type === "tool-approval-request"),
    ).toMatchObject({ approvalId: "perm_pf" });
  });
});

describe("log.synced session scoping", () => {
  it("ignores a foreign session's sentinel", () => {
    const state = createV2StreamState({
      sessionId: SESSION_ID,
      includeRawChunks: true,
    });
    const foreign = {
      type: "log.synced" as const,
      aggregateID: OTHER_SESSION_ID,
    };
    expect(convertV2EventToStreamParts(foreign, state)).toEqual([]);
    expect(state.logSynced).toBe(false);
  });
});

describe("createStreamStartPart", () => {
  it("wraps warnings", () => {
    expect(createStreamStartPart(["a", "b"])).toEqual({
      type: "stream-start",
      warnings: [
        { type: "other", message: "a" },
        { type: "other", message: "b" },
      ],
    });
  });
});
