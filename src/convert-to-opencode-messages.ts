import type {
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3FilePart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3ReasoningPart,
  LanguageModelV3ToolApprovalResponsePart,
} from "@ai-sdk/provider";
import type { Logger } from "./types.js";

/**
 * Input part types for OpenCode SDK.
 * Based on SessionPromptData.body.parts in the SDK.
 */
export interface TextPartInput {
  id?: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface FilePartInput {
  id?: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export type OpencodePartInput = TextPartInput | FilePartInput;

/**
 * Result of converting AI SDK messages to OpenCode format.
 */
export interface ConversionResult {
  parts: OpencodePartInput[];
  systemPrompt?: string;
  warnings: string[];
}

/**
 * Convert AI SDK prompt to OpenCode format.
 */
export function convertToOpencodeMessages(
  prompt: LanguageModelV3Prompt,
  options?: {
    logger?: Logger | false;
    mode?: { type: "regular" } | { type: "object-json"; schema?: unknown };
    includeToolApprovalResponsesAsContext?: boolean;
  },
): ConversionResult {
  const parts: OpencodePartInput[] = [];
  const warnings: string[] = [];
  let systemPrompt: string | undefined;
  const logger = options?.logger;

  for (const message of prompt) {
    switch (message.role) {
      case "system":
        // Collect system messages into system prompt
        if (systemPrompt) {
          systemPrompt += "\n\n" + message.content;
        } else {
          systemPrompt = message.content;
        }
        break;

      case "user":
        // Convert user message parts
        for (const part of message.content) {
          const converted = convertUserPart(part, warnings, logger);
          if (converted) {
            parts.push(converted);
          }
        }
        break;

      case "assistant": {
        // Convert assistant message parts (for context in multi-turn)
        const assistantParts = convertAssistantContent(
          message.content,
          warnings,
          logger,
        );
        parts.push(...assistantParts);
        break;
      }

      case "tool": {
        // Tool results - include as context text
        const toolResultParts = convertToolResults(
          message.content,
          warnings,
          logger,
          options?.includeToolApprovalResponsesAsContext ?? false,
        );
        parts.push(...toolResultParts);
        break;
      }
    }
  }

  // Add JSON mode instruction if needed
  if (options?.mode?.type === "object-json") {
    const jsonInstruction = createJsonModeInstruction(options.mode.schema);
    parts.push({
      type: "text",
      text: jsonInstruction,
    });
  }

  return { parts, systemPrompt, warnings };
}

/**
 * Convert a user message part to OpenCode format.
 */
function convertUserPart(
  part: LanguageModelV3TextPart | LanguageModelV3FilePart,
  warnings: string[],
  logger?: Logger | false,
): OpencodePartInput | null {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text,
      };

    case "file":
      return convertFilePart(part, warnings, logger);

    default: {
      // Unknown part type
      const unknownPart = part as { type: string };
      const warning = `Unknown user message part type: ${unknownPart.type}`;
      warnings.push(warning);
      if (logger) {
        logger.warn(warning);
      }
      return null;
    }
  }
}

/**
 * Convert a file part to OpenCode format.
 */
function convertFilePart(
  part: LanguageModelV3FilePart,
  warnings: string[],
  logger?: Logger | false,
): FilePartInput | null {
  const { data, mediaType, filename } = part;

  // Handle different data formats
  if (typeof data === "string") {
    // Could be base64, data URL, or regular URL
    if (data.startsWith("data:")) {
      // Data URL - use as-is
      return {
        type: "file",
        mime: mediaType,
        filename,
        url: data,
      };
    }

    if (data.startsWith("http://") || data.startsWith("https://")) {
      // Remote URL - not supported by OpenCode
      const warning = `Remote URLs are not supported for file input: ${data.substring(0, 50)}...`;
      warnings.push(warning);
      if (logger) {
        logger.warn(warning);
      }
      return null;
    }

    // Assume base64 - convert to data URL
    return {
      type: "file",
      mime: mediaType,
      filename,
      url: `data:${mediaType};base64,${normalizeBase64(data)}`,
    };
  }

  if (data instanceof Uint8Array) {
    // Binary data - convert to base64 data URL
    const base64 = uint8ArrayToBase64(data);
    return {
      type: "file",
      mime: mediaType,
      filename,
      url: `data:${mediaType};base64,${base64}`,
    };
  }

  // URL object
  if (data instanceof URL) {
    const urlString = data.toString();
    if (urlString.startsWith("data:")) {
      return {
        type: "file",
        mime: mediaType,
        filename,
        url: urlString,
      };
    }

    const warning = `Remote URLs are not supported for file input: ${urlString.substring(0, 50)}...`;
    warnings.push(warning);
    if (logger) {
      logger.warn(warning);
    }
    return null;
  }

  const warning = `Unsupported file data type: ${typeof data}`;
  warnings.push(warning);
  if (logger) {
    logger.warn(warning);
  }
  return null;
}

/**
 * Convert assistant message content to OpenCode parts.
 * Used for providing context in multi-turn conversations.
 */
function convertAssistantContent(
  content: Array<
    | LanguageModelV3TextPart
    | LanguageModelV3FilePart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
    | LanguageModelV3ToolResultPart
  >,
  warnings: string[],
  logger?: Logger | false,
): OpencodePartInput[] {
  const parts: OpencodePartInput[] = [];

  for (const part of content) {
    switch (part.type) {
      case "text":
        // Include assistant text as context
        parts.push({
          type: "text",
          text: `[Assistant]: ${part.text}`,
          synthetic: true,
        });
        break;

      case "reasoning":
        // Include reasoning as context (marked as synthetic)
        parts.push({
          type: "text",
          text: `[Reasoning]: ${part.text}`,
          synthetic: true,
        });
        break;

      case "tool-call":
        // Include tool call as context
        parts.push({
          type: "text",
          text: `[Tool Call: ${part.toolName}]: ${JSON.stringify(part.input)}`,
          synthetic: true,
        });
        break;

      case "tool-result": {
        // Include tool result as context
        const resultText = formatToolResult(part);
        parts.push({
          type: "text",
          text: `[Tool Result: ${part.toolName}]: ${resultText}`,
          synthetic: true,
        });
        break;
      }

      case "file": {
        // Files from assistant are typically generated - skip for now
        const warning =
          "File parts in assistant messages are not yet supported";
        warnings.push(warning);
        if (logger) {
          logger.warn(warning);
        }
        break;
      }
    }
  }

  return parts;
}

/**
 * Convert tool result messages to OpenCode parts.
 */
function convertToolResults(
  content: Array<
    LanguageModelV3ToolResultPart | LanguageModelV3ToolApprovalResponsePart
  >,
  warnings: string[],
  logger?: Logger | false,
  includeToolApprovalResponsesAsContext = false,
): OpencodePartInput[] {
  const parts: OpencodePartInput[] = [];

  // Note: OpenCode executes tools server-side, so we can only include
  // tool results as context. The server won't use these as actual tool results.
  const warning =
    "Tool results in prompts are included as context only. " +
    "OpenCode executes tools server-side and cannot use client-provided results.";

  const hasToolResult = content.some((part) => part.type === "tool-result");
  if (hasToolResult && !warnings.includes(warning)) {
    warnings.push(warning);
    if (logger) {
      logger.warn(warning);
    }
  }

  for (const part of content) {
    if (part.type === "tool-result") {
      const resultText = formatToolResult(part);
      parts.push({
        type: "text",
        text: `[Tool Result: ${part.toolName}]: ${resultText}`,
        synthetic: true,
      });
      continue;
    }

    if (
      part.type === "tool-approval-response" &&
      includeToolApprovalResponsesAsContext
    ) {
      const reasonText = part.reason ? ` (${part.reason})` : "";
      parts.push({
        type: "text",
        text: `[Tool Approval: ${part.approvalId}]: ${part.approved ? "approved" : "denied"}${reasonText}`,
        synthetic: true,
      });
      continue;
    }
  }

  return parts;
}

/**
 * Format a tool result for text representation.
 */
function formatToolResult(part: LanguageModelV3ToolResultPart): string {
  const output = part.output;

  switch (output.type) {
    case "text":
      return output.value;

    case "json":
      return JSON.stringify(output.value, null, 2);

    case "error-text":
      return `Error: ${output.value}`;

    case "error-json":
      return `Error: ${JSON.stringify(output.value)}`;

    case "content":
      return output.value
        .map((item) => {
          if (item.type === "text") {
            return item.text;
          }
          if (item.type === "file-data") {
            return `[File: ${item.mediaType}]`;
          }
          if (item.type === "file-url") {
            return `[File URL: ${item.url}]`;
          }
          if (item.type === "file-id") {
            return "[File ID]";
          }
          if (item.type === "image-data") {
            return `[Image: ${item.mediaType}]`;
          }
          if (item.type === "image-url") {
            return `[Image URL: ${item.url}]`;
          }
          if (item.type === "image-file-id") {
            return "[Image File ID]";
          }
          return "[Content]";
        })
        .join("\n");
    case "execution-denied":
      return output.reason
        ? `Execution denied: ${output.reason}`
        : "Execution denied";

    default:
      return JSON.stringify(output);
  }
}

/**
 * Create instruction text for JSON mode.
 */
function createJsonModeInstruction(schema?: unknown): string {
  let instruction =
    "IMPORTANT: You must respond with valid JSON only. " +
    "Do not include any text before or after the JSON. " +
    "Do not include markdown code blocks.";

  if (schema) {
    instruction +=
      "\n\nThe JSON must conform to this schema:\n" +
      JSON.stringify(schema, null, 2);
  }

  return instruction;
}

/**
 * Normalize base64 string by removing whitespace.
 */
function normalizeBase64(base64: string): string {
  return base64.replace(/\s/g, "");
}

/**
 * Convert Uint8Array to base64 string.
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  // In Node.js, we can use Buffer
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }

  // Fallback for environments without Buffer
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

/**
 * Extract the text content from an array of parts.
 */
export function extractTextFromParts(parts: OpencodePartInput[]): string {
  return parts
    .filter((part): part is TextPartInput => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
