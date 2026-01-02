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
          body: expect.objectContaining({
            system: "You are helpful.",
          }),
        }),
      );
    });

    it("should include model info in request", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(mockClient.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: {
              providerID: "anthropic",
              modelID: "claude-3-5-sonnet-20241022",
            },
          }),
        }),
      );
    });

    it("should include request body in response", async () => {
      const result = await model.doGenerate({
        prompt: basicPrompt,
      });

      expect(result.request?.body).toBeDefined();
    });

    it("should handle JSON mode", async () => {
      await model.doGenerate({
        prompt: basicPrompt,
        responseFormat: { type: "json" },
      });

      // Should add JSON instruction to parts
      expect(mockClient.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("JSON"),
              }),
            ]),
          }),
        }),
      );
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
  });
});
