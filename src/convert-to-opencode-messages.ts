/**
 * AI SDK prompt → OpenCode v2 prompt-input conversion.
 *
 * v2's `session.prompt` accepts one user `text` plus `files[]` as URIs —
 * there is no multi-role `parts[]` history injection and no `system` field.
 * This module therefore produces `{text, files, warnings, systemBlock}`:
 *
 * - `text`: the latest user turn (persistent/existing sessions — OpenCode
 *   owns the transcript) or the full history serialized as a delimited
 *   transcript (ephemeral sessions, where the target session is fresh).
 * - `files`: `data:` URIs only (the one scheme verified to reach the model
 *   end-to-end; see {@link OpencodeDataUri}). Anything non-convertible warns
 *   and is skipped BEFORE prompting — a bad attachment does not reject the
 *   prompt, it fails the whole turn late at the model provider.
 * - `systemBlock`: system messages separated out so the orchestration layer
 *   can route them: it writes them (joined with `settings.systemPrompt`) to
 *   the session's `ai-sdk.system` instruction entry, which is the real
 *   system channel, and only falls back to {@link prependSystemBlock} plus
 *   an `{type: "unsupported"}` warning when that entry cannot be used.
 *
 * Tool results/approvals in history render as delimited text context only:
 * OpenCode executes tools server-side and cannot consume client-provided
 * tool results.
 */
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultPart,
} from "@ai-sdk/provider";
import type {
  Logger,
  OpencodeDataUri,
  OpencodeResolveFileToUri,
  OpencodeSessionMode,
} from "./types.js";
import { isAttachableDataUri, isDataUri } from "./validation.js";

/**
 * A prompt file attachment: a `data:` URI (MIME travels in the URI's
 * mediatype — that is what the server stores and trusts) plus an optional
 * display name. Matches `SessionPromptInput.files[]` minus the unused
 * description/mention fields.
 */
export interface OpencodePromptFile {
  uri: OpencodeDataUri;
  name?: string;
}

/**
 * Result of converting an AI SDK prompt to v2 prompt input.
 */
export interface OpencodePromptConversion {
  /** The prompt `text` value (may be empty when nothing was serializable). */
  text: string;
  /** `data:`-URI attachments for `files[]`. */
  files: OpencodePromptFile[];
  /** Human-readable conversion warnings (degradations, skipped content). */
  warnings: string[];
  /**
   * Concatenated system messages, separated from `text`. Absent when the
   * prompt carries no system content. The converter never merges this into
   * `text` itself — the orchestration layer decides how to degrade it.
   */
  systemBlock?: string;
}

/**
 * Options for {@link convertToOpencodePrompt}.
 */
export interface ConvertToOpencodePromptOptions {
  /**
   * Session binding of the target session (see `resolveSessionMode`).
   * - "persistent"/"existing": OpenCode owns the transcript — only the
   *   latest user turn (the last user message and anything after it) is
   *   serialized.
   * - "ephemeral" (default): the session is fresh — the full history is
   *   serialized as a delimited transcript.
   */
  sessionMode?: OpencodeSessionMode;
  /**
   * Hook to resolve non-`data:` file references (URLs, provider files) to a
   * `data:` URI. Without it — or when it returns undefined or a non-`data:`
   * scheme — the file warns and is skipped.
   */
  resolveFileToUri?: OpencodeResolveFileToUri;
  /**
   * Append the JSON-mode instruction ({@link createJsonModeInstruction}) —
   * the structured-output degradation path. v2 has no server-side
   * `responseFormat` enforcement; this only embeds the schema as a prompt
   * instruction.
   */
  jsonMode?: { schema?: unknown };
  /**
   * Render tool-approval-response parts in history as delimited context.
   * @default false
   */
  includeToolApprovalResponsesAsContext?: boolean;
  logger?: Logger | false;
}

/**
 * Transcript delimiters. Stable, greppable, and unlikely in organic content;
 * organic lines that DO start with the marker are escaped with a leading
 * backslash. This is a lossy plaintext serialization for model consumption,
 * not a reversible encoding.
 */
const DELIM_PREFIX = "<<<opencode:";

function openDelimiter(role: string): string {
  return `${DELIM_PREFIX}${role}>>>`;
}

const END_DELIMITER = `${DELIM_PREFIX}end>>>`;

/** Escape organic content lines that would collide with the delimiters. */
function escapeTranscriptContent(content: string): string {
  return content.replace(/^(<{3}opencode:)/gm, "\\$1");
}

/**
 * Sanitize text interpolated into a delimiter line (the `name="…"` attribute
 * of inline file entries). The delimiter grammar reserves `>>>`, quotes, and
 * newlines — organic filenames containing them would fracture the delimiter
 * or spoof a role, so they are replaced rather than escaped (the transcript
 * is lossy plaintext, not a reversible encoding).
 */
function sanitizeDelimiterAttribute(value: string): string {
  return value.replace(/[">\n\r]/g, "_");
}

/** One serialized transcript entry. */
function transcriptEntry(role: string, content: string): string {
  return `${openDelimiter(role)}\n${escapeTranscriptContent(content)}\n${END_DELIMITER}`;
}

/**
 * Prepend the separated system block to a prompt text as a delimited system
 * entry — the **fallback** for when the session instruction entry cannot
 * carry it (system-role priority is lost; the caller must emit the
 * `{type: "unsupported"}` warning alongside).
 */
export function prependSystemBlock(text: string, systemBlock: string): string {
  const entry = transcriptEntry("system", systemBlock);
  return text ? `${entry}\n\n${text}` : entry;
}

/**
 * Create instruction text for the JSON-output degradation path. The schema
 * is embedded verbatim; there is no server-side enforcement in v2, so this
 * is a best-effort prompt instruction the caller pairs with client-side
 * parse/validate.
 */
export function createJsonModeInstruction(schema?: unknown): string {
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
 * Convert an AI SDK prompt to OpenCode v2 prompt input.
 *
 * Async because file resolution may call the `resolveFileToUri` hook.
 */
export async function convertToOpencodePrompt(
  prompt: LanguageModelV4Prompt,
  options?: ConvertToOpencodePromptOptions,
): Promise<OpencodePromptConversion> {
  const warnings: string[] = [];
  const logger = options?.logger;
  const files: OpencodePromptFile[] = [];

  const addWarning = (message: string): void => {
    if (!warnings.includes(message)) {
      warnings.push(message);
      if (logger) {
        logger.warn(message);
      }
    }
  };

  // System messages are collected globally (any position, either mode) and
  // returned separately.
  const systemParts = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const systemBlock =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  const history = prompt.filter((message) => message.role !== "system");

  // Persistent/existing sessions: OpenCode owns the transcript, so only the
  // latest user turn — the last user message and anything after it (e.g.
  // tool results the session has not seen) — is serialized. Ephemeral
  // sessions get the full history.
  const mode = options?.sessionMode ?? "ephemeral";
  let scope: typeof history;
  if (mode === "ephemeral") {
    scope = history;
  } else {
    let lastUserIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      scope = history;
      if (history.length > 0) {
        addWarning(
          "Prompt has no user message; serializing trailing non-user content as context",
        );
      }
    } else {
      scope = history.slice(lastUserIndex);
    }
  }

  const entries: Array<{ role: string; content: string }> = [];

  for (const message of scope) {
    switch (message.role) {
      case "user": {
        const textParts: string[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            textParts.push(part.text);
          } else {
            const converted = await convertUserFilePart(
              part,
              options?.resolveFileToUri,
              addWarning,
            );
            if (converted === undefined) {
              continue;
            }
            if (converted.kind === "file") {
              files.push(converted.file);
              textParts.push(
                `[attached file: ${converted.file.name ?? part.mediaType}]`,
              );
            } else {
              // Inline text documents stay in the prompt text (verified
              // path); a data:text/* attachment is unproven on live builds.
              textParts.push(
                transcriptEntry(
                  `file${
                    part.filename
                      ? ` name="${sanitizeDelimiterAttribute(part.filename)}"`
                      : ""
                  }`,
                  converted.text,
                ),
              );
            }
          }
        }
        entries.push({ role: "user", content: textParts.join("\n") });
        break;
      }

      case "assistant": {
        const lines: string[] = [];
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              lines.push(part.text);
              break;
            case "reasoning":
              lines.push(`[reasoning]: ${part.text}`);
              break;
            case "tool-call":
              lines.push(
                `[tool call: ${part.toolName}]: ${safeJson(part.input)}`,
              );
              break;
            case "tool-result":
              addToolResultContextWarning(addWarning);
              lines.push(
                `[tool result: ${part.toolName}]: ${formatToolResultOutput(part)}`,
              );
              break;
            case "file":
            case "reasoning-file":
              addWarning(
                "Assistant file parts in the prompt cannot be attached to an OpenCode prompt and were skipped",
              );
              break;
            case "custom":
              // Provider-specific content with no standardized payload.
              break;
          }
        }
        entries.push({ role: "assistant", content: lines.join("\n") });
        break;
      }

      case "tool": {
        const lines: string[] = [];
        for (const part of message.content) {
          if (part.type === "tool-result") {
            addToolResultContextWarning(addWarning);
            lines.push(
              `[tool result: ${part.toolName}]: ${formatToolResultOutput(part)}`,
            );
          } else if (options?.includeToolApprovalResponsesAsContext) {
            const reason = part.reason ? ` (${part.reason})` : "";
            lines.push(
              `[tool approval: ${part.approvalId}]: ${part.approved ? "approved" : "denied"}${reason}`,
            );
          }
        }
        if (lines.length > 0) {
          entries.push({ role: "tool", content: lines.join("\n") });
        }
        break;
      }
    }
  }

  // Single plain user message: send its text directly, no delimiters (the
  // overwhelmingly common case, and the one live-verified shape).
  let text: string;
  if (entries.length === 1 && entries[0]!.role === "user") {
    text = entries[0]!.content;
  } else {
    text = entries
      .map((entry) => transcriptEntry(entry.role, entry.content))
      .join("\n\n");
  }

  if (options?.jsonMode) {
    const instruction = createJsonModeInstruction(options.jsonMode.schema);
    text = text ? `${text}\n\n${instruction}` : instruction;
  }

  if (!text && files.length === 0) {
    addWarning("Prompt conversion produced no text and no files");
  }

  return {
    text,
    files,
    warnings,
    ...(systemBlock !== undefined ? { systemBlock } : {}),
  };
}

const TOOL_RESULT_CONTEXT_WARNING =
  "Tool results in prompts are included as context only. " +
  "OpenCode executes tools server-side and cannot use client-provided results.";

function addToolResultContextWarning(
  addWarning: (message: string) => void,
): void {
  addWarning(TOOL_RESULT_CONTEXT_WARNING);
}

type ConvertedUserFilePart =
  | { kind: "file"; file: OpencodePromptFile }
  | { kind: "inline-text"; text: string };

/**
 * Convert one user file part to a `data:` URI attachment (or inline text).
 * Returns undefined when the part is skipped (a warning has been emitted).
 *
 * The pre-prompt rejection policy: anything that cannot become a `data:`
 * URI with a full mediatype is warned about and skipped here — never
 * attached. The server admits any URI scheme without validation and hands it
 * verbatim to the model provider, where a bad attachment fails the whole
 * turn (spike Q1).
 */
async function convertUserFilePart(
  part: LanguageModelV4FilePart,
  resolveFileToUri: OpencodeResolveFileToUri | undefined,
  addWarning: (message: string) => void,
): Promise<ConvertedUserFilePart | undefined> {
  const { mediaType, filename } = part;
  const name = filename !== undefined ? { name: filename } : {};

  switch (part.data.type) {
    case "data": {
      const data = part.data.data;

      if (typeof data === "string") {
        if (isDataUri(data)) {
          // Caller-supplied data URI: the URI's own mediatype is what the
          // server stores and trusts — use as-is, but only when well-formed
          // (the server admits malformed URIs verbatim and the turn fails
          // late at the model provider).
          if (!isAttachableDataUri(data)) {
            return skipForMalformedDataUri(filename, addWarning);
          }
          return { kind: "file", file: { uri: data, ...name } };
        }
        if (looksLikeUrl(data)) {
          // A URL smuggled through the base64-string slot (v1 guarded this):
          // base64-encoding it verbatim would attach garbage bytes. Route it
          // through the URL path (resolver hook or warn + skip).
          return resolveViaHook(
            {
              mediaType,
              ...(filename !== undefined ? { filename } : {}),
              url: data,
            },
            data,
            resolveFileToUri,
            addWarning,
            name,
          );
        }
        if (!hasFullMediaType(mediaType)) {
          return resolveDataViaHookOrSkip(
            { mediaType, filename, data },
            resolveFileToUri,
            addWarning,
            name,
          );
        }
        // Base64 payload → data URI with the part's mediaType.
        return {
          kind: "file",
          file: {
            uri: `data:${mediaType};base64,${normalizeBase64(data)}`,
            ...name,
          },
        };
      }

      if (!hasFullMediaType(mediaType)) {
        return resolveDataViaHookOrSkip(
          { mediaType, filename, data },
          resolveFileToUri,
          addWarning,
          name,
        );
      }
      return {
        kind: "file",
        file: {
          uri: `data:${mediaType};base64,${uint8ArrayToBase64(data)}`,
          ...name,
        },
      };
    }

    case "url": {
      const urlString = part.data.url.toString();
      if (isDataUri(urlString)) {
        if (!isAttachableDataUri(urlString)) {
          return skipForMalformedDataUri(filename, addWarning);
        }
        return { kind: "file", file: { uri: urlString, ...name } };
      }
      // A non-data: URL reaching the provider means the AI SDK did not
      // download it (`supportedUrls` is `{}`, so it downloads what it can).
      // Only the resolver hook can turn it into an attachable URI.
      return resolveViaHook(
        {
          mediaType,
          ...(filename !== undefined ? { filename } : {}),
          url: urlString,
        },
        urlString,
        resolveFileToUri,
        addWarning,
        name,
      );
    }

    case "text":
      // Inline text document: keep it in the prompt text. data:text/*
      // attachments are unverified on live builds; inline text is lossless.
      return { kind: "inline-text", text: part.data.text };

    case "reference": {
      // Provider file references carry neither bytes nor a URL — nothing the
      // resolver hook could work with.
      addWarning(
        `File reference${filename ? ` "${filename}"` : ""} cannot be resolved to a data: URI and was skipped`,
      );
      return undefined;
    }
  }
}

/**
 * Byte/base64 parts that cannot become a `data:` URI directly (no concrete
 * `type/subtype` media type) get one last chance through the resolver hook —
 * with the raw bytes populated on {@link OpencodeFileToResolve.data} so the
 * hook can supply the media type itself. Without a hook (or when it declines)
 * the file warns and is skipped.
 */
async function resolveDataViaHookOrSkip(
  file: {
    mediaType: string;
    filename: string | undefined;
    data: Uint8Array | string;
  },
  resolveFileToUri: OpencodeResolveFileToUri | undefined,
  addWarning: (message: string) => void,
  name: { name?: string },
): Promise<ConvertedUserFilePart | undefined> {
  if (!resolveFileToUri) {
    return skipForMediaType(file.mediaType, file.filename, addWarning);
  }

  const display = file.filename ?? `(${file.mediaType})`;
  let resolved: string | undefined;
  try {
    resolved = await resolveFileToUri({
      mediaType: file.mediaType,
      ...(file.filename !== undefined ? { filename: file.filename } : {}),
      data: file.data,
    });
  } catch (error) {
    addWarning(
      `resolveFileToUri failed for ${display}: ${error instanceof Error ? error.message : String(error)}; the file was skipped`,
    );
    return undefined;
  }

  if (resolved === undefined) {
    return skipForMediaType(file.mediaType, file.filename, addWarning);
  }
  if (!isDataUri(resolved) || !isAttachableDataUri(resolved)) {
    addWarning(
      `resolveFileToUri returned a non-attachable URI for ${display}; the file was skipped`,
    );
    return undefined;
  }
  return { kind: "file", file: { uri: resolved, ...name } };
}

/** Detect a URL smuggled through the base64-string data slot. */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function resolveViaHook(
  file: Parameters<OpencodeResolveFileToUri>[0],
  urlString: string,
  resolveFileToUri: OpencodeResolveFileToUri | undefined,
  addWarning: (message: string) => void,
  name: { name?: string },
): Promise<ConvertedUserFilePart | undefined> {
  const display =
    urlString.length > 80 ? `${urlString.slice(0, 80)}…` : urlString;

  if (!resolveFileToUri) {
    addWarning(
      `File URL ${display} is not a data: URI and no resolveFileToUri hook is configured; the file was skipped`,
    );
    return undefined;
  }

  let resolved: string | undefined;
  try {
    resolved = await resolveFileToUri(file);
  } catch (error) {
    addWarning(
      `resolveFileToUri failed for ${display}: ${error instanceof Error ? error.message : String(error)}; the file was skipped`,
    );
    return undefined;
  }

  if (resolved === undefined) {
    addWarning(`resolveFileToUri skipped file URL ${display}`);
    return undefined;
  }
  if (!isDataUri(resolved)) {
    // Non-data: schemes are stored verbatim and fail the turn at the model
    // provider — reject before prompting instead of failing late.
    addWarning(
      `resolveFileToUri returned a non-data: URI for ${display}; the file was skipped`,
    );
    return undefined;
  }
  if (!isAttachableDataUri(resolved)) {
    addWarning(
      `resolveFileToUri returned a malformed data: URI for ${display}; the file was skipped`,
    );
    return undefined;
  }
  return { kind: "file", file: { uri: resolved, ...name } };
}

function skipForMalformedDataUri(
  filename: string | undefined,
  addWarning: (message: string) => void,
): undefined {
  addWarning(
    `File${filename ? ` "${filename}"` : ""} has a malformed data: URI ` +
      "(a concrete type/subtype mediatype and a payload are required); the file was skipped",
  );
  return undefined;
}

function skipForMediaType(
  mediaType: string,
  filename: string | undefined,
  addWarning: (message: string) => void,
): undefined {
  addWarning(
    `File${filename ? ` "${filename}"` : ""} has no full media type ("${mediaType}"); ` +
      "a data: URI needs one (the server trusts the URI mediatype), so the file was skipped",
  );
  return undefined;
}

/**
 * A data-URI mediatype must be a full `type/subtype` — the AI SDK also
 * permits bare top-level types ("image") and normalized wildcards, which
 * would produce a URI the model provider rejects turn-late.
 */
function hasFullMediaType(mediaType: string): boolean {
  const slash = mediaType.indexOf("/");
  return slash > 0 && slash < mediaType.length - 1 && !mediaType.includes("*");
}

/**
 * Format a tool result output for text representation.
 */
function formatToolResultOutput(part: LanguageModelV4ToolResultPart): string {
  const output = part.output;

  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return safeJson(output.value);
    case "error-text":
      return `Error: ${output.value}`;
    case "error-json":
      return `Error: ${safeJson(output.value)}`;
    case "content":
      return output.value
        .map((item) => {
          if (item.type === "text") {
            return item.text;
          }
          if (item.type === "file") {
            return `[file: ${item.mediaType}]`;
          }
          return "[custom content]";
        })
        .join("\n");
    case "execution-denied":
      return output.reason
        ? `Execution denied: ${output.reason}`
        : "Execution denied";
    default:
      return safeJson(output);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
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
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}
