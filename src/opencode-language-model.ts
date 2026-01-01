import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  SharedV3Warning,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
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

    // Validate and parse model ID
    const parsed = validateModelId(this.modelId, this.logger);
    if (!parsed) {
      throw new Error(`Invalid model ID: ${this.modelId}`);
    }
    this.parsedModelId = parsed;

    // Validate settings
    validateSettings(this.settings, this.logger);

    // Set initial session ID if provided
    if (this.settings.sessionId) {
      this.sessionId = this.settings.sessionId;
    }
  }

  /**
   * Non-streaming generation.
   */
  async doGenerate(options: LanguageModelV3CallOptions) {
    const warnings: SharedV3Warning[] = [];

    // Log unsupported options
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
      warnings.push({ type: "unsupported", feature: warning });
    }

    // Warn about tools (we can observe but not provide custom tools)
    if (options.tools && options.tools.length > 0) {
      const toolWarning =
        "Custom tool definitions are ignored. OpenCode executes tools server-side.";
      this.logger.warn(toolWarning);
      warnings.push({
        type: "unsupported",
        feature: "custom-tools",
        details: toolWarning,
      });
    }

    // Convert messages
    const mode =
      options.responseFormat?.type === "json"
        ? {
            type: "object-json" as const,
            schema: options.responseFormat.schema,
          }
        : { type: "regular" as const };

    const {
      parts,
      systemPrompt,
      warnings: conversionWarnings,
    } = convertToOpencodeMessages(options.prompt, {
      logger: this.logger,
      mode,
    });

    for (const warning of conversionWarnings) {
      warnings.push({
        type: "unsupported",
        feature: "message-conversion",
        details: warning,
      });
    }

    try {
      // Check if already aborted
      if (options.abortSignal?.aborted) {
        const error = new Error("Request aborted");
        error.name = "AbortError";
        throw error;
      }

      // Get or create session
      const sessionId = await this.getOrCreateSession();

      // Get client
      const client = await this.clientManager.getClient();

      // Build request body
      const requestBody = {
        model: this.parsedModelId.providerID
          ? {
              providerID: this.parsedModelId.providerID,
              modelID: this.parsedModelId.modelID,
            }
          : undefined,
        agent: this.settings.agent,
        system: systemPrompt ?? this.settings.systemPrompt,
        parts: parts as Array<
          | { type: "text"; text: string }
          | { type: "file"; mime: string; url: string }
        >,
        tools: this.settings.tools,
      };

      // Send prompt (blocking)
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: requestBody,
      });

      // Extract response data
      const data = result.data;
      if (!data) {
        throw new Error("No response data from OpenCode");
      }

      // Type assertion for the response structure
      const responseData = data as {
        info?: Message;
        parts?: Part[];
      };

      // Extract text content
      const textContent = this.extractTextFromParts(responseData.parts ?? []);
      const content: LanguageModelV3Content[] = [];

      if (textContent) {
        content.push({ type: "text", text: textContent });
      }

      // Extract tool calls
      const toolCalls = this.extractToolCallsFromParts(
        responseData.parts ?? [],
      );
      for (const toolCall of toolCalls) {
        content.push(toolCall);
      }

      // Extract usage from step-finish parts
      const usage = this.extractUsageFromParts(responseData.parts ?? []);

      // Determine finish reason
      const finishReason = mapOpencodeFinishReason(responseData.info);

      return {
        content,
        finishReason,
        usage: {
          inputTokens: {
            total: usage.inputTokens || undefined,
            noCache: undefined,
            cacheRead: usage.cachedInputTokens || undefined,
            cacheWrite: usage.cachedWriteTokens || undefined,
          },
          outputTokens: {
            total: usage.outputTokens || undefined,
            text: undefined,
            reasoning: usage.reasoningTokens || undefined,
          },
        },
        providerMetadata: {
          opencode: {
            sessionId,
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

    // Log unsupported options
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

    // Warn about tools
    if (options.tools && options.tools.length > 0) {
      const toolWarning =
        "Custom tool definitions are ignored. OpenCode executes tools server-side.";
      this.logger.warn(toolWarning);
      warnings.push(toolWarning);
    }

    // Convert messages
    const mode =
      options.responseFormat?.type === "json"
        ? {
            type: "object-json" as const,
            schema: options.responseFormat.schema,
          }
        : { type: "regular" as const };

    const {
      parts,
      systemPrompt,
      warnings: conversionWarnings,
    } = convertToOpencodeMessages(options.prompt, {
      logger: this.logger,
      mode,
    });
    warnings.push(...conversionWarnings);

    // Get or create session
    const sessionId = await this.getOrCreateSession();

    // Get client
    const client = await this.clientManager.getClient();

    // Build request body
    const requestBody = {
      model: this.parsedModelId.providerID
        ? {
            providerID: this.parsedModelId.providerID,
            modelID: this.parsedModelId.modelID,
          }
        : undefined,
      agent: this.settings.agent,
      system: systemPrompt ?? this.settings.systemPrompt,
      parts: parts as Array<
        | { type: "text"; text: string }
        | { type: "file"; mime: string; url: string }
      >,
      tools: this.settings.tools,
    };

    // Capture logger for use in stream callbacks
    const logger = this.logger;

    // Create the stream
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        // Emit stream start with warnings
        controller.enqueue(createStreamStartPart(warnings));

        try {
          // Subscribe to events BEFORE sending prompt
          const eventsResult = await client.event.subscribe();

          // The stream is an async generator
          const eventStream = eventsResult.stream;
          if (!eventStream) {
            throw new Error("Failed to subscribe to events");
          }

          // Send prompt asynchronously (don't await)
          client.session
            .prompt({
              path: { id: sessionId },
              body: requestBody,
            })
            .catch((error) => {
              logger.error(`Prompt error: ${extractErrorMessage(error)}`);
              controller.enqueue({ type: "error", error });
            });

          // Create stream state
          const state = createStreamState();
          let lastMessageInfo: Message | undefined;

          // Process events
          for await (const event of eventStream) {
            // Check abort signal
            if (options.abortSignal?.aborted) {
              // Abort the session
              try {
                await client.session.abort({ path: { id: sessionId } });
              } catch {
                // Ignore abort errors
              }
              break;
            }

            // Filter events for this session
            if (!isEventForSession(event, sessionId)) {
              continue;
            }

            // Convert and emit stream parts
            const streamParts = convertEventToStreamParts(event, state, logger);
            for (const part of streamParts) {
              controller.enqueue(part);
            }

            // Track message info for finish reason
            if (event.type === "message.updated") {
              const messageEvent = event as { properties: { info: Message } };
              if (messageEvent.properties.info.role === "assistant") {
                lastMessageInfo = messageEvent.properties.info;
              }
            }

            // Check for completion
            if (isSessionComplete(event, sessionId)) {
              // Determine finish reason
              const finishReason = mapOpencodeFinishReason(lastMessageInfo);

              // Emit final parts
              const finishParts = createFinishParts(
                state,
                finishReason,
                sessionId,
              );
              for (const part of finishParts) {
                controller.enqueue(part);
              }

              break;
            }
          }
        } catch (error) {
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

  /**
   * Get or create a session for this model instance.
   */
  private async getOrCreateSession(): Promise<string> {
    // Use existing session if available and not forcing new
    if (this.sessionId && !this.settings.createNewSession) {
      return this.sessionId;
    }

    // Create new session
    const client = await this.clientManager.getClient();

    const result = await client.session.create({
      body: {
        title: this.settings.sessionTitle ?? "AI SDK Session",
      },
    });

    const data = result.data as { id: string } | undefined;
    if (!data?.id) {
      throw new Error("Failed to create session");
    }

    this.sessionId = data.id;
    this.logger.debug?.(`Created session: ${this.sessionId}`);

    return this.sessionId;
  }

  /**
   * Extract text content from parts.
   */
  private extractTextFromParts(parts: Part[]): string {
    return parts
      .filter(
        (part): part is Part & { type: "text"; text: string } =>
          part.type === "text" &&
          typeof (part as { text?: string }).text === "string",
      )
      .filter(
        (part) =>
          !(part as { synthetic?: boolean }).synthetic &&
          !(part as { ignored?: boolean }).ignored,
      )
      .map((part) => part.text)
      .join("");
  }

  /**
   * Extract tool calls from parts.
   */
  private extractToolCallsFromParts(parts: Part[]): LanguageModelV3Content[] {
    const toolCalls: LanguageModelV3Content[] = [];

    for (const part of parts) {
      if (part.type === "tool") {
        const toolPart = part as {
          callID: string;
          tool: string;
          state: {
            status: string;
            input: Record<string, unknown>;
            output?: string;
            error?: string;
          };
        };

        if (toolPart.state.status === "completed") {
          toolCalls.push({
            type: "tool-call",
            toolCallId: toolPart.callID,
            toolName: toolPart.tool,
            input: JSON.stringify(toolPart.state.input),
          });

          toolCalls.push({
            type: "tool-result",
            toolCallId: toolPart.callID,
            toolName: toolPart.tool,
            result: toolPart.state.output ?? "",
          });
        } else if (toolPart.state.status === "error") {
          toolCalls.push({
            type: "tool-call",
            toolCallId: toolPart.callID,
            toolName: toolPart.tool,
            input: JSON.stringify(toolPart.state.input),
          });

          toolCalls.push({
            type: "tool-result",
            toolCallId: toolPart.callID,
            toolName: toolPart.tool,
            result: toolPart.state.error ?? "Unknown error",
            isError: true,
          });
        }
      }
    }

    return toolCalls;
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
