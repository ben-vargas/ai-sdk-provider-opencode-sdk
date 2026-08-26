/**
 * Builders for hand-built, type-checked v2 event fixtures.
 *
 * Fixtures are constructed from the beta-18286 generated types — NOT from
 * spike captures (the spike's DEV-branch server spoke a different protocol,
 * `session.next.*`). Every builder returns a fully-typed `V2Event` member,
 * so a pinned-beta bump that changes an event shape fails `npm run
 * typecheck` inside the fixture library.
 */
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type {
  EventLogSynced,
  FormCreated,
  PermissionAsked,
  PermissionReplied,
  PermissionReply,
  SessionExecutionFailed,
  SessionExecutionInterrupted,
  SessionExecutionStarted,
  SessionExecutionSucceeded,
  SessionIdle,
  SessionReasoningDelta,
  SessionReasoningEnded,
  SessionReasoningStarted,
  SessionStepEnded,
  SessionStepFailed,
  SessionStepStarted,
  SessionStructuredError,
  SessionTextDelta,
  SessionTextEnded,
  SessionTextStarted,
  SessionToolCalled,
  SessionToolFailed,
  SessionToolInputDelta,
  SessionToolInputEnded,
  SessionToolInputStarted,
  SessionToolSuccess,
  TokenUsageInfo,
} from "@opencode-ai/client";
import type { OpencodeReducerInput } from "../../../src/convert-from-opencode-events.js";

/** Session ID shared by all fixtures unless a fixture needs a foreign one. */
export const SESSION_ID = "ses_fixture01";

/** A session ID that is NOT the fixture session (cross-session noise). */
export const OTHER_SESSION_ID = "ses_other";

/**
 * A single fixture: a typed event sequence plus the exact stream parts the
 * reducer must produce for it.
 */
export interface V2EventFixture {
  name: string;
  description: string;
  sessionId: string;
  includeRawChunks?: boolean;
  events: OpencodeReducerInput[];
  expected: LanguageModelV4StreamPart[];
  /**
   * Call `finalizeV2Stream` after all events (turn without a terminal
   * execution event); its parts are appended to the reducer output before
   * comparing against `expected`.
   */
  finalize?: boolean;
  /** Form IDs expected to reach the `onForm` handler, in order. */
  expectedForms?: string[];
  /** Assert `state.logSynced` after the run. */
  expectLogSynced?: boolean;
}

/**
 * Deterministic event-envelope factory. Event ids, timestamps, and durable
 * sequence numbers are monotonic counters so fixture files stay stable.
 */
export function eventFactory(sessionId: string = SESSION_ID) {
  let eventCount = 0;
  let seq = 0;

  const envelope = () => {
    eventCount += 1;
    return {
      id: `evt_${String(eventCount).padStart(3, "0")}`,
      created: 1756200000000 + eventCount,
    };
  };

  const durable = <V extends 1 | 2>(version: V) => {
    seq += 1;
    return { aggregateID: sessionId, seq, version };
  };

  return {
    executionStarted(): SessionExecutionStarted {
      return {
        ...envelope(),
        type: "session.execution.started",
        durable: durable(1),
        data: { sessionID: sessionId },
      };
    },

    executionSucceeded(): SessionExecutionSucceeded {
      return {
        ...envelope(),
        type: "session.execution.succeeded",
        durable: durable(1),
        data: { sessionID: sessionId },
      };
    },

    executionFailed(error: SessionStructuredError): SessionExecutionFailed {
      return {
        ...envelope(),
        type: "session.execution.failed",
        durable: durable(1),
        data: { sessionID: sessionId, error },
      };
    },

    executionInterrupted(
      reason: SessionExecutionInterrupted["data"]["reason"],
    ): SessionExecutionInterrupted {
      return {
        ...envelope(),
        type: "session.execution.interrupted",
        durable: durable(1),
        data: { sessionID: sessionId, reason },
      };
    },

    stepStarted(assistantMessageID: string): SessionStepStarted {
      return {
        ...envelope(),
        type: "session.step.started",
        durable: durable(1),
        data: {
          sessionID: sessionId,
          assistantMessageID,
          agent: "default",
          model: { id: "fixture-model", providerID: "fixture" },
        },
      };
    },

    stepEnded(
      assistantMessageID: string,
      finish: SessionStepEnded["data"]["finish"],
      tokens: TokenUsageInfo,
      cost: number,
      rawFinish?: string,
    ): SessionStepEnded {
      return {
        ...envelope(),
        type: "session.step.ended",
        durable: durable(1),
        data: {
          sessionID: sessionId,
          assistantMessageID,
          finish,
          ...(rawFinish !== undefined ? { rawFinish } : {}),
          cost,
          tokens,
        },
      };
    },

    stepFailed(
      assistantMessageID: string,
      error: SessionStructuredError,
      options: {
        finish?: "content-filter";
        rawFinish?: string;
        tokens?: TokenUsageInfo;
        cost?: number;
      } = {},
    ): SessionStepFailed {
      return {
        ...envelope(),
        type: "session.step.failed",
        durable: durable(1),
        data: {
          sessionID: sessionId,
          assistantMessageID,
          error,
          ...(options.finish !== undefined ? { finish: options.finish } : {}),
          ...(options.rawFinish !== undefined
            ? { rawFinish: options.rawFinish }
            : {}),
          ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
          ...(options.cost !== undefined ? { cost: options.cost } : {}),
        },
      };
    },

    textStarted(
      assistantMessageID: string,
      ordinal: number,
    ): SessionTextStarted {
      return {
        ...envelope(),
        type: "session.text.started",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, ordinal },
      };
    },

    textDelta(
      assistantMessageID: string,
      ordinal: number,
      delta: string,
    ): SessionTextDelta {
      return {
        ...envelope(),
        type: "session.text.delta",
        data: { sessionID: sessionId, assistantMessageID, ordinal, delta },
      };
    },

    textEnded(
      assistantMessageID: string,
      ordinal: number,
      text: string,
    ): SessionTextEnded {
      return {
        ...envelope(),
        type: "session.text.ended",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, ordinal, text },
      };
    },

    reasoningStarted(
      assistantMessageID: string,
      ordinal: number,
    ): SessionReasoningStarted {
      return {
        ...envelope(),
        type: "session.reasoning.started",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, ordinal },
      };
    },

    reasoningDelta(
      assistantMessageID: string,
      ordinal: number,
      delta: string,
    ): SessionReasoningDelta {
      return {
        ...envelope(),
        type: "session.reasoning.delta",
        data: { sessionID: sessionId, assistantMessageID, ordinal, delta },
      };
    },

    reasoningEnded(
      assistantMessageID: string,
      ordinal: number,
      text: string,
    ): SessionReasoningEnded {
      return {
        ...envelope(),
        type: "session.reasoning.ended",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, ordinal, text },
      };
    },

    toolInputStarted(
      assistantMessageID: string,
      id: string,
      name: string,
    ): SessionToolInputStarted {
      return {
        ...envelope(),
        type: "session.tool.input.started",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, id, name },
      };
    },

    toolInputDelta(
      assistantMessageID: string,
      id: string,
      delta: string,
    ): SessionToolInputDelta {
      return {
        ...envelope(),
        type: "session.tool.input.delta",
        data: { sessionID: sessionId, assistantMessageID, id, delta },
      };
    },

    toolInputEnded(
      assistantMessageID: string,
      id: string,
      text: string,
    ): SessionToolInputEnded {
      return {
        ...envelope(),
        type: "session.tool.input.ended",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, id, text },
      };
    },

    toolCalled(
      assistantMessageID: string,
      id: string,
      input: Record<string, unknown>,
      executed = true,
    ): SessionToolCalled {
      return {
        ...envelope(),
        type: "session.tool.called",
        durable: durable(1),
        data: { sessionID: sessionId, assistantMessageID, id, input, executed },
      };
    },

    toolSuccess(
      assistantMessageID: string,
      id: string,
      content: SessionToolSuccess["data"]["content"],
      executed = true,
    ): SessionToolSuccess {
      return {
        ...envelope(),
        type: "session.tool.success",
        durable: durable(2),
        data: {
          sessionID: sessionId,
          assistantMessageID,
          id,
          content,
          executed,
        },
      };
    },

    toolFailed(
      assistantMessageID: string,
      id: string,
      error: SessionStructuredError,
      options: {
        content?: SessionToolFailed["data"]["content"];
        executed?: boolean;
      } = {},
    ): SessionToolFailed {
      return {
        ...envelope(),
        type: "session.tool.failed",
        durable: durable(2),
        data: {
          sessionID: sessionId,
          assistantMessageID,
          id,
          error,
          ...(options.content ? { content: options.content } : {}),
          executed: options.executed ?? true,
        },
      };
    },

    permissionAsked(
      id: string,
      options: {
        action?: string;
        resources?: string[];
        source?: PermissionAsked["data"]["source"];
        save?: string[];
        message?: string;
      } = {},
    ): PermissionAsked {
      return {
        ...envelope(),
        type: "permission.asked",
        data: {
          id,
          sessionID: sessionId,
          action: options.action ?? "tool.execute",
          resources: options.resources ?? ["*"],
          ...(options.source ? { source: options.source } : {}),
          ...(options.save ? { save: options.save } : {}),
          ...(options.message !== undefined
            ? { message: options.message }
            : {}),
        },
      };
    },

    permissionReplied(
      requestID: string,
      reply: PermissionReply,
    ): PermissionReplied {
      return {
        ...envelope(),
        type: "permission.replied",
        data: { sessionID: sessionId, requestID, reply },
      };
    },

    formCreated(
      formId: string,
      title: string,
      fields: FormCreated["data"]["form"]["fields"],
    ): FormCreated {
      return {
        ...envelope(),
        type: "form.created",
        data: {
          form: { id: formId, sessionID: sessionId, title, fields },
        },
      };
    },

    sessionIdle(): SessionIdle {
      return {
        ...envelope(),
        type: "session.idle",
        data: { sessionID: sessionId },
      };
    },

    logSynced(): EventLogSynced {
      return { type: "log.synced", aggregateID: sessionId, seq };
    },
  };
}

/**
 * Structural clone of an event — a redelivered duplicate carrying the same
 * durable envelope (the idempotency case).
 */
export function duplicate<T extends OpencodeReducerInput>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

/**
 * Widen a typed value to `JSONValue` for expected-part literals (tool
 * results and provider metadata carry pass-through server shapes).
 */
export function asJson<T>(value: T): NonNullable<JSONValue> {
  return value as unknown as NonNullable<JSONValue>;
}

/** Compact TokenUsageInfo builder. */
export function tokens(
  input: number,
  output: number,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
): TokenUsageInfo {
  return {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

interface UsageTotals {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/**
 * The AI SDK usage object the reducer builds from accumulated totals —
 * mirrors `buildUsage` in the reducer.
 */
export function expectedUsage(totals: UsageTotals): LanguageModelV4Usage {
  const reasoning = totals.reasoning ?? 0;
  const cacheRead = totals.cacheRead ?? 0;
  const cacheWrite = totals.cacheWrite ?? 0;
  return {
    inputTokens: {
      total: totals.input + cacheRead + cacheWrite,
      noCache: totals.input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: totals.output,
      text: undefined,
      reasoning,
    },
    raw: {
      input_tokens: totals.input,
      output_tokens: totals.output,
      reasoning_tokens: reasoning,
      cache_read_input_tokens: cacheRead,
      cache_write_input_tokens: cacheWrite,
      total_cost: totals.cost ?? 0,
    },
  };
}

/**
 * The `finish` stream part the reducer emits, with provider metadata built
 * from the same totals.
 */
export function finishPart(options: {
  finishReason: LanguageModelV4FinishReason;
  usage: UsageTotals;
  sessionId?: string;
  messageId?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  interruptReason?: "user" | "shutdown" | "superseded";
  finish?: string;
  rawFinish?: string;
  error?: SessionStructuredError;
}): LanguageModelV4StreamPart {
  return {
    type: "finish",
    finishReason: options.finishReason,
    usage: expectedUsage(options.usage),
    providerMetadata: {
      opencode: {
        sessionId: options.sessionId ?? SESSION_ID,
        ...(options.messageId ? { messageId: options.messageId } : {}),
        ...(options.outcome ? { outcome: options.outcome } : {}),
        ...(options.interruptReason
          ? { interruptReason: options.interruptReason }
          : {}),
        cost: options.usage.cost ?? 0,
        tokens: {
          input: options.usage.input,
          output: options.usage.output,
          reasoning: options.usage.reasoning ?? 0,
          cache: {
            read: options.usage.cacheRead ?? 0,
            write: options.usage.cacheWrite ?? 0,
          },
        },
        ...(options.finish ? { finish: options.finish } : {}),
        ...(options.rawFinish !== undefined
          ? { rawFinish: options.rawFinish }
          : {}),
        ...(options.error
          ? { error: options.error as unknown as JSONValue }
          : {}),
      },
    },
  };
}
