/**
 * V2 event reducer: turns OpenCode v2 event streams into AI SDK
 * `LanguageModelV4StreamPart`s.
 *
 * Pure and deterministic: all state lives in the `V2StreamState` the caller
 * threads through, so the same input sequence always yields the same parts.
 * The reducer accepts BOTH unions the server can produce — live SSE
 * `V2Event`s and `session.log` replay items (`SessionLogItem`: the durable
 * event union plus the `log.synced` sentinel). These genuinely diverge
 * (deltas and permission/form events are live-only; `session.usage.recorded`
 * is durable-only), so an explicit normalization layer sits in front of the
 * event switch rather than assuming log replay yields `V2Event`s.
 *
 * The reducer does NOT decide when a turn is over beyond the explicit
 * `session.execution.succeeded/failed/interrupted` events (which emit the
 * `finish` part inline). `session.idle` is deliberately ignored here — it is
 * only a hang-prevention backstop, which the orchestration layer applies by
 * calling {@link finalizeV2Stream}. A `"tool-calls"` finish on an
 * intermediate step never finishes the stream.
 */
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type {
  FormCreated,
  PermissionAsked,
  SessionLogItem,
  SessionMessageAssistantRetry,
  SessionStructuredError,
  SessionToolFailed,
  SessionToolSuccess,
  V2Event,
} from "@opencode-ai/client";
import type { Logger } from "./types.js";
import {
  mapInterruptReasonToFinishReason,
  mapOpencodeFinishReason,
  mapStructuredErrorToFinishReason,
  type OpencodeInterruptReason,
  type OpencodeV2Finish,
} from "./map-opencode-finish-reason.js";
import {
  planFilePartConversion,
  safeStringifyToolInput,
} from "./opencode-part-utils.js";

/**
 * Any input the reducer accepts: a live SSE event or a `session.log` replay
 * item.
 */
export type OpencodeReducerInput = V2Event | SessionLogItem;

/**
 * A `V2Event`-shaped event after normalization. Includes the durable-only
 * `session.usage.recorded` member, which is absent from the live union.
 */
export type NormalizedV2Event = Exclude<
  OpencodeReducerInput,
  { type: "log.synced" }
>;

/**
 * Result of the input-normalization layer: either the `log.synced` sentinel
 * that terminates a `session.log` catch-up read, or an event to reduce.
 */
export type NormalizedV2Input =
  | { kind: "log-synced"; aggregateID: string; seq?: number }
  | { kind: "event"; event: NormalizedV2Event };

/**
 * Normalize a reducer input from either source union. `log.synced` is a
 * sentinel (no session data, no envelope) that must never reach the event
 * switch.
 */
export function normalizeReducerInput(
  input: OpencodeReducerInput,
): NormalizedV2Input {
  if (input.type === "log.synced") {
    return {
      kind: "log-synced",
      aggregateID: input.aggregateID,
      ...(input.seq !== undefined ? { seq: input.seq } : {}),
    };
  }
  return { kind: "event", event: input };
}

/**
 * Extract the session ID from an event, discriminated per event type.
 * The session ID does not live at one uniform path: `form.created` nests it
 * at `data.form.sessionID`; every other session-scoped event carries it at
 * `data.sessionID`. Non-session events (catalog, credential, TUI, PTY,
 * `server.connected`, ...) return undefined.
 */
export function extractV2EventSessionId(
  event: NormalizedV2Event,
): string | undefined {
  if (event.type === "form.created") {
    return event.data.form.sessionID;
  }
  const data = (event as { data?: Record<string, unknown> }).data;
  const sessionID = data?.["sessionID"];
  return typeof sessionID === "string" ? sessionID : undefined;
}

/** The two delta-native content kinds, which share the ordinal keyspace. */
type V2ContentKind = "text" | "reasoning";

/**
 * State for one text/reasoning block, keyed by
 * `${assistantMessageID}:${kind}:${ordinal}`. The kind is part of the
 * identity because text and reasoning ordinals share one keyspace.
 */
interface V2BlockState {
  kind: V2ContentKind;
  started: boolean;
  ended: boolean;
  /** Content emitted so far, for `ended`-event reconciliation. */
  buffered: string;
}

/**
 * Placeholder tool name for a tool whose `session.tool.input.started` (the
 * only event carrying `name`) was never observed — e.g. a subscriber that
 * attached mid-stream.
 */
export const UNKNOWN_TOOL_NAME = "unknown" as const;

/**
 * Tool name for the synthetic call registered for a source-less
 * `permission.asked`. The AI SDK rejects a `tool-approval-request` whose
 * `toolCallId` has no prior `tool-call` (`ToolCallNotFoundForApprovalError`
 * on every consumption path), so a permission with no tool correlation gets
 * a synthetic dynamic call — keyed by the request id, carrying the
 * permission payload as its input — registered before the approval.
 */
export const PERMISSION_TOOL_NAME = "permission" as const;

/**
 * Lifecycle state for one tool call, keyed by the v2 tool `id`.
 * `name` is captured at `input.started`; later events do not repeat it.
 */
interface V2ToolState {
  toolId: string;
  toolName: string;
  inputStarted: boolean;
  inputEnded: boolean;
  callEmitted: boolean;
  resultEmitted: boolean;
  /** `executed` flag from `tool.called`/`success`/`failed` (→ providerExecuted). */
  executed: boolean | undefined;
  /** Input text emitted so far (deltas / ended text / called JSON). */
  inputBuffer: string;
}

/**
 * A buffered tool-approval-request, held until its tool call has been
 * registered in the stream (issue #22 semantics). Correlates a v2
 * `permission.asked` event to the tool call it gates via `data.source.id`.
 */
export interface PendingV2Approval {
  approvalId: string;
  toolCallId: string;
  sessionId: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
}

/** Recorded finish of the most recent step (ended or failed). */
interface V2StepFinish {
  finish: OpencodeV2Finish;
  rawFinish?: string;
}

/** Terminal execution outcome recorded from `session.execution.*`. */
interface V2Terminal {
  outcome: "succeeded" | "failed" | "interrupted";
  reason?: OpencodeInterruptReason;
  error?: SessionStructuredError;
}

/**
 * Accumulated usage across the turn's steps. Per-step `tokens`/`cost` on
 * `session.step.ended`/`failed` are increments, not running totals
 * (spike-confirmed), so they sum.
 */
export interface V2StreamUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cachedWriteTokens: number;
  totalCost: number;
}

/**
 * Reducer state for one generation's event stream.
 */
export interface V2StreamState {
  /** The session this reducer follows; events for other sessions are ignored. */
  sessionId: string;
  /** Emit `{type: "raw", rawValue: event}` before semantic parts. */
  includeRawChunks: boolean;
  /**
   * Handler slot for `form.created` events. Forms are interaction requests,
   * not model content — the reducer never fabricates stream parts for them;
   * it hands the form to this callback (deduplicated by form ID) for the
   * orchestration layer to answer/cancel.
   */
  onForm?: (form: FormCreated["data"]["form"]) => void;
  logger?: Logger | false;

  blocks: Map<string, V2BlockState>;
  tools: Map<string, V2ToolState>;
  /**
   * Durable-envelope dedup (`${aggregateID}:${seq}`): duplicate durable
   * events — SSE redelivery, or log replay overlapping live consumption on
   * the same state — reduce to nothing.
   */
  processedDurables: Set<string>;
  /** Approval request IDs already emitted (or externally replied). */
  emittedApprovals: Set<string>;
  /** Approvals buffered until their tool call is registered, keyed by tool id. */
  pendingApprovals: Map<string, PendingV2Approval>;
  /** Form IDs already handed to `onForm`. */
  handledForms: Set<string>;

  usage: V2StreamUsage;
  stepCount: number;
  /** Assistant message of the most recent step (one message per step). */
  currentAssistantMessageId: string | undefined;
  lastStepFinish: V2StepFinish | undefined;
  /** Structured error from the most recent `session.step.failed`. */
  stepError: SessionStructuredError | undefined;
  /** Most recent `session.retry.scheduled` record (→ metadata `retry`). */
  retry: SessionMessageAssistantRetry | undefined;
  terminal: V2Terminal | undefined;
  finishEmitted: boolean;
  /** Set when the `log.synced` sentinel has been observed. */
  logSynced: boolean;
}

/**
 * Create the reducer state for one generation.
 */
export function createV2StreamState(options: {
  sessionId: string;
  includeRawChunks?: boolean;
  onForm?: (form: FormCreated["data"]["form"]) => void;
  logger?: Logger | false;
}): V2StreamState {
  return {
    sessionId: options.sessionId,
    includeRawChunks: options.includeRawChunks ?? false,
    ...(options.onForm ? { onForm: options.onForm } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    blocks: new Map(),
    tools: new Map(),
    processedDurables: new Set(),
    emittedApprovals: new Set(),
    pendingApprovals: new Map(),
    handledForms: new Set(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cachedWriteTokens: 0,
      totalCost: 0,
    },
    stepCount: 0,
    currentAssistantMessageId: undefined,
    lastStepFinish: undefined,
    stepError: undefined,
    retry: undefined,
    terminal: undefined,
    finishEmitted: false,
    logSynced: false,
  };
}

/**
 * Stable AI SDK block id: kind is part of the identity because text and
 * reasoning share the `{assistantMessageID, ordinal}` keyspace.
 */
function blockId(
  assistantMessageID: string,
  kind: V2ContentKind,
  ordinal: number,
): string {
  return `${assistantMessageID}:${kind}:${ordinal}`;
}

function warn(state: V2StreamState, message: string): void {
  if (state.logger) {
    state.logger.warn(message);
  }
}

/**
 * Convert one reducer input to AI SDK stream parts, updating state.
 *
 * Events for other sessions (or with no session, e.g. `server.connected`)
 * reduce to nothing. Duplicate durable events are idempotent. With
 * `includeRawChunks`, a `raw` part precedes this session's semantic parts.
 */
export function convertV2EventToStreamParts(
  input: OpencodeReducerInput,
  state: V2StreamState,
): LanguageModelV4StreamPart[] {
  const normalized = normalizeReducerInput(input);

  if (normalized.kind === "log-synced") {
    // The sentinel is session-scoped like every other input: its
    // aggregateID is the session's log aggregate, so a foreign sentinel
    // must not mark THIS reducer's catch-up as complete.
    if (normalized.aggregateID !== state.sessionId) {
      return [];
    }
    state.logSynced = true;
    return state.includeRawChunks ? [{ type: "raw", rawValue: input }] : [];
  }

  const event = normalized.event;
  if (extractV2EventSessionId(event) !== state.sessionId) {
    return [];
  }

  const durable = (event as { durable?: { aggregateID: string; seq: number } })
    .durable;
  if (durable) {
    const key = `${durable.aggregateID}:${durable.seq}`;
    if (state.processedDurables.has(key)) {
      return [];
    }
    state.processedDurables.add(key);
  }

  const parts: LanguageModelV4StreamPart[] = [];
  if (state.includeRawChunks) {
    parts.push({ type: "raw", rawValue: event });
  }

  switch (event.type) {
    case "session.text.started":
      handleBlockStarted(
        state,
        parts,
        "text",
        event.data.assistantMessageID,
        event.data.ordinal,
      );
      break;
    case "session.text.delta":
      handleBlockDelta(
        state,
        parts,
        "text",
        event.data.assistantMessageID,
        event.data.ordinal,
        event.data.delta,
      );
      break;
    case "session.text.ended":
      handleBlockEnded(
        state,
        parts,
        "text",
        event.data.assistantMessageID,
        event.data.ordinal,
        event.data.text,
      );
      break;

    case "session.reasoning.started":
      handleBlockStarted(
        state,
        parts,
        "reasoning",
        event.data.assistantMessageID,
        event.data.ordinal,
      );
      break;
    case "session.reasoning.delta":
      handleBlockDelta(
        state,
        parts,
        "reasoning",
        event.data.assistantMessageID,
        event.data.ordinal,
        event.data.delta,
      );
      break;
    case "session.reasoning.ended":
      handleBlockEnded(
        state,
        parts,
        "reasoning",
        event.data.assistantMessageID,
        event.data.ordinal,
        event.data.text,
      );
      break;

    case "session.tool.input.started":
      handleToolInputStarted(state, parts, event.data.id, event.data.name);
      break;
    case "session.tool.input.delta":
      handleToolInputDelta(state, parts, event.data.id, event.data.delta);
      break;
    case "session.tool.input.ended":
      handleToolInputEnded(state, parts, event.data.id, event.data.text);
      break;
    case "session.tool.called":
      handleToolCalled(
        state,
        parts,
        event.data.id,
        event.data.input,
        event.data.executed,
      );
      break;
    case "session.tool.success":
      handleToolResult(state, parts, event.data, false);
      break;
    case "session.tool.failed":
      handleToolResult(state, parts, event.data, true);
      break;
    case "session.tool.progress":
      // Transient execution telemetry; no AI SDK part (raw covers it).
      break;

    case "session.step.started":
      state.stepCount += 1;
      state.currentAssistantMessageId = event.data.assistantMessageID;
      // A new step supersedes the previous step's finish and error for
      // terminal resolution: without this, a backstopped turn after an
      // intermediate tool step would finish as that step's "tool-calls",
      // and a successful retry would still attach the failed attempt's
      // error to the finish metadata.
      state.lastStepFinish = undefined;
      state.stepError = undefined;
      break;
    case "session.step.ended":
      accumulateUsage(state, event.data.tokens, event.data.cost);
      state.lastStepFinish = {
        finish: event.data.finish,
        ...(event.data.rawFinish !== undefined
          ? { rawFinish: event.data.rawFinish }
          : {}),
      };
      break;
    case "session.step.failed":
      // Not error-only: a failed step can still carry finish
      // ("content-filter"), cost, and tokens — losing them loses failed-step
      // accounting and the content-filter reason.
      if (event.data.tokens) {
        accumulateUsage(state, event.data.tokens, event.data.cost ?? 0);
      } else if (event.data.cost !== undefined) {
        state.usage.totalCost += event.data.cost;
      }
      if (event.data.finish !== undefined) {
        state.lastStepFinish = {
          finish: event.data.finish,
          ...(event.data.rawFinish !== undefined
            ? { rawFinish: event.data.rawFinish }
            : {}),
        };
      }
      state.stepError = event.data.error;
      break;

    case "session.retry.scheduled":
      // Durable retry record: the failed attempt's error travels here, so a
      // turn that fails a step, retries, and succeeds surfaces the retry in
      // metadata instead of a stale stepError on the successful finish.
      state.retry = {
        attempt: event.data.attempt,
        at: event.data.at,
        error: event.data.error,
      };
      break;

    case "session.execution.succeeded":
      state.terminal = { outcome: "succeeded" };
      emitFinish(state, parts, resolveSucceededFinishReason(state));
      break;
    case "session.execution.failed":
      state.terminal = { outcome: "failed", error: event.data.error };
      emitFinish(state, parts, resolveFailedFinishReason(state));
      break;
    case "session.execution.interrupted":
      state.terminal = { outcome: "interrupted", reason: event.data.reason };
      emitFinish(
        state,
        parts,
        mapInterruptReasonToFinishReason(event.data.reason),
      );
      break;
    case "session.execution.started":
      break;

    case "permission.asked":
      handlePermissionAsked(state, parts, event.data);
      break;
    case "permission.replied":
      handlePermissionReplied(state, event.data.requestID);
      break;

    case "form.created":
      handleFormCreated(state, event.data.form);
      break;

    case "session.idle":
      // Backstop signal only — orchestration calls finalizeV2Stream if the
      // terminal execution event never arrives. Never finish here.
      break;

    case "session.usage.updated":
      // Live-only session totals; per-step events are the authoritative
      // turn accounting (step tokens are increments and sum exactly).
      break;
    case "session.usage.recorded":
      // Durable-only, source "title"/"compaction" — side-generation usage,
      // not part of this turn's accounting.
      break;

    default:
      // Everything else (inbox, retry, compaction, shell, status, form
      // replies, non-session noise) carries no model content.
      if (state.logger && state.logger.debug) {
        state.logger.debug(`Ignoring v2 event type: ${event.type}`);
      }
  }

  return parts;
}

function getBlock(
  state: V2StreamState,
  kind: V2ContentKind,
  assistantMessageID: string,
  ordinal: number,
): { id: string; block: V2BlockState } {
  const id = blockId(assistantMessageID, kind, ordinal);
  let block = state.blocks.get(id);
  if (!block) {
    block = { kind, started: false, ended: false, buffered: "" };
    state.blocks.set(id, block);
  }
  return { id, block };
}

function pushBlockStart(
  parts: LanguageModelV4StreamPart[],
  kind: V2ContentKind,
  id: string,
): void {
  parts.push({ type: kind === "text" ? "text-start" : "reasoning-start", id });
}

function pushBlockDelta(
  parts: LanguageModelV4StreamPart[],
  kind: V2ContentKind,
  id: string,
  delta: string,
): void {
  parts.push({
    type: kind === "text" ? "text-delta" : "reasoning-delta",
    id,
    delta,
  });
}

function pushBlockEnd(
  parts: LanguageModelV4StreamPart[],
  kind: V2ContentKind,
  id: string,
): void {
  parts.push({ type: kind === "text" ? "text-end" : "reasoning-end", id });
}

function handleBlockStarted(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  kind: V2ContentKind,
  assistantMessageID: string,
  ordinal: number,
): void {
  const { id, block } = getBlock(state, kind, assistantMessageID, ordinal);
  if (block.started) {
    return;
  }
  block.started = true;
  pushBlockStart(parts, kind, id);
}

function handleBlockDelta(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  kind: V2ContentKind,
  assistantMessageID: string,
  ordinal: number,
  delta: string,
): void {
  const { id, block } = getBlock(state, kind, assistantMessageID, ordinal);
  if (block.ended) {
    // Late duplicate after the block closed — dropping it is the only move
    // that keeps emitted content consistent with the reconciled final text.
    warn(state, `Dropping ${kind} delta for closed block ${id}`);
    return;
  }
  if (!block.started) {
    // Tolerate a missed `started` (mid-stream attach): deltas are transient
    // and cannot be replayed from the durable log, so synthesizing the start
    // preserves content where a strict resync would drop it.
    block.started = true;
    pushBlockStart(parts, kind, id);
  }
  block.buffered += delta;
  pushBlockDelta(parts, kind, id, delta);
}

function handleBlockEnded(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  kind: V2ContentKind,
  assistantMessageID: string,
  ordinal: number,
  finalText: string,
): void {
  const { id, block } = getBlock(state, kind, assistantMessageID, ordinal);
  if (block.ended) {
    return;
  }
  if (!block.started) {
    // Durable-log replay: started/ended survive but deltas do not, so the
    // full content arrives here.
    block.started = true;
    pushBlockStart(parts, kind, id);
  }
  if (finalText !== block.buffered) {
    if (finalText.startsWith(block.buffered)) {
      // Missed deltas (SSE drop): emit the tail so content stays complete.
      const tail = finalText.slice(block.buffered.length);
      if (tail) {
        pushBlockDelta(parts, kind, id, tail);
      }
      block.buffered = finalText;
    } else {
      // Streamed content diverged from the final text in a non-prefix way.
      // Keep what was emitted (rewriting mid-stream is worse); final-message
      // reconciliation at the orchestration layer is the recovery path.
      warn(
        state,
        `Final ${kind} for block ${id} diverges from streamed deltas; keeping streamed content`,
      );
    }
  }
  block.ended = true;
  pushBlockEnd(parts, kind, id);
}

function getTool(
  state: V2StreamState,
  toolId: string,
  name?: string,
): V2ToolState {
  let tool = state.tools.get(toolId);
  if (!tool) {
    tool = {
      toolId,
      toolName: name ?? UNKNOWN_TOOL_NAME,
      inputStarted: false,
      inputEnded: false,
      callEmitted: false,
      resultEmitted: false,
      executed: undefined,
      inputBuffer: "",
    };
    state.tools.set(toolId, tool);
  } else if (name !== undefined && tool.toolName === UNKNOWN_TOOL_NAME) {
    tool.toolName = name;
  }
  return tool;
}

function handleToolInputStarted(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  toolId: string,
  name: string,
): void {
  const tool = getTool(state, toolId, name);
  if (tool.inputStarted) {
    return;
  }
  tool.inputStarted = true;
  parts.push({
    type: "tool-input-start",
    id: toolId,
    toolName: tool.toolName,
    // `executed` is only known from tool.called/success/failed; OpenCode
    // executes its tools server-side, so provider execution is the default.
    providerExecuted: true,
    dynamic: true,
  });
}

function handleToolInputDelta(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  toolId: string,
  delta: string,
): void {
  const tool = getTool(state, toolId);
  if (tool.inputEnded || tool.callEmitted) {
    // Once the input envelope closed (possibly early, when a terminal
    // result or finalize registered the call), the exposed input is
    // immutable.
    warn(state, `Dropping tool input delta for closed input ${toolId}`);
    return;
  }
  if (!tool.inputStarted) {
    // Missed `input.started`: the name only travels on that event, so it is
    // genuinely lost — synthesize the start with a placeholder name.
    warn(
      state,
      `Tool input delta for ${toolId} before input.started; tool name unknown`,
    );
    tool.inputStarted = true;
    parts.push({
      type: "tool-input-start",
      id: toolId,
      toolName: tool.toolName,
      providerExecuted: true,
      dynamic: true,
    });
  }
  tool.inputBuffer += delta;
  parts.push({ type: "tool-input-delta", id: toolId, delta });
}

function handleToolInputEnded(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  toolId: string,
  finalText: string,
): void {
  const tool = getTool(state, toolId);
  if (tool.inputEnded) {
    return;
  }
  if (!tool.inputStarted) {
    tool.inputStarted = true;
    parts.push({
      type: "tool-input-start",
      id: toolId,
      toolName: tool.toolName,
      providerExecuted: true,
      dynamic: true,
    });
  }
  if (finalText !== tool.inputBuffer) {
    if (finalText.startsWith(tool.inputBuffer)) {
      const tail = finalText.slice(tool.inputBuffer.length);
      if (tail) {
        parts.push({ type: "tool-input-delta", id: toolId, delta: tail });
      }
      tool.inputBuffer = finalText;
    } else {
      warn(
        state,
        `Final tool input for ${toolId} diverges from streamed deltas; keeping streamed input`,
      );
    }
  }
  tool.inputEnded = true;
  parts.push({ type: "tool-input-end", id: toolId });

  // The input just became complete. A buffered approval for this tool
  // (issue #22: `permission.asked` raced ahead of the input) can now be
  // satisfied — the server will not emit `tool.called` while it is blocked
  // waiting for the reply, so this is the flush point, not tool completion.
  if (state.pendingApprovals.has(toolId)) {
    registerToolCall(parts, tool, tool.inputBuffer || "{}");
    flushPendingApproval(state, parts, toolId);
  }
}

/**
 * Register a tool call (`tool-input-end` if still open, then `tool-call`),
 * bringing it to tool-input-available. Idempotent. Used by the `called`
 * handler, by terminal results arriving without a `called`, and to register
 * a call early when an approval is pending for it (issue #22).
 */
function registerToolCall(
  parts: LanguageModelV4StreamPart[],
  tool: V2ToolState,
  inputStr: string,
): void {
  if (tool.callEmitted) {
    return;
  }
  if (!tool.inputStarted) {
    tool.inputStarted = true;
    parts.push({
      type: "tool-input-start",
      id: tool.toolId,
      toolName: tool.toolName,
      providerExecuted: tool.executed ?? true,
      dynamic: true,
    });
  }
  if (!tool.inputEnded) {
    if (tool.inputBuffer === "" && inputStr) {
      parts.push({
        type: "tool-input-delta",
        id: tool.toolId,
        delta: inputStr,
      });
      tool.inputBuffer = inputStr;
    }
    tool.inputEnded = true;
    parts.push({ type: "tool-input-end", id: tool.toolId });
  }
  tool.callEmitted = true;
  parts.push({
    type: "tool-call",
    toolCallId: tool.toolId,
    toolName: tool.toolName,
    input: inputStr,
    providerExecuted: tool.executed ?? true,
    dynamic: true,
  });
}

function handleToolCalled(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  toolId: string,
  input: Record<string, unknown>,
  executed: boolean,
): void {
  const tool = getTool(state, toolId);
  tool.executed = executed;
  if (tool.callEmitted) {
    return;
  }
  const inputStr = safeStringifyToolInput(input, (message) =>
    warn(state, `Failed to serialize tool input for ${toolId}: ${message}`),
  );
  registerToolCall(parts, tool, inputStr);
  flushPendingApproval(state, parts, toolId);
}

function handleToolResult(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  data: SessionToolSuccess["data"] | SessionToolFailed["data"],
  isError: boolean,
): void {
  const tool = getTool(state, data.id);
  tool.executed = data.executed;
  registerToolCall(parts, tool, tool.inputBuffer || "{}");

  if (isError) {
    // The tool failed (e.g. a rejected permission): a buffered approval for
    // it must never dangle — the terminal error result is the final word.
    dropPendingApproval(state, data.id);
  } else {
    // Flush any approval still buffered before the terminal result so it
    // never trails tool-output-available (issue #22).
    flushPendingApproval(state, parts, data.id);
  }

  if (tool.resultEmitted) {
    return;
  }
  tool.resultEmitted = true;

  const content = data.content;
  const error = isError ? (data as SessionToolFailed["data"]).error : undefined;

  // The ToolContent array is already structured JSON; pass it through as the
  // result value (with the raw array mirrored into provider metadata). No v1
  // `title` enrichment — v2 has no typed source for it.
  const result: JSONValue = isError
    ? {
        error: error as unknown as JSONValue,
        ...(content ? { content: content as unknown as JSONValue } : {}),
      }
    : (content as unknown as JSONValue);

  parts.push({
    type: "tool-result",
    toolCallId: data.id,
    toolName: tool.toolName,
    result: result as NonNullable<JSONValue>,
    isError,
    dynamic: true,
    providerMetadata: {
      opencode: {
        ...(content ? { content: content as unknown as JSONValue } : {}),
        ...(error ? { error: error as unknown as JSONValue } : {}),
        ...(data.metadata
          ? { metadata: data.metadata as unknown as JSONValue }
          : {}),
      },
    },
  });

  if (isError) {
    warn(state, `Tool ${tool.toolName} failed: ${error?.message}`);
  }

  // Emit file entries from the content array as separate parts (`data:` URIs
  // become file parts per the stage-1 isDataUri policy; URLs/paths become
  // source parts).
  if (content) {
    content.forEach((item, index) => {
      if (item.type !== "file") {
        return;
      }
      parts.push(
        ...convertToolFileContent(
          `${data.id}-file-${index}`,
          item.uri,
          item.mime,
          item.name ?? undefined,
        ),
      );
    });
  }
}

function convertToolFileContent(
  id: string,
  uri: string,
  mime: string,
  name?: string,
): LanguageModelV4StreamPart[] {
  const { plan } = planFilePartConversion({
    id,
    mime,
    ...(name ? { filename: name } : {}),
    url: uri,
  });
  if (!plan) {
    return [];
  }

  if (plan.primary.type === "file") {
    return [
      {
        type: "file",
        mediaType: plan.primary.mediaType,
        data: { type: "data", data: plan.primary.data },
      },
    ];
  }
  if (plan.primary.type === "source-url") {
    return [
      {
        type: "source",
        sourceType: "url",
        id: plan.primary.id,
        url: plan.primary.url,
        ...(plan.primary.title ? { title: plan.primary.title } : {}),
      },
    ];
  }
  return [
    {
      type: "source",
      sourceType: "document",
      id: plan.primary.id,
      mediaType: plan.primary.mediaType,
      title: plan.primary.title,
      ...(plan.primary.filename ? { filename: plan.primary.filename } : {}),
    },
  ];
}

function handlePermissionAsked(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  data: PermissionAsked["data"],
): void {
  if (state.emittedApprovals.has(data.id)) {
    return;
  }

  const sourceToolId = data.source?.id;
  const approval: PendingV2Approval = {
    approvalId: data.id,
    toolCallId: sourceToolId ?? data.id,
    sessionId: data.sessionID,
    action: data.action,
    resources: data.resources,
    ...(data.save ? { save: data.save } : {}),
    ...(data.message !== undefined ? { message: data.message } : {}),
  };

  if (!sourceToolId) {
    // No tool correlation available — the approval keys on the request id,
    // but the AI SDK requires the referenced tool call to exist, so a
    // synthetic permission call carrying the request payload is registered
    // first (see PERMISSION_TOOL_NAME).
    const syntheticTool = getTool(state, data.id, PERMISSION_TOOL_NAME);
    registerToolCall(
      parts,
      syntheticTool,
      JSON.stringify({
        action: data.action,
        resources: data.resources,
        ...(data.save ? { save: data.save } : {}),
        ...(data.message !== undefined ? { message: data.message } : {}),
      }),
    );
    emitApproval(state, parts, approval);
    return;
  }

  const tool = state.tools.get(sourceToolId);
  if (tool?.callEmitted) {
    // The tool call is already registered — safe to emit now.
    emitApproval(state, parts, approval);
  } else if (tool?.inputEnded) {
    // Input is complete but the call has not been finalized. Register it
    // early from the final input so the approval lands after
    // tool-input-available (issue #22).
    registerToolCall(parts, tool, tool.inputBuffer || "{}");
    emitApproval(state, parts, approval);
  } else {
    // The tool call is not ready: no input yet, the tool is entirely
    // unseen, or input is still streaming (registering now would publish a
    // partial JSON fragment as the call's input). Buffer until the input
    // completes or the call is registered.
    state.pendingApprovals.set(sourceToolId, approval);
  }
}

function emitApproval(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  approval: PendingV2Approval,
): void {
  if (state.emittedApprovals.has(approval.approvalId)) {
    return;
  }
  state.emittedApprovals.add(approval.approvalId);
  parts.push({
    type: "tool-approval-request",
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    providerMetadata: {
      opencode: {
        sessionId: approval.sessionId,
        action: approval.action,
        resources: approval.resources,
        ...(approval.save ? { save: approval.save } : {}),
        ...(approval.message !== undefined
          ? { message: approval.message }
          : {}),
      },
    },
  });
}

function flushPendingApproval(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  toolId: string,
): void {
  const pending = state.pendingApprovals.get(toolId);
  if (!pending) {
    return;
  }
  state.pendingApprovals.delete(toolId);
  emitApproval(state, parts, pending);
}

function dropPendingApproval(state: V2StreamState, toolId: string): void {
  state.pendingApprovals.delete(toolId);
}

/**
 * The input string for a tool call registered by the finalize backstop: the
 * buffer if it is complete JSON, else "{}" — a half-streamed fragment must
 * never become a published `tool-call.input`.
 */
function parseableToolInput(buffer: string): string {
  if (!buffer) {
    return "{}";
  }
  try {
    JSON.parse(buffer);
    return buffer;
  } catch {
    return "{}";
  }
}

function handlePermissionReplied(
  state: V2StreamState,
  requestID: string,
): void {
  // Answered externally (another client, saved rule) before we surfaced it:
  // never emit a stale approval request for it.
  state.emittedApprovals.add(requestID);
  for (const [toolId, pending] of state.pendingApprovals) {
    if (pending.approvalId === requestID) {
      state.pendingApprovals.delete(toolId);
    }
  }
}

function handleFormCreated(
  state: V2StreamState,
  form: FormCreated["data"]["form"],
): void {
  if (state.handledForms.has(form.id)) {
    return;
  }
  state.handledForms.add(form.id);
  state.onForm?.(form);
}

function accumulateUsage(
  state: V2StreamState,
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  },
  cost: number,
): void {
  state.usage.inputTokens += tokens.input;
  state.usage.outputTokens += tokens.output;
  state.usage.reasoningTokens += tokens.reasoning;
  state.usage.cachedInputTokens += tokens.cache.read;
  state.usage.cachedWriteTokens += tokens.cache.write;
  state.usage.totalCost += cost;
}

function resolveSucceededFinishReason(
  state: V2StreamState,
): LanguageModelV4FinishReason {
  if (state.lastStepFinish) {
    return mapOpencodeFinishReason(
      state.lastStepFinish.finish,
      state.lastStepFinish.rawFinish,
    );
  }
  return { unified: "stop", raw: undefined };
}

function resolveFailedFinishReason(
  state: V2StreamState,
): LanguageModelV4FinishReason {
  // Prefer the failing step's own finish ("content-filter") when present —
  // the execution-failed event itself carries only the structured error.
  if (state.lastStepFinish?.finish === "content-filter") {
    return mapOpencodeFinishReason(
      state.lastStepFinish.finish,
      state.lastStepFinish.rawFinish,
    );
  }
  const error = state.terminal?.error ?? state.stepError;
  if (error) {
    return mapStructuredErrorToFinishReason(error);
  }
  return { unified: "error", raw: undefined };
}

function buildUsage(state: V2StreamState): LanguageModelV4Usage {
  const { usage } = state;
  return {
    inputTokens: {
      total:
        usage.inputTokens + usage.cachedInputTokens + usage.cachedWriteTokens,
      noCache: usage.inputTokens,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: usage.cachedWriteTokens,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: undefined,
      reasoning: usage.reasoningTokens,
    },
    raw: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      reasoning_tokens: usage.reasoningTokens,
      cache_read_input_tokens: usage.cachedInputTokens,
      cache_write_input_tokens: usage.cachedWriteTokens,
      total_cost: usage.totalCost,
    },
  };
}

/**
 * Close all open content blocks and tool inputs, then emit the `finish`
 * part. Idempotent via `state.finishEmitted`.
 */
function emitFinish(
  state: V2StreamState,
  parts: LanguageModelV4StreamPart[],
  finishReason: LanguageModelV4FinishReason,
): void {
  if (state.finishEmitted) {
    return;
  }
  state.finishEmitted = true;

  // Last-resort approval flush: a blocked turn being finalized must surface
  // its approval or the two-phase round-trip deadlocks (the user is never
  // asked, the session stays blocked). If the input never completed, fall
  // back to "{}" rather than publishing a partial JSON fragment.
  for (const toolId of [...state.pendingApprovals.keys()]) {
    const tool = getTool(state, toolId);
    registerToolCall(parts, tool, parseableToolInput(tool.inputBuffer));
    flushPendingApproval(state, parts, toolId);
  }

  for (const [id, block] of state.blocks) {
    if (block.started && !block.ended) {
      block.ended = true;
      pushBlockEnd(parts, block.kind, id);
    }
  }
  for (const tool of state.tools.values()) {
    if (tool.inputStarted && !tool.inputEnded) {
      // An interrupted turn can leave a half-streamed tool input with no
      // valid call to emit; close the envelope so consumers are not left
      // with a dangling input-streaming part.
      tool.inputEnded = true;
      parts.push({ type: "tool-input-end", id: tool.toolId });
    }
  }

  const opencode: Record<string, JSONValue> = {
    sessionId: state.sessionId,
    ...(state.currentAssistantMessageId
      ? { messageId: state.currentAssistantMessageId }
      : {}),
    ...(state.terminal ? { outcome: state.terminal.outcome } : {}),
    ...(state.terminal?.reason
      ? { interruptReason: state.terminal.reason }
      : {}),
    cost: state.usage.totalCost,
    tokens: {
      input: state.usage.inputTokens,
      output: state.usage.outputTokens,
      reasoning: state.usage.reasoningTokens,
      cache: {
        read: state.usage.cachedInputTokens,
        write: state.usage.cachedWriteTokens,
      },
    },
    ...(state.lastStepFinish ? { finish: state.lastStepFinish.finish } : {}),
    ...(state.lastStepFinish?.rawFinish !== undefined
      ? { rawFinish: state.lastStepFinish.rawFinish }
      : {}),
    ...(state.retry ? { retry: state.retry as unknown as JSONValue } : {}),
  };
  const error = state.terminal?.error ?? state.stepError;
  if (error) {
    opencode["error"] = error as unknown as JSONValue;
  }

  parts.push({
    type: "finish",
    finishReason,
    usage: buildUsage(state),
    providerMetadata: { opencode },
  });
}

/**
 * Force-close the stream when no terminal execution event arrived — the
 * `session.idle` backstop, an approval-blocked turn being returned to the
 * caller, or a watchdog timeout. Emits the same closure as a terminal event:
 * open blocks/tool inputs are ended and a `finish` part is produced with
 * the given reason (default: the last step's finish, else `other`).
 * No-op (returns []) if a terminal event already finished the stream.
 */
export function finalizeV2Stream(
  state: V2StreamState,
  finishReason?: LanguageModelV4FinishReason,
): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [];
  emitFinish(state, parts, finishReason ?? resolveBackstopFinishReason(state));
  return parts;
}

/**
 * Default finish reason for a backstopped (non-terminal) turn. A retained
 * `"tool-calls"` step finish means further steps were coming — it is never
 * a valid terminal reason here (the contract: never finish on an
 * intermediate step's `"tool-calls"`), so it degrades to `other` with the
 * native value preserved as raw.
 */
function resolveBackstopFinishReason(
  state: V2StreamState,
): LanguageModelV4FinishReason {
  const last = state.lastStepFinish;
  if (!last) {
    return { unified: "other", raw: undefined };
  }
  if (last.finish === "tool-calls") {
    return { unified: "other", raw: last.rawFinish ?? last.finish };
  }
  return mapOpencodeFinishReason(last.finish, last.rawFinish);
}

/**
 * Create the stream-start part carrying call warnings.
 */
export function createStreamStartPart(
  warnings: string[],
): LanguageModelV4StreamPart {
  const callWarnings: SharedV4Warning[] = warnings.map((warning) => ({
    type: "other" as const,
    message: warning,
  }));
  return { type: "stream-start", warnings: callWarnings };
}
