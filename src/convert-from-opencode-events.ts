import type {
  JSONValue,
  LanguageModelV3StreamPart,
  LanguageModelV3FinishReason,
  SharedV3Warning,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Logger, ToolStreamState, StreamingUsage } from "./types.js";

/**
 * OpenCode event types (from SDK types.gen.ts).
 */
export interface EventMessagePartUpdated {
  type: "message.part.updated";
  properties: {
    part: Part;
    delta?: string;
  };
}

export interface EventMessageUpdated {
  type: "message.updated";
  properties: {
    info: Message;
  };
}

export interface EventSessionStatus {
  type: "session.status";
  properties: {
    sessionID: string;
    status:
      | { type: "idle" }
      | { type: "busy" }
      | { type: "retry"; attempt: number; message: string; next: number };
  };
}

export interface EventSessionIdle {
  type: "session.idle";
  properties: {
    sessionID: string;
  };
}

export type OpencodeEvent =
  | EventMessagePartUpdated
  | EventMessageUpdated
  | EventSessionStatus
  | EventSessionIdle
  | { type: string; properties: unknown };

/**
 * Part types from OpenCode SDK.
 */
export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface ReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
}

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  time: { start: number };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  time: { start: number; end: number };
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  time: { start: number; end: number };
}

export type ToolState =
  | ToolStatePending
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError;

export interface StepFinishPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

export interface FilePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepFinishPart
  | FilePart
  | {
      type: string;
      sessionID: string;
      messageID: string;
      [key: string]: unknown;
    };

export interface Message {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  error?: { name: string; data?: unknown };
  finish?: string;
}

/**
 * State for tracking streaming progress.
 */
export interface StreamState {
  textPartId: string | undefined;
  textStarted: boolean;
  reasoningPartId: string | undefined;
  reasoningStarted: boolean;
  toolStates: Map<string, ToolStreamState>;
  usage: StreamingUsage;
  lastTextContent: string;
  lastReasoningContent: string;
  /** Track message roles to filter user vs assistant parts */
  messageRoles: Map<string, "user" | "assistant">;
}

/**
 * Create initial stream state.
 */
export function createStreamState(): StreamState {
  return {
    textPartId: undefined,
    textStarted: false,
    reasoningPartId: undefined,
    reasoningStarted: false,
    toolStates: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cachedWriteTokens: 0,
      totalCost: 0,
    },
    lastTextContent: "",
    lastReasoningContent: "",
    messageRoles: new Map(),
  };
}

/**
 * Check if an event is for a specific session.
 */
export function isEventForSession(
  event: OpencodeEvent,
  sessionId: string,
): boolean {
  if (
    "properties" in event &&
    typeof event.properties === "object" &&
    event.properties !== null
  ) {
    const props = event.properties as Record<string, unknown>;

    // Check part's sessionID
    if (
      "part" in props &&
      typeof props.part === "object" &&
      props.part !== null
    ) {
      const part = props.part as Record<string, unknown>;
      return part.sessionID === sessionId;
    }

    // Check message's sessionID
    if (
      "info" in props &&
      typeof props.info === "object" &&
      props.info !== null
    ) {
      const info = props.info as Record<string, unknown>;
      return info.sessionID === sessionId;
    }

    // Check direct sessionID
    if ("sessionID" in props) {
      return props.sessionID === sessionId;
    }
  }

  return false;
}

/**
 * Check if an event indicates the session is complete.
 */
export function isSessionComplete(
  event: OpencodeEvent,
  sessionId: string,
): boolean {
  if (event.type === "session.status") {
    const statusEvent = event as EventSessionStatus;
    return (
      statusEvent.properties.sessionID === sessionId &&
      statusEvent.properties.status.type === "idle"
    );
  }

  if (event.type === "session.idle") {
    const idleEvent = event as EventSessionIdle;
    return idleEvent.properties.sessionID === sessionId;
  }

  return false;
}

/**
 * Convert an OpenCode event to AI SDK stream parts.
 */
export function convertEventToStreamParts(
  event: OpencodeEvent,
  state: StreamState,
  logger?: Logger | false,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];

  switch (event.type) {
    case "message.part.updated": {
      const partEvent = event as EventMessagePartUpdated;
      const partParts = handlePartUpdated(partEvent, state, logger);
      parts.push(...partParts);
      break;
    }

    case "message.updated": {
      // Track message role for filtering parts
      const messageEvent = event as EventMessageUpdated;
      const info = messageEvent.properties.info;
      state.messageRoles.set(info.id, info.role);
      break;
    }

    case "session.status":
    case "session.idle":
      // Session status changes - handled separately
      break;

    case "session.diff":
      // File diff events - informational, not converted to stream parts
      break;

    default:
      // Unknown event type - log if verbose
      if (logger && logger.debug) {
        logger.debug(`Unknown event type: ${event.type}`);
      }
  }

  return parts;
}

/**
 * Handle a message.part.updated event.
 */
function handlePartUpdated(
  event: EventMessagePartUpdated,
  state: StreamState,
  logger?: Logger | false,
): LanguageModelV3StreamPart[] {
  const { part, delta } = event.properties;
  const parts: LanguageModelV3StreamPart[] = [];

  // Get message role - skip parts from user messages (we only want assistant output)
  const messageRole = state.messageRoles.get(part.messageID);
  if (messageRole === "user") {
    // User message parts are echoed back but should not be streamed to output
    return parts;
  }

  switch (part.type) {
    case "text": {
      const textPart = part as TextPart;
      // Skip synthetic parts (context we added)
      if (textPart.synthetic || textPart.ignored) {
        break;
      }
      parts.push(...handleTextPart(textPart, delta, state));
      break;
    }

    case "reasoning": {
      const reasoningPart = part as ReasoningPart;
      parts.push(...handleReasoningPart(reasoningPart, delta, state));
      break;
    }

    case "tool": {
      const toolPart = part as ToolPart;
      parts.push(...handleToolPart(toolPart, state, logger));
      break;
    }

    case "step-finish": {
      const stepPart = part as StepFinishPart;
      handleStepFinishPart(stepPart, state);
      break;
    }

    case "step-start":
      // Step start markers - informational, not converted to stream parts
      break;

    case "file": {
      const filePart = part as FilePart;
      parts.push(...handleFilePart(filePart));
      break;
    }

    default:
      if (logger && logger.debug) {
        logger.debug(`Unknown part type: ${(part as { type: string }).type}`);
      }
  }

  return parts;
}

/**
 * Handle a text part update.
 */
function handleTextPart(
  part: TextPart,
  delta: string | undefined,
  state: StreamState,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const partId = part.id;

  // Start text if not started
  if (!state.textStarted || state.textPartId !== partId) {
    // End previous text if different part
    if (state.textStarted && state.textPartId && state.textPartId !== partId) {
      parts.push({ type: "text-end", id: state.textPartId });
    }
    parts.push({ type: "text-start", id: partId });
    state.textStarted = true;
    state.textPartId = partId;
    state.lastTextContent = "";
  }

  // Emit delta
  if (delta) {
    parts.push({ type: "text-delta", id: partId, delta });
    state.lastTextContent += delta;
  } else if (part.text && part.text !== state.lastTextContent) {
    // Calculate delta from full text if no delta provided
    const newDelta = part.text.slice(state.lastTextContent.length);
    if (newDelta) {
      parts.push({ type: "text-delta", id: partId, delta: newDelta });
      state.lastTextContent = part.text;
    }
  }

  return parts;
}

/**
 * Handle a reasoning part update.
 */
function handleReasoningPart(
  part: ReasoningPart,
  delta: string | undefined,
  state: StreamState,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const partId = part.id;

  // Start reasoning if not started
  if (!state.reasoningStarted || state.reasoningPartId !== partId) {
    // End previous reasoning if different part
    if (
      state.reasoningStarted &&
      state.reasoningPartId &&
      state.reasoningPartId !== partId
    ) {
      parts.push({ type: "reasoning-end", id: state.reasoningPartId });
    }
    parts.push({ type: "reasoning-start", id: partId });
    state.reasoningStarted = true;
    state.reasoningPartId = partId;
    state.lastReasoningContent = "";
  }

  // Emit delta
  if (delta) {
    parts.push({ type: "reasoning-delta", id: partId, delta });
    state.lastReasoningContent += delta;
  } else if (part.text && part.text !== state.lastReasoningContent) {
    // Calculate delta from full text if no delta provided
    const newDelta = part.text.slice(state.lastReasoningContent.length);
    if (newDelta) {
      parts.push({ type: "reasoning-delta", id: partId, delta: newDelta });
      state.lastReasoningContent = part.text;
    }
  }

  return parts;
}

/**
 * Handle a tool part update.
 */
function handleToolPart(
  part: ToolPart,
  state: StreamState,
  logger?: Logger | false,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const { callID, tool, state: toolState } = part;

  // Get or create tool stream state
  let streamState = state.toolStates.get(callID);
  if (!streamState) {
    streamState = {
      callId: callID,
      toolName: tool,
      inputStarted: false,
      inputClosed: false,
      callEmitted: false,
      resultEmitted: false,
    };
    state.toolStates.set(callID, streamState);
  }

  switch (toolState.status) {
    case "pending":
      // Tool is pending - emit input start
      if (!streamState.inputStarted) {
        parts.push({
          type: "tool-input-start",
          id: callID,
          toolName: tool,
          providerExecuted: true,
          dynamic: true,
        });
        streamState.inputStarted = true;
      }
      break;

    case "running": {
      // Tool is running - emit input delta if input changed
      if (!streamState.inputStarted) {
        parts.push({
          type: "tool-input-start",
          id: callID,
          toolName: tool,
          providerExecuted: true,
          dynamic: true,
          ...(toolState.title ? { title: toolState.title } : {}),
        });
        streamState.inputStarted = true;
      }

      const inputStr = JSON.stringify(toolState.input);
      if (streamState.lastInput && inputStr.startsWith(streamState.lastInput)) {
        const inputDelta = inputStr.slice(streamState.lastInput.length);
        if (inputDelta) {
          parts.push({
            type: "tool-input-delta",
            id: callID,
            delta: inputDelta,
          });
        }
      }
      streamState.lastInput = inputStr;
      break;
    }

    case "completed":
      // Tool completed - emit input end, tool call, and result
      if (!streamState.inputClosed) {
        if (!streamState.inputStarted) {
          parts.push({
            type: "tool-input-start",
            id: callID,
            toolName: tool,
            providerExecuted: true,
            dynamic: true,
          });
          streamState.inputStarted = true;
        }
        parts.push({ type: "tool-input-end", id: callID });
        streamState.inputClosed = true;
      }

      if (!streamState.callEmitted) {
        parts.push({
          type: "tool-call",
          toolCallId: callID,
          toolName: tool,
          input: JSON.stringify(toolState.input),
          providerExecuted: true,
          dynamic: true,
        });
        streamState.callEmitted = true;
      }

      if (!streamState.resultEmitted) {
        parts.push({
          type: "tool-result",
          toolCallId: callID,
          toolName: tool,
          result: (toolState.output ?? "") as NonNullable<JSONValue>,
          isError: false,
          dynamic: true,
        });
        streamState.resultEmitted = true;
      }
      break;

    case "error":
      // Tool errored - emit input end, tool call, and error result
      if (!streamState.inputClosed) {
        if (!streamState.inputStarted) {
          parts.push({
            type: "tool-input-start",
            id: callID,
            toolName: tool,
            providerExecuted: true,
            dynamic: true,
          });
          streamState.inputStarted = true;
        }
        parts.push({ type: "tool-input-end", id: callID });
        streamState.inputClosed = true;
      }

      if (!streamState.callEmitted) {
        parts.push({
          type: "tool-call",
          toolCallId: callID,
          toolName: tool,
          input: JSON.stringify(toolState.input),
          providerExecuted: true,
          dynamic: true,
        });
        streamState.callEmitted = true;
      }

      if (!streamState.resultEmitted) {
        parts.push({
          type: "tool-result",
          toolCallId: callID,
          toolName: tool,
          result: (toolState.error ??
            "Unknown error") as NonNullable<JSONValue>,
          isError: true,
          dynamic: true,
        });
        streamState.resultEmitted = true;

        if (logger) {
          logger.warn(`Tool ${tool} failed: ${toolState.error}`);
        }
      }
      break;
  }

  return parts;
}

/**
 * Handle a step finish part (contains token usage).
 */
function handleStepFinishPart(part: StepFinishPart, state: StreamState): void {
  state.usage.inputTokens += part.tokens.input;
  state.usage.outputTokens += part.tokens.output;
  state.usage.reasoningTokens += part.tokens.reasoning;
  state.usage.cachedInputTokens += part.tokens.cache.read;
  state.usage.cachedWriteTokens += part.tokens.cache.write;
  state.usage.totalCost += part.cost;
}

/**
 * Handle a file part.
 */
function handleFilePart(_part: FilePart): LanguageModelV3StreamPart[] {
  // Convert to AI SDK file format
  // Note: The file data is in URL format (could be data URL or file URL)
  // For now, we skip file parts as they require special handling
  // TODO: Implement file part conversion if needed
  return [];
}

/**
 * Create the final stream parts to close out the stream.
 */
export function createFinishParts(
  state: StreamState,
  finishReason: LanguageModelV3FinishReason,
  sessionId: string,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const inputTokensTotal =
    state.usage.inputTokens +
    state.usage.cachedInputTokens +
    state.usage.cachedWriteTokens;
  const usage: LanguageModelV3Usage = {
    inputTokens: {
      total: inputTokensTotal,
      noCache: state.usage.inputTokens,
      cacheRead: state.usage.cachedInputTokens,
      cacheWrite: state.usage.cachedWriteTokens,
    },
    outputTokens: {
      total: state.usage.outputTokens,
      text: undefined,
      reasoning: state.usage.reasoningTokens,
    },
    raw: {
      input_tokens: state.usage.inputTokens,
      output_tokens: state.usage.outputTokens,
      reasoning_tokens: state.usage.reasoningTokens,
      cache_read_input_tokens: state.usage.cachedInputTokens,
      cache_write_input_tokens: state.usage.cachedWriteTokens,
      total_cost: state.usage.totalCost,
    },
  };

  // Close text if open
  if (state.textStarted && state.textPartId) {
    parts.push({ type: "text-end", id: state.textPartId });
  }

  // Close reasoning if open
  if (state.reasoningStarted && state.reasoningPartId) {
    parts.push({ type: "reasoning-end", id: state.reasoningPartId });
  }

  // Emit finish with usage
  parts.push({
    type: "finish",
    usage,
    finishReason,
    providerMetadata: {
      opencode: {
        sessionId,
        cost: state.usage.totalCost,
      },
    },
  });

  return parts;
}

/**
 * Create stream start part with warnings.
 */
export function createStreamStartPart(
  warnings: string[],
): LanguageModelV3StreamPart {
  const callWarnings: SharedV3Warning[] = warnings.map((warning) => ({
    type: "other" as const,
    message: warning,
  }));

  return {
    type: "stream-start",
    warnings: callWarnings,
  };
}
