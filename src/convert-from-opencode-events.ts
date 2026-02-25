import type {
  JSONValue,
  LanguageModelV3StreamPart,
  LanguageModelV3FinishReason,
  SharedV3Warning,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Logger, ToolStreamState, StreamingUsage } from "./types.js";
import {
  safeStringifyToolInput,
  planFilePartConversion,
} from "./opencode-part-utils.js";

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

export interface EventPermissionAsked {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata?: Record<string, unknown>;
    always?: string[];
    tool?: {
      messageID: string;
      callID: string;
    };
  };
}

export interface EventQuestionAsked {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    questions: Array<{
      header: string;
      question: string;
      options: Array<{
        label: string;
        description: string;
      }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
    tool?: {
      messageID: string;
      callID: string;
    };
  };
}

export interface EventMessagePartDelta {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
}

export type OpencodeEvent =
  | EventMessagePartUpdated
  | EventMessageUpdated
  | EventMessagePartDelta
  | EventSessionStatus
  | EventSessionIdle
  | EventPermissionAsked
  | EventQuestionAsked
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

export interface FilePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: {
    type?: string;
    path?: string;
    uri?: string;
    [key: string]: unknown;
  };
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
  attachments?: FilePart[];
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
  messageRoles: Map<string, "user" | "assistant">;
  permissionRequests: Set<string>;
  questionRequests: Set<string>;
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
    permissionRequests: new Set(),
    questionRequests: new Set(),
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

    if (
      "part" in props &&
      typeof props.part === "object" &&
      props.part !== null
    ) {
      const part = props.part as Record<string, unknown>;
      return part.sessionID === sessionId;
    }

    if (
      "info" in props &&
      typeof props.info === "object" &&
      props.info !== null
    ) {
      const info = props.info as Record<string, unknown>;
      return info.sessionID === sessionId;
    }

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

    case "message.part.delta": {
      const deltaEvent = event as EventMessagePartDelta;
      const deltaParts = handlePartDelta(deltaEvent, state);
      parts.push(...deltaParts);
      break;
    }

    case "message.updated": {
      const messageEvent = event as EventMessageUpdated;
      const info = messageEvent.properties.info;
      state.messageRoles.set(info.id, info.role);
      break;
    }

    case "permission.asked": {
      const permissionEvent = event as EventPermissionAsked;
      const requestId = permissionEvent.properties.id;

      if (!state.permissionRequests.has(requestId)) {
        state.permissionRequests.add(requestId);
        parts.push({
          type: "tool-approval-request",
          approvalId: requestId,
          toolCallId: permissionEvent.properties.tool?.callID ?? requestId,
          providerMetadata: {
            opencode: {
              sessionId: permissionEvent.properties.sessionID,
              permission: permissionEvent.properties.permission,
              patterns: permissionEvent.properties.patterns,
            },
          },
        });
      }
      break;
    }

    case "question.asked": {
      const questionEvent = event as EventQuestionAsked;
      const questionId = questionEvent.properties.id;

      if (!state.questionRequests.has(questionId)) {
        state.questionRequests.add(questionId);

        const warning =
          "OpenCode question.asked events are not yet mapped to AI SDK responses. " +
          "The provider cannot answer interactive questions automatically.";
        if (logger) {
          logger.warn(warning);
        }

        parts.push({
          type: "error",
          error: new Error(
            `${warning} Question ID: ${questionId}. ` +
              "If this blocks generation, answer/reject the question in OpenCode directly.",
          ),
        });
      }
      break;
    }

    case "session.status":
    case "session.idle":
    case "session.diff":
    case "question.replied":
    case "question.rejected":
    case "project.updated":
    case "server.instance.disposed":
    case "global.disposed":
    case "worktree.ready":
    case "worktree.failed":
    case "mcp.tools.changed":
      break;

    default:
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

  const messageRole = state.messageRoles.get(part.messageID);
  if (messageRole === "user") {
    return parts;
  }

  switch (part.type) {
    case "text": {
      const textPart = part as TextPart;
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
    case "subtask":
    case "snapshot":
    case "patch":
    case "agent":
    case "retry":
    case "compaction":
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

function handlePartDelta(
  event: EventMessagePartDelta,
  state: StreamState,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const { partID, field, delta } = event.properties;

  if (!delta) return parts;

  // OpenCode sends both text and reasoning parts with field set as "text". 
  // So we use the part ID tracked by prior message.part.updated events to differentiate.
  const isReasoning = field === "reasoning" || state.reasoningPartId === partID;

  if (isReasoning) {
    if (!state.reasoningStarted || state.reasoningPartId !== partID) {
      if (
        state.reasoningStarted &&
        state.reasoningPartId &&
        state.reasoningPartId !== partID
      ) {
        parts.push({ type: "reasoning-end", id: state.reasoningPartId });
      }
      parts.push({ type: "reasoning-start", id: partID });
      state.reasoningStarted = true;
      state.reasoningPartId = partID;
      state.lastReasoningContent = "";
    }
    parts.push({ type: "reasoning-delta", id: partID, delta });
    state.lastReasoningContent += delta;
  } else {
    if (!state.textStarted || state.textPartId !== partID) {
      if (state.textStarted && state.textPartId && state.textPartId !== partID) {
        parts.push({ type: "text-end", id: state.textPartId });
      }
      parts.push({ type: "text-start", id: partID });
      state.textStarted = true;
      state.textPartId = partID;
      state.lastTextContent = "";
    }
    parts.push({ type: "text-delta", id: partID, delta });
    state.lastTextContent += delta;
  }

  return parts;
}

function handleTextPart(
  part: TextPart,
  delta: string | undefined,
  state: StreamState,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const partId = part.id;

  if (!state.textStarted || state.textPartId !== partId) {
    if (state.textStarted && state.textPartId && state.textPartId !== partId) {
      parts.push({ type: "text-end", id: state.textPartId });
    }
    parts.push({ type: "text-start", id: partId });
    state.textStarted = true;
    state.textPartId = partId;
    state.lastTextContent = "";
  }

  if (delta) {
    parts.push({ type: "text-delta", id: partId, delta });
    state.lastTextContent += delta;
  } else if (part.text && part.text !== state.lastTextContent) {
    const newDelta = part.text.slice(state.lastTextContent.length);
    if (newDelta) {
      parts.push({ type: "text-delta", id: partId, delta: newDelta });
      state.lastTextContent = part.text;
    }
  }

  return parts;
}

function handleReasoningPart(
  part: ReasoningPart,
  delta: string | undefined,
  state: StreamState,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const partId = part.id;

  if (!state.reasoningStarted || state.reasoningPartId !== partId) {
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

  if (delta) {
    parts.push({ type: "reasoning-delta", id: partId, delta });
    state.lastReasoningContent += delta;
  } else if (part.text && part.text !== state.lastReasoningContent) {
    const newDelta = part.text.slice(state.lastReasoningContent.length);
    if (newDelta) {
      parts.push({ type: "reasoning-delta", id: partId, delta: newDelta });
      state.lastReasoningContent = part.text;
    }
  }

  return parts;
}

function handleToolPart(
  part: ToolPart,
  state: StreamState,
  logger?: Logger | false,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const { callID, tool, state: toolState } = part;

  let streamState = state.toolStates.get(callID);
  if (!streamState) {
    streamState = {
      callId: callID,
      toolName: tool,
      inputStarted: false,
      inputClosed: false,
      callEmitted: false,
      resultEmitted: false,
      emittedAttachmentIds: new Set(),
    };
    state.toolStates.set(callID, streamState);
  }

  switch (toolState.status) {
    case "pending":
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

      const inputStr = safeStringifyToolInput(toolState.input, (message) => {
        if (logger) {
          logger.warn(
            `Failed to serialize tool input for ${callID}: ${message}`,
          );
        }
      });
      if (!streamState.lastInput) {
        if (inputStr) {
          parts.push({
            type: "tool-input-delta",
            id: callID,
            delta: inputStr,
          });
        }
      } else if (inputStr.startsWith(streamState.lastInput)) {
        const inputDelta = inputStr.slice(streamState.lastInput.length);
        if (inputDelta) {
          parts.push({
            type: "tool-input-delta",
            id: callID,
            delta: inputDelta,
          });
        }
      } else if (inputStr) {
        // Input changed in a non-prefix way; emit the full input to avoid data loss.
        parts.push({
          type: "tool-input-delta",
          id: callID,
          delta: inputStr,
        });
      }
      streamState.lastInput = inputStr;
      break;
    }

    case "completed":
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
          input: safeStringifyToolInput(toolState.input, (message) => {
            if (logger) {
              logger.warn(
                `Failed to serialize tool input for ${callID}: ${message}`,
              );
            }
          }),
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

      if (Array.isArray(toolState.attachments)) {
        for (const attachment of toolState.attachments) {
          const attachmentId =
            attachment.id ??
            `${attachment.url}|${attachment.mime}|${attachment.filename ?? ""}`;
          if (streamState.emittedAttachmentIds.has(attachmentId)) {
            continue;
          }
          parts.push(...handleFilePart(attachment));
          streamState.emittedAttachmentIds.add(attachmentId);
        }
      }
      break;

    case "error":
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
          input: safeStringifyToolInput(toolState.input, (message) => {
            if (logger) {
              logger.warn(
                `Failed to serialize tool input for ${callID}: ${message}`,
              );
            }
          }),
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

function handleStepFinishPart(part: StepFinishPart, state: StreamState): void {
  state.usage.inputTokens += part.tokens.input;
  state.usage.outputTokens += part.tokens.output;
  state.usage.reasoningTokens += part.tokens.reasoning;
  state.usage.cachedInputTokens += part.tokens.cache.read;
  state.usage.cachedWriteTokens += part.tokens.cache.write;
  state.usage.totalCost += part.cost;
}

function handleFilePart(part: FilePart): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  const { plan } = planFilePartConversion(part);
  if (!plan) {
    return parts;
  }

  if (plan.primary.type === "file") {
    parts.push({
      type: "file",
      mediaType: plan.primary.mediaType,
      data: plan.primary.data,
      ...(plan.sourceMetadata
        ? {
            providerMetadata: {
              opencode: {
                source: plan.sourceMetadata as unknown as JSONValue,
              },
            },
          }
        : {}),
    });
  } else if (plan.primary.type === "source-url") {
    parts.push({
      type: "source",
      sourceType: "url",
      id: plan.primary.id,
      url: plan.primary.url,
      ...(plan.primary.title ? { title: plan.primary.title } : {}),
    });
  } else {
    parts.push({
      type: "source",
      sourceType: "document",
      id: plan.primary.id,
      mediaType: plan.primary.mediaType,
      title: plan.primary.title,
      ...(plan.primary.filename ? { filename: plan.primary.filename } : {}),
      ...(plan.sourceMetadata
        ? {
            providerMetadata: {
              opencode: {
                source: plan.sourceMetadata as unknown as JSONValue,
              },
            },
          }
        : {}),
    });
  }

  if (plan.secondaryDocumentSource) {
    parts.push({
      type: "source",
      sourceType: "document",
      id: plan.secondaryDocumentSource.id,
      mediaType: plan.secondaryDocumentSource.mediaType,
      title: plan.secondaryDocumentSource.title,
      ...(plan.secondaryDocumentSource.filename
        ? { filename: plan.secondaryDocumentSource.filename }
        : {}),
      ...(plan.sourceMetadata
        ? {
            providerMetadata: {
              opencode: {
                source: plan.sourceMetadata as unknown as JSONValue,
              },
            },
          }
        : {}),
    });
  }

  return parts;
}

/**
 * Create the final stream parts to close out the stream.
 */
export function createFinishParts(
  state: StreamState,
  finishReason: LanguageModelV3FinishReason,
  sessionId: string,
  messageId?: string,
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

  if (state.textStarted && state.textPartId) {
    parts.push({ type: "text-end", id: state.textPartId });
  }

  if (state.reasoningStarted && state.reasoningPartId) {
    parts.push({ type: "reasoning-end", id: state.reasoningPartId });
  }

  parts.push({
    type: "finish",
    usage,
    finishReason,
    providerMetadata: {
      opencode: {
        sessionId,
        ...(messageId ? { messageId } : {}),
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
