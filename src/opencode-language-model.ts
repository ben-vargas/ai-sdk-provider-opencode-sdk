import type {
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolApprovalResponsePart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type {
  Logger,
  OpencodeSettings,
  ParsedModelId,
  StreamingUsage,
} from "./types.js";
import { OpencodeClientManager } from "./opencode-client-manager.js";
import { convertToOpencodeMessages } from "./convert-to-opencode-messages.js";
import {
  convertEventToStreamParts,
  createStreamState,
  createFinishParts,
  createStreamStartPart,
  isEventForSession,
  isSessionComplete,
  type Message,
  type Part,
} from "./convert-from-opencode-events.js";
import { mapOpencodeFinishReason } from "./map-opencode-finish-reason.js";
import { getLogger, logUnsupportedCallOptions } from "./logger.js";
import { validateModelId, validateSettings } from "./validation.js";
import { wrapError, extractErrorMessage, isAbortError } from "./errors.js";
import {
  safeStringifyToolInput,
  planFilePartConversion,
} from "./opencode-part-utils.js";

interface ToolApprovalResponse {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

interface ApprovalClient {
  permission?: {
    reply?: (parameters: {
      requestID: string;
      reply: "once" | "always" | "reject";
      message?: string;
      directory?: string;
    }) => Promise<unknown> | unknown;
  };
}

/**
 * Convert OpenCode token usage to the AI SDK v6 usage shape.
 */
function convertUsage(usage: StreamingUsage): LanguageModelV3Usage {
  const inputTokensTotal =
    usage.inputTokens + usage.cachedInputTokens + usage.cachedWriteTokens;

  return {
    inputTokens: {
      total: inputTokensTotal,
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

function extractToolApprovalResponses(
  prompt: LanguageModelV3Prompt,
): ToolApprovalResponse[] {
  const responses: ToolApprovalResponse[] = [];

  for (const message of prompt) {
    if (message.role !== "tool") {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== "tool-approval-response") {
        continue;
      }

      const response = part as LanguageModelV3ToolApprovalResponsePart;
      responses.push({
        approvalId: response.approvalId,
        approved: response.approved,
        reason: response.reason,
      });
    }
  }

  return responses;
}

/**
 * OpenCode Language Model implementation of LanguageModelV3.
 */
export class OpencodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;

  readonly modelId: string;
  readonly provider = "opencode";

  /**
   * OpenCode doesn't support URL-based file inputs.
   * All files must be base64 encoded.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly settings: OpencodeSettings;
  private readonly logger: Logger;
  private readonly clientManager: OpencodeClientManager;
  private sessionId: string | undefined;
  private sessionInitPromise: Promise<string> | null = null;
  private repliedApprovalIdsBySession = new Map<string, Set<string>>();
  private parsedModelId: ParsedModelId;

  constructor(options: {
    modelId: string;
    settings: OpencodeSettings;
    clientManager: OpencodeClientManager;
  }) {
    this.modelId = options.modelId;
    this.settings = options.settings;
    this.clientManager = options.clientManager;
    this.logger = getLogger(options.settings.logger, options.settings.verbose);

    const parsed = validateModelId(this.modelId, this.logger);
    if (!parsed) {
      throw new Error(`Invalid model ID: ${this.modelId}`);
    }
    this.parsedModelId = parsed;

    validateSettings(this.settings, this.logger);

    if (this.settings.sessionId) {
      this.sessionId = this.settings.sessionId;
    }
  }

  /**
   * Non-streaming generation.
   */
  async doGenerate(options: LanguageModelV3CallOptions) {
    const warnings: SharedV3Warning[] = [];

    const unsupportedWarnings = logUnsupportedCallOptions(this.logger, {
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      stopSequences: options.stopSequences,
      seed: options.seed,
      maxTokens: options.maxOutputTokens,
    });

    for (const warning of unsupportedWarnings) {
      warnings.push({ type: "other", message: warning });
    }

    if (options.tools && options.tools.length > 0) {
      const toolWarning =
        "Custom tool definitions are ignored. OpenCode executes tools server-side.";
      this.logger.warn(toolWarning);
      warnings.push({ type: "other", message: toolWarning });
    }

    const approvalResponses = extractToolApprovalResponses(options.prompt);

    const {
      parts,
      systemPrompt,
      warnings: conversionWarnings,
    } = convertToOpencodeMessages(options.prompt, {
      logger: this.logger,
      // Structured output is enforced via requestBody.format (json_schema).
      // Avoid duplicating schema instructions as user-visible prompt text.
      mode: { type: "regular" },
      includeToolApprovalResponsesAsContext: false,
    });

    for (const warning of conversionWarnings) {
      warnings.push({ type: "other", message: warning });
    }

    try {
      if (options.abortSignal?.aborted) {
        const error = new Error("Request aborted");
        error.name = "AbortError";
        throw error;
      }

      const sessionId = await this.getOrCreateSession();
      const client = await this.clientManager.getClient();

      if (approvalResponses.length > 0) {
        const approvalWarnings = await this.replyToPendingApprovals(
          client,
          sessionId,
          approvalResponses,
        );
        for (const warning of approvalWarnings) {
          warnings.push({ type: "other", message: warning });
        }
      }

      const requestBody = this.buildPromptRequestBody(
        sessionId,
        parts,
        systemPrompt,
        options,
      );

      const result = await client.session.prompt(requestBody);

      const data = result.data;
      if (!data) {
        throw new Error("No response data from OpenCode");
      }

      const responseData = data as {
        info?: Message;
        parts?: Part[];
      };

      const content = this.extractContentFromParts(responseData.parts ?? []);
      const usage = this.extractUsageFromParts(responseData.parts ?? []);
      const finishReason = mapOpencodeFinishReason(responseData.info);

      return {
        content,
        finishReason,
        usage: convertUsage(usage),
        providerMetadata: {
          opencode: {
            sessionId,
            messageId: responseData.info?.id,
            cost: usage.totalCost,
          },
        },
        request: { body: requestBody },
        warnings,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      throw wrapError(error, {
        sessionId: this.sessionId,
      });
    }
  }

  /**
   * Streaming generation.
   */
  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>;
    request?: { body?: unknown };
    response?: { headers?: Record<string, string> };
  }> {
    const warnings: string[] = [];

    const unsupportedWarnings = logUnsupportedCallOptions(this.logger, {
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      stopSequences: options.stopSequences,
      seed: options.seed,
      maxTokens: options.maxOutputTokens,
    });
    warnings.push(...unsupportedWarnings);

    if (options.tools && options.tools.length > 0) {
      const toolWarning =
        "Custom tool definitions are ignored. OpenCode executes tools server-side.";
      this.logger.warn(toolWarning);
      warnings.push(toolWarning);
    }

    const approvalResponses = extractToolApprovalResponses(options.prompt);

    const {
      parts,
      systemPrompt,
      warnings: conversionWarnings,
    } = convertToOpencodeMessages(options.prompt, {
      logger: this.logger,
      // Structured output is enforced via requestBody.format (json_schema).
      // Avoid duplicating schema instructions as user-visible prompt text.
      mode: { type: "regular" },
      includeToolApprovalResponsesAsContext: false,
    });
    warnings.push(...conversionWarnings);

    const sessionId = await this.getOrCreateSession();
    const client = await this.clientManager.getClient();

    const requestBody = this.buildPromptRequestBody(
      sessionId,
      parts,
      systemPrompt,
      options,
    );

    const directory = this.getRequestDirectory();
    const logger = this.logger;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: async (controller) => {
        const streamWarnings = [...warnings];
        let streamStartEmitted = false;

        try {
          const eventsResult = await client.event.subscribe(
            directory ? { directory } : undefined,
          );

          const eventStream = eventsResult.stream;
          if (!eventStream) {
            throw new Error("Failed to subscribe to events");
          }

          if (approvalResponses.length > 0) {
            const approvalWarnings = await this.replyToPendingApprovals(
              client,
              sessionId,
              approvalResponses,
            );
            streamWarnings.push(...approvalWarnings);
          }

          controller.enqueue(createStreamStartPart(streamWarnings));
          streamStartEmitted = true;

          let resolvePromptFailed: (() => void) | undefined;
          const promptFailed = new Promise<void>((resolve) => {
            resolvePromptFailed = resolve;
          });
          let resolveAbortRequested: (() => void) | undefined;
          const abortRequested = new Promise<void>((resolve) => {
            resolveAbortRequested = resolve;
          });
          let removeAbortListener = () => {};

          const abortSignal = options.abortSignal;
          if (abortSignal) {
            const onAbort = () => resolveAbortRequested?.();
            if (abortSignal.aborted) {
              onAbort();
            } else {
              abortSignal.addEventListener("abort", onAbort, { once: true });
              removeAbortListener = () =>
                abortSignal.removeEventListener("abort", onAbort);
            }
          }

          client.session.prompt(requestBody).catch((error: unknown) => {
            logger.error(`Prompt error: ${extractErrorMessage(error)}`);
            controller.enqueue({ type: "error", error });
            resolvePromptFailed?.();
          });

          const state = createStreamState();
          let lastMessageInfo: Message | undefined;
          const iterator = eventStream[Symbol.asyncIterator]();
          let iteratorClosed = false;
          const closeIterator = async () => {
            if (iteratorClosed) {
              return;
            }
            iteratorClosed = true;
            if (typeof iterator.return === "function") {
              try {
                await iterator.return(undefined);
              } catch (closeError) {
                logger.debug?.(
                  `Failed to close event stream iterator: ${extractErrorMessage(closeError)}`,
                );
              }
            }
          };

          try {
            while (true) {
              const nextEvent = iterator.next();
              const result = await Promise.race([
                nextEvent.then((value) => ({ type: "event" as const, value })),
                promptFailed.then(() => ({ type: "prompt-failed" as const })),
                abortRequested.then(() => ({ type: "aborted" as const })),
              ]);

              if (result.type === "prompt-failed") {
                await closeIterator();
                break;
              }

              if (result.type === "aborted") {
                try {
                  await client.session.abort({
                    sessionID: sessionId,
                    ...(directory ? { directory } : {}),
                  });
                } catch {
                  // ignore abort errors
                }
                await closeIterator();
                break;
              }

              const { done, value: event } = result.value;
              if (done) {
                iteratorClosed = true;
                break;
              }

              if (!isEventForSession(event, sessionId)) {
                continue;
              }

              const streamParts = convertEventToStreamParts(
                event,
                state,
                logger,
              );
              for (const part of streamParts) {
                controller.enqueue(part);
              }

              if (event.type === "message.updated") {
                const messageEvent = event as { properties: { info: Message } };
                if (messageEvent.properties.info.role === "assistant") {
                  lastMessageInfo = messageEvent.properties.info;
                }
              }

              if (isSessionComplete(event, sessionId)) {
                const finishReason = mapOpencodeFinishReason(lastMessageInfo);
                const finishParts = createFinishParts(
                  state,
                  finishReason,
                  sessionId,
                  lastMessageInfo?.id,
                );
                for (const part of finishParts) {
                  controller.enqueue(part);
                }

                await closeIterator();
                break;
              }
            }
          } finally {
            removeAbortListener();
            await closeIterator();
          }
        } catch (error) {
          if (!streamStartEmitted) {
            controller.enqueue(createStreamStartPart(streamWarnings));
          }
          if (!isAbortError(error)) {
            logger.error(`Stream error: ${extractErrorMessage(error)}`);
            controller.enqueue({ type: "error", error: wrapError(error) });
          }
        } finally {
          controller.close();
        }
      },
    });

    return {
      stream,
      request: { body: requestBody },
    };
  }

  private getRequestDirectory(): string | undefined {
    return this.settings.directory ?? this.settings.cwd;
  }

  private getResponseFormat(options: LanguageModelV3CallOptions):
    | {
        type: "json_schema";
        schema: Record<string, unknown>;
        retryCount?: number;
      }
    | undefined {
    if (options.responseFormat?.type !== "json") {
      return undefined;
    }

    return {
      type: "json_schema",
      schema: (options.responseFormat.schema ?? {
        type: "object",
        additionalProperties: true,
      }) as Record<string, unknown>,
      ...(this.settings.outputFormatRetryCount !== undefined
        ? { retryCount: this.settings.outputFormatRetryCount }
        : {}),
    };
  }

  private buildPromptRequestBody(
    sessionId: string,
    parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mime: string; url: string; filename?: string }
    >,
    systemPrompt: string | undefined,
    options: LanguageModelV3CallOptions,
  ) {
    const format = this.getResponseFormat(options);
    const directory = this.getRequestDirectory();

    return {
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
      ...(this.parsedModelId.providerID
        ? {
            model: {
              providerID: this.parsedModelId.providerID,
              modelID: this.parsedModelId.modelID,
            },
          }
        : {}),
      ...(this.settings.agent ? { agent: this.settings.agent } : {}),
      ...(this.settings.tools ? { tools: this.settings.tools } : {}),
      ...(format ? { format } : {}),
      ...((systemPrompt ?? this.settings.systemPrompt)
        ? { system: systemPrompt ?? this.settings.systemPrompt }
        : {}),
      ...(this.settings.variant ? { variant: this.settings.variant } : {}),
      parts,
    };
  }

  private async replyToPendingApprovals(
    client: ApprovalClient,
    sessionId: string,
    responses: ToolApprovalResponse[],
  ): Promise<string[]> {
    const permissionApi = client.permission;

    if (typeof permissionApi?.reply !== "function") {
      return [
        "OpenCode permission.reply is unavailable; tool approval responses were ignored.",
      ];
    }

    const warnings: string[] = [];
    const directory = this.getRequestDirectory();
    const repliedApprovalIds = this.getRepliedApprovalIdsForSession(sessionId);
    const pendingResponses = this.getPendingApprovalResponses(
      responses,
      repliedApprovalIds,
    );

    for (const response of pendingResponses) {
      try {
        await permissionApi.reply({
          requestID: response.approvalId,
          reply: response.approved ? "once" : "reject",
          ...(response.reason ? { message: response.reason } : {}),
          ...(directory ? { directory } : {}),
        });
        repliedApprovalIds.add(response.approvalId);
      } catch (error) {
        const warning =
          `Failed to apply tool approval response for ${response.approvalId}: ` +
          `${extractErrorMessage(error)}`;
        this.logger.warn(warning);
        warnings.push(warning);
      }
    }

    return warnings;
  }

  private getPendingApprovalResponses(
    responses: ToolApprovalResponse[],
    repliedApprovalIds: Set<string>,
  ): ToolApprovalResponse[] {
    const seenInRequest = new Set<string>();
    const pending: ToolApprovalResponse[] = [];

    for (const response of responses) {
      if (seenInRequest.has(response.approvalId)) {
        continue;
      }
      seenInRequest.add(response.approvalId);

      if (repliedApprovalIds.has(response.approvalId)) {
        continue;
      }

      pending.push(response);
    }

    return pending;
  }

  private getRepliedApprovalIdsForSession(sessionId: string): Set<string> {
    const existing = this.repliedApprovalIdsBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    this.repliedApprovalIdsBySession.set(sessionId, created);
    return created;
  }

  /**
   * Get or create a session for this model instance.
   */
  private async getOrCreateSession(): Promise<string> {
    if (this.sessionId && !this.settings.createNewSession) {
      return this.sessionId;
    }

    if (!this.settings.createNewSession && this.sessionInitPromise) {
      return this.sessionInitPromise;
    }

    const createSession = async (): Promise<string> => {
      const client = await this.clientManager.getClient();
      const directory = this.getRequestDirectory();
      const result = await client.session.create({
        ...(directory ? { directory } : {}),
        title: this.settings.sessionTitle ?? "AI SDK Session",
        ...(this.settings.permission
          ? { permission: this.settings.permission }
          : {}),
      });

      const data = result.data as { id: string } | undefined;
      if (!data?.id) {
        throw new Error("Failed to create session");
      }

      this.sessionId = data.id;
      this.logger.debug?.(`Created session: ${this.sessionId}`);

      return this.sessionId;
    };

    if (this.settings.createNewSession) {
      return createSession();
    }

    const pending = createSession();
    this.sessionInitPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.sessionInitPromise === pending) {
        this.sessionInitPromise = null;
      }
    }
  }

  /**
   * Extract content in AI SDK format from OpenCode parts.
   */
  private extractContentFromParts(parts: Part[]): LanguageModelV3Content[] {
    const content: LanguageModelV3Content[] = [];

    for (const part of parts) {
      if (
        part.type === "text" &&
        typeof (part as { text?: string }).text === "string"
      ) {
        if (
          !(part as { synthetic?: boolean }).synthetic &&
          !(part as { ignored?: boolean }).ignored
        ) {
          content.push({
            type: "text",
            text: (part as { text: string }).text,
          });
        }
        continue;
      }

      if (
        part.type === "reasoning" &&
        typeof (part as { text?: string }).text === "string"
      ) {
        content.push({
          type: "reasoning",
          text: (part as { text: string }).text,
        });
        continue;
      }

      if (part.type === "tool") {
        const toolParts = this.extractToolParts(part);
        content.push(...toolParts);
        continue;
      }

      if (part.type === "file") {
        content.push(...this.convertFilePartToContent(part));
      }
    }

    return content;
  }

  private extractToolParts(part: Part): LanguageModelV3Content[] {
    const toolParts: LanguageModelV3Content[] = [];
    const toolPart = part as {
      callID: string;
      tool: string;
      state: {
        status: string;
        input: Record<string, unknown>;
        output?: string;
        error?: string;
        attachments?: Array<Part>;
      };
    };

    if (toolPart.state.status === "completed") {
      toolParts.push({
        type: "tool-call",
        toolCallId: toolPart.callID,
        toolName: toolPart.tool,
        input: safeStringifyToolInput(toolPart.state.input, (message) => {
          this.logger.warn(
            `Failed to serialize tool input for ${toolPart.callID}: ${message}`,
          );
        }),
        providerExecuted: true,
        dynamic: true,
      });

      toolParts.push({
        type: "tool-result",
        toolCallId: toolPart.callID,
        toolName: toolPart.tool,
        result: (toolPart.state.output ?? "") as NonNullable<JSONValue>,
        dynamic: true,
      });

      const attachments = toolPart.state.attachments ?? [];
      for (const attachment of attachments) {
        if (attachment.type === "file") {
          toolParts.push(...this.convertFilePartToContent(attachment));
        }
      }
    } else if (toolPart.state.status === "error") {
      toolParts.push({
        type: "tool-call",
        toolCallId: toolPart.callID,
        toolName: toolPart.tool,
        input: safeStringifyToolInput(toolPart.state.input, (message) => {
          this.logger.warn(
            `Failed to serialize tool input for ${toolPart.callID}: ${message}`,
          );
        }),
        providerExecuted: true,
        dynamic: true,
      });

      toolParts.push({
        type: "tool-result",
        toolCallId: toolPart.callID,
        toolName: toolPart.tool,
        result: (toolPart.state.error ??
          "Unknown error") as NonNullable<JSONValue>,
        isError: true,
        dynamic: true,
      });
    }

    return toolParts;
  }

  private convertFilePartToContent(part: Part): LanguageModelV3Content[] {
    const filePart = part as {
      id?: string;
      mime?: string;
      filename?: string;
      url?: string;
      source?: Record<string, unknown>;
    };

    if (!filePart.url || !filePart.mime) {
      this.logger.debug?.(
        `Skipping file part with missing metadata: url=${String(filePart.url)} mime=${String(filePart.mime)}`,
      );
      return [];
    }

    const { plan, error } = planFilePartConversion(filePart);
    if (!plan) {
      if (error === "invalid-data-url") {
        this.logger.debug?.(
          `Skipping file part with invalid data URL: ${filePart.url.slice(0, 80)}`,
        );
      }
      return [];
    }

    const content: LanguageModelV3Content[] = [];

    if (plan.primary.type === "file") {
      content.push({
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
      content.push({
        type: "source",
        sourceType: "url",
        id: plan.primary.id,
        url: plan.primary.url,
        ...(plan.primary.title ? { title: plan.primary.title } : {}),
      });
    } else {
      content.push({
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
      content.push({
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

    return content;
  }

  /**
   * Extract usage information from step-finish parts.
   */
  private extractUsageFromParts(parts: Part[]): StreamingUsage {
    const usage: StreamingUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cachedWriteTokens: 0,
      totalCost: 0,
    };

    for (const part of parts) {
      if (part.type === "step-finish") {
        const stepPart = part as {
          cost: number;
          tokens: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        };

        usage.inputTokens += stepPart.tokens.input;
        usage.outputTokens += stepPart.tokens.output;
        usage.reasoningTokens += stepPart.tokens.reasoning;
        usage.cachedInputTokens += stepPart.tokens.cache.read;
        usage.cachedWriteTokens += stepPart.tokens.cache.write;
        usage.totalCost += stepPart.cost;
      }
    }

    return usage;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }
}
