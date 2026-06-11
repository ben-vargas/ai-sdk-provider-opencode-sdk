import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpencodeLanguageModel } from "./opencode-language-model.js";
import { OpencodeClientManager } from "./opencode-client-manager.js";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

// Mock the client manager
const mockClient = {
  session: {
    create: vi.fn().mockResolvedValue({
      data: { id: "session-123" },
    }),
    prompt: vi.fn().mockResolvedValue({
      data: {
        info: {
          id: "msg-1",
          sessionID: "session-123",
          role: "assistant",
          finish: "end_turn",
        },
        parts: [
          {
            id: "part-1",
            type: "text",
            text: "Hello, world!",
          },
          {
            id: "part-2",
            type: "step-finish",
            reason: "end_turn",
            cost: 0.001,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        ],
      },
    }),
    abort: vi.fn(),
  },
  event: {
    subscribe: vi.fn().mockResolvedValue({
      stream: (async function* () {
        yield {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Hello",
            },
            delta: "Hello",
          },
        };
        yield {
          type: "session.idle",
          properties: {
            sessionID: "session-123",
          },
        };
      })(),
    }),
  },
  permission: {
    reply: vi.fn().mockResolvedValue({
      data: true,
    }),
  },
};

const mockClientManager = {
  getClient: vi.fn().mockResolvedValue(mockClient),
  dispose: vi.fn().mockResolvedValue(undefined),
  getServerUrl: vi.fn().mockReturnValue("http://127.0.0.1:4096"),
};

describe("opencode-language-model", () => {
  let model: OpencodeLanguageModel;

  beforeEach(() => {
    vi.clearAllMocks();
    model = new OpencodeLanguageModel({
      modelId: "anthropic/claude-3-5-sonnet-20241022",
      settings: {},
      clientManager: mockClientManager as unknown as OpencodeClientManager,
    });
  });

  describe("constructor", () => {
    it("should set modelId and provider", () => {
      expect(model.modelId).toBe("anthropic/claude-3-5-sonnet-20241022");
      expect(model.provider).toBe("opencode");
    });

    it("should have specificationVersion v3", () => {
      expect(model.specificationVersion).toBe("v3");
    });

    it("should have empty supportedUrls", () => {
      expect(model.supportedUrls).toEqual({});
    });

    it("should throw for invalid model ID", () => {
      expect(() => {
        new OpencodeLanguageModel({
          modelId: "",
          settings: {},
          clientManager: mockClientManager as unknown as OpencodeClientManager,
        });
      }).toThrow("Invalid model ID");
    });

    it("should accept model ID without provider", () => {
      const modelWithoutProvider = new OpencodeLanguageModel({
        modelId: "claude-3-5-sonnet-20241022",
        settings: {},
        clientManager: mockClientManager as unknown as OpencodeClientManager,
      });
      expect(modelWithoutProvider.modelId).toBe("claude-3-5-sonnet-20241022");
    });

    it("should use sessionId from settings", () => {
      const modelWithSession = new OpencodeLanguageModel({
        modelId: "anthropic/claude",
        settings: { sessionId: "existing-session" },
        clientManager: mockClientManager as unknown as OpencodeClientManager,
      });
      expect(modelWithSession.getSessionId()).toBe("existing-session");
    });
  });

  describe("doGenerate", () => {
    const basicPrompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    it("should generate text response", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Hello, world!",
      });
    });

    it("should return usage information", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.usage).toMatchObject({
        inputTokens: {
          total: 10,
          noCache: 10,
        },
        outputTokens: {
          total: 5,
        },
      });
    });

    it("should return finish reason", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.finishReason).toMatchObject({ unified: "stop" });
    });

    it("should include session ID in provider metadata", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.providerMetadata?.opencode?.sessionId).toBe("session-123");
    });

    it("should create session on first call", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(mockClient.session.create).toHaveBeenCalled();
    });

    it("should reuse session on subsequent calls", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
      });

      await model.doGenerate({
        prompt: basicPrompt,
      });

      // Should only create session once
      expect(mockClient.session.create).toHaveBeenCalledTimes(1);
    });

    it("should only create one session for concurrent calls", async () => {
      mockClient.session.create.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ data: { id: "session-concurrent" } }),
              20,
            );
          }),
      );

      const [result1, result2] = await Promise.all([
        model.doGenerate({ prompt: basicPrompt }),
        model.doGenerate({ prompt: basicPrompt }),
      ]);

      expect(mockClient.session.create).toHaveBeenCalledTimes(1);
      expect(result1.providerMetadata?.opencode?.sessionId).toBe(
        "session-concurrent",
      );
      expect(result2.providerMetadata?.opencode?.sessionId).toBe(
        "session-concurrent",
      );
    });

    it("should warn about unsupported parameters", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
        temperature: 0.7,
        topP: 0.9,
      });

      expect(result.warnings?.length).toBeGreaterThan(0);
      expect(
        result.warnings?.some((w) => w.message?.includes("temperature")),
      ).toBe(true);
    });

    it("should warn about custom tools", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
        tools: [
          {
            type: "function",
            name: "customTool",
            description: "A custom tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      });

      expect(result.warnings?.some((w) => w.message?.includes("tool"))).toBe(
        true,
      );
    });

    it("should handle system messages", async () => {
      const promptWithSystem: LanguageModelV3Prompt = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];

      await model.doGenerate({
        prompt: promptWithSystem,
      });

      expect(mockClient.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "You are helpful.",
        }),
      );
    });

    it("should include model info in request", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(mockClient.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          model: {
            providerID: "anthropic",
            modelID: "claude-3-5-sonnet-20241022",
          },
        }),
      );
    });

    it("should pass providerOptions messageID to OpenCode", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
        providerOptions: {
          opencode: {
            messageID: "msg_user-123",
          },
        },
      });

      expect(mockClient.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          messageID: "msg_user-123",
        }),
      );
    });

    it("should reject providerOptions messageID without msg_ prefix", async () => {
      await expect(
        model.doGenerate({
          prompt: basicPrompt,
          providerOptions: {
            opencode: {
              messageID: "user-123",
            },
          },
        }),
      ).rejects.toThrow(
        "providerOptions.opencode.messageID must start with 'msg_'",
      );

      expect(mockClient.session.create).not.toHaveBeenCalled();
      expect(mockClient.session.prompt).not.toHaveBeenCalled();
    });

    it("should include request body in response", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.request?.body).toBeDefined();
    });

    it("should wrap empty OpenCode JSON responses with model context", async () => {
      mockClient.session.prompt.mockRejectedValueOnce(
        new SyntaxError("Unexpected end of JSON input"),
      );

      await expect(
        model.doGenerate({
          prompt: basicPrompt,
        }),
      ).rejects.toThrow(
        'OpenCode returned an empty JSON response for model "anthropic/claude-3-5-sonnet-20241022"',
      );
    });

    it("should wrap missing OpenCode response data with model context", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({ data: undefined });

      await expect(
        model.doGenerate({
          prompt: basicPrompt,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'OpenCode returned no response data for model "anthropic/claude-3-5-sonnet-20241022"',
        ),
        isRetryable: false,
        data: expect.objectContaining({
          errorType: "EmptyResponseData",
          sessionId: "session-123",
          modelId: "anthropic/claude-3-5-sonnet-20241022",
        }),
      });
    });

    it("should include response error details when response data is missing", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: undefined,
        error: { message: "model not found" },
      });

      await expect(
        model.doGenerate({
          prompt: basicPrompt,
        }),
      ).rejects.toThrow("Original error: model not found");
    });

    it("should handle data-style prompt results from custom clients", async () => {
      // A caller-supplied client configured with responseStyle: "data"
      // resolves session.prompt to the payload itself.
      mockClient.session.prompt.mockResolvedValueOnce({
        info: {
          id: "msg-1",
          sessionID: "session-123",
          role: "assistant",
          finish: "end_turn",
        },
        parts: [{ id: "part-1", type: "text", text: "Hello, world!" }],
      });

      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Hello, world!",
      });
    });

    it("should wrap undefined data-style prompt results with model context", async () => {
      // A responseStyle: "data" client resolves to undefined on failure.
      mockClient.session.prompt.mockResolvedValueOnce(undefined);

      await expect(
        model.doGenerate({
          prompt: basicPrompt,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'OpenCode returned no response data for model "anthropic/claude-3-5-sonnet-20241022"',
        ),
        data: expect.objectContaining({
          errorType: "EmptyResponseData",
        }),
      });
    });

    it("should handle JSON mode", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
        responseFormat: { type: "json" },
      });

      expect(mockClient.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          format: expect.objectContaining({
            type: "json_schema",
          }),
        }),
      );

      const requestBody = mockClient.session.prompt.mock.calls[0]?.[0] as {
        parts?: Array<{ type: string; text?: string }>;
      };

      const hasPromptJsonInstruction = requestBody.parts?.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes("You must respond with valid JSON only"),
      );
      expect(hasPromptJsonInstruction).toBe(false);
    });

    it("should apply tool approval responses before prompting", async () => {
      const promptWithApproval: LanguageModelV3Prompt = [
        {
          role: "user",
          content: [{ type: "text", text: "Continue after approval." }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
              reason: "Looks safe",
            },
          ],
        },
      ];

      await model.doGenerate({
        prompt: promptWithApproval,
      });

      expect(mockClient.permission.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          requestID: "approval-1",
          reply: "once",
          message: "Looks safe",
        }),
      );
    });

    it("should not replay already-applied approval responses across turns", async () => {
      const promptWithApproval: LanguageModelV3Prompt = [
        {
          role: "user",
          content: [{ type: "text", text: "Continue after approval." }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
              reason: "Looks safe",
            },
          ],
        },
      ];

      await model.doGenerate({
        prompt: promptWithApproval,
      });
      await model.doGenerate({
        prompt: promptWithApproval,
      });

      expect(mockClient.permission.reply).toHaveBeenCalledTimes(1);
    });

    it("should dedupe duplicate approval responses in a single prompt", async () => {
      const promptWithDuplicateApprovals: LanguageModelV3Prompt = [
        {
          role: "user",
          content: [{ type: "text", text: "Continue after approval." }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
            },
          ],
        },
      ];

      await model.doGenerate({
        prompt: promptWithDuplicateApprovals,
      });

      expect(mockClient.permission.reply).toHaveBeenCalledTimes(1);
    });

    it("should not emit duplicate document sources for local files with source metadata", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
            finish: "end_turn",
          },
          parts: [
            {
              id: "file-1",
              type: "file",
              mime: "text/plain",
              filename: "README.md",
              url: "/workspace/README.md",
              source: {
                type: "file",
                path: "/workspace/README.md",
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      const documentSources = result.content.filter(
        (part): part is { type: "source"; sourceType: "document" } =>
          part.type === "source" && part.sourceType === "document",
      );

      expect(documentSources).toHaveLength(1);
    });
  });

  describe("doStream", () => {
    const basicPrompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    it("should return a readable stream", async () => {
      const result = await model.doStream({
        prompt: basicPrompt,
      });

      expect(result.stream).toBeInstanceOf(ReadableStream);
    });

    it("should emit stream-start with warnings", async () => {
      const result = await model.doStream({
        prompt: basicPrompt,
        temperature: 0.7, // Unsupported
      });

      const reader = result.stream.getReader();
      const { value: firstPart } = await reader.read();

      expect(firstPart).toMatchObject({
        type: "stream-start",
      });

      reader.releaseLock();
    });

    it("should include request body in response", async () => {
      const result = await model.doStream({
        prompt: basicPrompt,
      });

      expect(result.request?.body).toBeDefined();
    });

    it("should emit StructuredOutput tool as text stream parts", async () => {
      const structuredInput = { output: "# Hello", outputType: "markdown" };
      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: (async function* () {
          yield {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-1",
                sessionID: "session-123",
                messageID: "msg-1",
                type: "tool",
                callID: "call-so-1",
                tool: "StructuredOutput",
                state: {
                  status: "completed",
                  input: structuredInput,
                  output: "Structured output captured successfully.",
                  title: "Structured Output",
                  time: { start: 1000, end: 2000 },
                },
              },
            },
          };
          yield {
            type: "session.status",
            properties: {
              sessionID: "session-123",
              status: { type: "idle" },
            },
          };
        })(),
      });

      const result = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "give me output" }] },
        ],
      });

      const parts: unknown[] = [];
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }

      const textStart = parts.find((p: any) => p.type === "text-start");
      const textDelta = parts.find((p: any) => p.type === "text-delta");
      const textEnd = parts.find((p: any) => p.type === "text-end");
      expect(textStart).toBeDefined();
      expect(textDelta).toBeDefined();
      expect(textEnd).toBeDefined();
      expect(JSON.parse((textDelta as any).delta)).toEqual(structuredInput);

      // No tool parts emitted
      expect(parts.some((p: any) => p.type === "tool-call")).toBe(false);
      expect(parts.some((p: any) => p.type === "tool-result")).toBe(false);
    });

    it("should use native JSON schema mode without adding prompt instructions", async () => {
      const result = await model.doStream({
        prompt: basicPrompt,
        responseFormat: { type: "json" },
      });

      const requestBody = result.request?.body as {
        format?: { type?: string };
        parts?: Array<{ type: string; text?: string }>;
      };

      expect(requestBody.format?.type).toBe("json_schema");

      const hasPromptJsonInstruction = requestBody.parts?.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes("You must respond with valid JSON only"),
      );
      expect(hasPromptJsonInstruction).toBe(false);
    });

    it("should emit finish part at end of stream", async () => {
      // Set up mock to emit proper completion event
      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: (async function* () {
          yield {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-1",
                sessionID: "session-123",
                messageID: "msg-1",
                type: "text",
                text: "Hello",
              },
              delta: "Hello",
            },
          };
          yield {
            type: "session.status",
            properties: {
              sessionID: "session-123",
              status: { type: "idle" },
            },
          };
        })(),
      });

      const result = await model.doStream({
        prompt: basicPrompt,
      });

      const parts: unknown[] = [];
      const reader = result.stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }

      const finishPart = parts.find((p: any) => p.type === "finish");
      expect(finishPart).toBeDefined();
      expect((finishPart as any).finishReason).toBeDefined();
    });

    it("should subscribe before applying tool approval responses", async () => {
      const promptWithApproval: LanguageModelV3Prompt = [
        {
          role: "user",
          content: [{ type: "text", text: "Continue after approval." }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
              reason: "Looks safe",
            },
          ],
        },
      ];

      const result = await model.doStream({
        prompt: promptWithApproval,
      });

      const reader = result.stream.getReader();
      await reader.read();
      reader.releaseLock();

      const subscribeOrder =
        mockClient.event.subscribe.mock.invocationCallOrder[0];
      const replyOrder =
        mockClient.permission.reply.mock.invocationCallOrder[0];
      const promptOrder = mockClient.session.prompt.mock.invocationCallOrder[0];

      expect(subscribeOrder).toBeLessThan(replyOrder);
      expect(replyOrder).toBeLessThan(promptOrder);
    });

    it("should dedupe duplicate approval responses in stream requests", async () => {
      const promptWithDuplicateApprovals: LanguageModelV3Prompt = [
        {
          role: "user",
          content: [{ type: "text", text: "Continue after approval." }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
            },
          ],
        },
      ];

      const result = await model.doStream({
        prompt: promptWithDuplicateApprovals,
      });

      const reader = result.stream.getReader();
      await reader.read();
      reader.releaseLock();

      expect(mockClient.permission.reply).toHaveBeenCalledTimes(1);
    });

    it("should close event iterator on normal session completion", async () => {
      const completionEvents = [
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Hello",
            },
            delta: "Hello",
          },
        },
        {
          type: "session.status",
          properties: {
            sessionID: "session-123",
            status: { type: "idle" },
          },
        },
      ] as const;

      let index = 0;
      const iteratorReturn = vi
        .fn<(value?: unknown) => Promise<IteratorResult<unknown>>, [unknown?]>()
        .mockResolvedValue({ done: true, value: undefined });

      const customStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (index < completionEvents.length) {
                return Promise.resolve({
                  done: false,
                  value: completionEvents[index++],
                });
              }
              return new Promise<IteratorResult<unknown>>(() => {
                // Keep pending; the model should close via iterator.return().
              });
            },
            return: iteratorReturn,
          };
        },
      };

      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: customStream,
      });

      const result = await model.doStream({
        prompt: basicPrompt,
      });

      const reader = result.stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      expect(iteratorReturn).toHaveBeenCalled();
    });

    it("should terminate stream if prompt fails before any events are emitted", async () => {
      const iteratorReturn = vi
        .fn<() => Promise<IteratorResult<unknown>>, []>()
        .mockResolvedValue({ done: true, value: undefined });

      const hangingStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise<IteratorResult<unknown>>(() => {
                // Intentionally never resolves to emulate server silence.
              });
            },
            return: iteratorReturn,
          };
        },
      };

      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: hangingStream,
      });
      mockClient.session.prompt.mockRejectedValueOnce(
        new Error("prompt failed"),
      );

      const result = await model.doStream({
        prompt: basicPrompt,
      });

      const reader = result.stream.getReader();
      const parts = await new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for stream to close"));
        }, 500);

        (async () => {
          const streamParts: unknown[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamParts.push(value);
          }
          clearTimeout(timeout);
          resolve(streamParts);
        })().catch((error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      expect(parts[0]).toMatchObject({ type: "stream-start" });
      expect(parts.some((part: any) => part.type === "error")).toBe(true);
      expect(iteratorReturn).toHaveBeenCalled();
    });

    it("should emit actionable error when prompt resolves without data", async () => {
      const iteratorReturn = vi
        .fn<() => Promise<IteratorResult<unknown>>, []>()
        .mockResolvedValue({ done: true, value: undefined });

      const hangingStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise<IteratorResult<unknown>>(() => {
                // Intentionally never resolves to emulate server silence.
              });
            },
            return: iteratorReturn,
          };
        },
      };

      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: hangingStream,
      });
      mockClient.session.prompt.mockResolvedValueOnce({ data: undefined });

      const result = await model.doStream({
        prompt: basicPrompt,
      });

      const reader = result.stream.getReader();
      const parts = await new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for stream to close"));
        }, 500);

        (async () => {
          const streamParts: unknown[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamParts.push(value);
          }
          clearTimeout(timeout);
          resolve(streamParts);
        })().catch((error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const errorPart = parts.find((part: any) => part.type === "error") as
        | { error?: { message?: string; data?: { errorType?: string } } }
        | undefined;
      expect(errorPart).toBeDefined();
      expect(errorPart?.error?.message).toContain(
        'OpenCode returned no response data for model "anthropic/claude-3-5-sonnet-20241022"',
      );
      expect(errorPart?.error?.data).toMatchObject({
        errorType: "EmptyResponseData",
      });
      expect(iteratorReturn).toHaveBeenCalled();
    });

    it("should not flag data-style prompt results as missing data", async () => {
      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: (async function* () {
          yield {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-1",
                sessionID: "session-123",
                messageID: "msg-1",
                type: "text",
                text: "Hello",
              },
              delta: "Hello",
            },
          };
          yield {
            type: "session.idle",
            properties: {
              sessionID: "session-123",
            },
          };
        })(),
      });
      // A caller-supplied client configured with responseStyle: "data"
      // resolves session.prompt to the payload itself.
      mockClient.session.prompt.mockResolvedValueOnce({
        info: {
          id: "msg-1",
          sessionID: "session-123",
          role: "assistant",
          finish: "end_turn",
        },
        parts: [{ id: "part-1", type: "text", text: "Hello" }],
      });

      const result = await model.doStream({
        prompt: basicPrompt,
      });

      const parts: unknown[] = [];
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }

      expect(parts.some((part: any) => part.type === "error")).toBe(false);
      expect(parts.some((part: any) => part.type === "finish")).toBe(true);
    });

    it("should terminate stream when abort signal fires without incoming events", async () => {
      const iteratorReturn = vi
        .fn<() => Promise<IteratorResult<unknown>>, []>()
        .mockResolvedValue({ done: true, value: undefined });

      const hangingStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise<IteratorResult<unknown>>(() => {
                // Intentionally never resolves to emulate an idle stream.
              });
            },
            return: iteratorReturn,
          };
        },
      };

      mockClient.event.subscribe.mockResolvedValueOnce({
        stream: hangingStream,
      });
      mockClient.session.prompt.mockImplementationOnce(
        () => new Promise(() => {}),
      );

      const abortController = new AbortController();
      const result = await model.doStream({
        prompt: basicPrompt,
        abortSignal: abortController.signal,
      });

      const reader = result.stream.getReader();
      const partsPromise = new Promise<unknown[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for stream abort"));
        }, 500);

        (async () => {
          const streamParts: unknown[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamParts.push(value);
          }
          clearTimeout(timeout);
          resolve(streamParts);
        })().catch((error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      setTimeout(() => abortController.abort(), 10);
      const parts = await partsPromise;

      expect(parts[0]).toMatchObject({ type: "stream-start" });
      expect(mockClient.session.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "session-123" }),
      );
      expect(iteratorReturn).toHaveBeenCalled();
    });
  });

  describe("getSessionId", () => {
    it("should return undefined before first call", () => {
      const newModel = new OpencodeLanguageModel({
        modelId: "anthropic/claude",
        settings: {},
        clientManager: mockClientManager as unknown as OpencodeClientManager,
      });

      expect(newModel.getSessionId()).toBeUndefined();
    });

    it("should return session ID from settings", () => {
      const modelWithSession = new OpencodeLanguageModel({
        modelId: "anthropic/claude",
        settings: { sessionId: "preset-session" },
        clientManager: mockClientManager as unknown as OpencodeClientManager,
      });

      expect(modelWithSession.getSessionId()).toBe("preset-session");
    });

    it("should return session ID after first call", async () => {
      const newModel = new OpencodeLanguageModel({
        modelId: "anthropic/claude",
        settings: {},
        clientManager: mockClientManager as unknown as OpencodeClientManager,
      });

      await newModel.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
      });

      expect(newModel.getSessionId()).toBe("session-123");
    });
  });

  describe("tool handling", () => {
    it("should extract tool calls from response", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
            finish: "tool_use",
          },
          parts: [
            {
              id: "part-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "file.txt",
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "list files" }] },
        ],
      });

      const toolCall = result.content.find((c) => c.type === "tool-call");
      const toolResult = result.content.find((c) => c.type === "tool-result");

      expect(toolCall).toMatchObject({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "Bash",
      });

      expect(toolResult).toMatchObject({
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "Bash",
        result: "file.txt",
      });
    });

    it("should handle tool errors", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
          },
          parts: [
            {
              id: "part-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "error",
                input: { command: "invalid" },
                error: "Command not found",
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "run invalid" }] },
        ],
      });

      const toolResult = result.content.find((c) => c.type === "tool-result");
      expect(toolResult).toMatchObject({
        isError: true,
        result: "Command not found",
      });
    });

    it("should emit StructuredOutput tool input as text content", async () => {
      const structuredInput = {
        output: "# Hello World",
        outputType: "markdown",
      };
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
            finish: "end_turn",
          },
          parts: [
            {
              id: "part-1",
              type: "tool",
              callID: "call-so-1",
              tool: "StructuredOutput",
              state: {
                status: "completed",
                input: structuredInput,
                output: "Structured output captured successfully.",
              },
            },
            {
              id: "part-2",
              type: "step-finish",
              reason: "end_turn",
              cost: 0.001,
              tokens: {
                input: 10,
                output: 5,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "give me output" }] },
        ],
      });

      const textParts = result.content.filter((c) => c.type === "text");
      expect(textParts).toHaveLength(1);
      expect(JSON.parse((textParts[0] as { text: string }).text)).toEqual(
        structuredInput,
      );

      const toolCalls = result.content.filter((c) => c.type === "tool-call");
      const toolResults = result.content.filter(
        (c) => c.type === "tool-result",
      );
      expect(toolCalls).toHaveLength(0);
      expect(toolResults).toHaveLength(0);
    });

    it("should not affect non-StructuredOutput tool parts", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
            finish: "tool_use",
          },
          parts: [
            {
              id: "part-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "file.txt",
              },
            },
            {
              id: "part-2",
              type: "tool",
              callID: "call-so-1",
              tool: "StructuredOutput",
              state: {
                status: "completed",
                input: { result: "done" },
                output: "Structured output captured successfully.",
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "do stuff" }] },
        ],
      });

      const toolCalls = result.content.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({ toolName: "Bash" });

      const textParts = result.content.filter((c) => c.type === "text");
      expect(textParts).toHaveLength(1);
      expect(JSON.parse((textParts[0] as { text: string }).text)).toEqual({
        result: "done",
      });
    });

    it("should not emit tool-call/tool-result for error-status StructuredOutput", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
            error: { name: "StructuredOutputError" },
          },
          parts: [
            {
              id: "part-1",
              type: "tool",
              callID: "call-so-1",
              tool: "StructuredOutput",
              state: {
                status: "error",
                input: {},
                error: "Model did not produce structured output",
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "give me output" }] },
        ],
      });

      const toolCalls = result.content.filter((c) => c.type === "tool-call");
      const toolResults = result.content.filter(
        (c) => c.type === "tool-result",
      );
      expect(toolCalls).toHaveLength(0);
      expect(toolResults).toHaveLength(0);
    });

    it("should safely stringify undefined tool input", async () => {
      mockClient.session.prompt.mockResolvedValueOnce({
        data: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
            finish: "tool_use",
          },
          parts: [
            {
              id: "part-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "completed",
                input: undefined,
                output: "done",
              },
            },
          ],
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "run tool" }] },
        ],
      });

      const toolCall = result.content.find((c) => c.type === "tool-call");
      expect(toolCall).toMatchObject({
        input: "{}",
      });
    });
  });
});
