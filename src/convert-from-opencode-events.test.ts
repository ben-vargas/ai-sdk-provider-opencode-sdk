import { describe, it, expect, vi } from "vitest";
import {
  createStreamState,
  isEventForSession,
  isSessionComplete,
  convertEventToStreamParts,
  createFinishParts,
  createStreamStartPart,
  type EventMessagePartUpdated,
  type EventSessionStatus,
  type EventSessionIdle,
  type EventPermissionAsked,
  type EventQuestionAsked,
  type TextPart,
  type ReasoningPart,
  type FilePart,
  type ToolPart,
  type StepFinishPart,
} from "./convert-from-opencode-events.js";
import type { Logger } from "./types.js";

describe("convert-from-opencode-events", () => {
  describe("createStreamState", () => {
    it("should create initial stream state", () => {
      const state = createStreamState();

      expect(state).toEqual({
        textPartId: undefined,
        textStarted: false,
        reasoningPartId: undefined,
        reasoningStarted: false,
        toolStates: expect.any(Map),
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
        messageRoles: expect.any(Map),
        permissionRequests: expect.any(Set),
        questionRequests: expect.any(Set),
      });
    });
  });

  describe("isEventForSession", () => {
    it("should return true when part sessionID matches", () => {
      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "msg-1",
            type: "text",
            text: "Hello",
          },
        },
      };

      expect(isEventForSession(event, "session-123")).toBe(true);
    });

    it("should return false when part sessionID does not match", () => {
      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-other",
            messageID: "msg-1",
            type: "text",
            text: "Hello",
          },
        },
      };

      expect(isEventForSession(event, "session-123")).toBe(false);
    });

    it("should check message info sessionID", () => {
      const event = {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
          },
        },
      };

      expect(isEventForSession(event, "session-123")).toBe(true);
    });

    it("should check direct sessionID property", () => {
      const event: EventSessionIdle = {
        type: "session.idle",
        properties: {
          sessionID: "session-123",
        },
      };

      expect(isEventForSession(event, "session-123")).toBe(true);
    });

    it("should return false for events without sessionID", () => {
      const event = {
        type: "unknown.event",
        properties: {},
      };

      expect(isEventForSession(event, "session-123")).toBe(false);
    });
  });

  describe("isSessionComplete", () => {
    it("should return true for session.status with idle status", () => {
      const event: EventSessionStatus = {
        type: "session.status",
        properties: {
          sessionID: "session-123",
          status: { type: "idle" },
        },
      };

      expect(isSessionComplete(event, "session-123")).toBe(true);
    });

    it("should return false for session.status with busy status", () => {
      const event: EventSessionStatus = {
        type: "session.status",
        properties: {
          sessionID: "session-123",
          status: { type: "busy" },
        },
      };

      expect(isSessionComplete(event, "session-123")).toBe(false);
    });

    it("should return false for different session", () => {
      const event: EventSessionStatus = {
        type: "session.status",
        properties: {
          sessionID: "session-other",
          status: { type: "idle" },
        },
      };

      expect(isSessionComplete(event, "session-123")).toBe(false);
    });

    it("should return true for session.idle event", () => {
      const event: EventSessionIdle = {
        type: "session.idle",
        properties: {
          sessionID: "session-123",
        },
      };

      expect(isSessionComplete(event, "session-123")).toBe(true);
    });

    it("should return false for other event types", () => {
      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "msg-1",
            type: "text",
            text: "Hello",
          },
        },
      };

      expect(isSessionComplete(event, "session-123")).toBe(false);
    });
  });

  describe("convertEventToStreamParts", () => {
    describe("text parts", () => {
      it("should emit text-start and text-delta for new text", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Hello",
            } as TextPart,
            delta: "Hello",
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(2);
        expect(parts[0]).toEqual({ type: "text-start", id: "part-1" });
        expect(parts[1]).toEqual({
          type: "text-delta",
          id: "part-1",
          delta: "Hello",
        });
      });

      it("should only emit text-delta for subsequent updates", () => {
        const state = createStreamState();
        state.textStarted = true;
        state.textPartId = "part-1";
        state.lastTextContent = "Hello";

        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Hello World",
            } as TextPart,
            delta: " World",
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(1);
        expect(parts[0]).toEqual({
          type: "text-delta",
          id: "part-1",
          delta: " World",
        });
      });

      it("should skip synthetic text parts", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Context",
              synthetic: true,
            } as TextPart,
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(0);
      });

      it("should skip ignored text parts", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Ignored",
              ignored: true,
            } as TextPart,
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(0);
      });

      it("should calculate delta from full text when delta not provided", () => {
        const state = createStreamState();
        state.textStarted = true;
        state.textPartId = "part-1";
        state.lastTextContent = "Hello";

        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "text",
              text: "Hello World",
            } as TextPart,
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(1);
        expect(parts[0]).toEqual({
          type: "text-delta",
          id: "part-1",
          delta: " World",
        });
      });
    });

    describe("reasoning parts", () => {
      it("should emit reasoning-start and reasoning-delta", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "reasoning",
              text: "Thinking...",
            } as ReasoningPart,
            delta: "Thinking...",
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(2);
        expect(parts[0]).toEqual({ type: "reasoning-start", id: "part-1" });
        expect(parts[1]).toEqual({
          type: "reasoning-delta",
          id: "part-1",
          delta: "Thinking...",
        });
      });
    });

    describe("tool parts", () => {
      it("should emit tool-input-start for pending tool", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "pending",
                input: { command: "ls" },
                raw: '{"command":"ls"}',
              },
            } as ToolPart,
          },
        };

        const parts = convertEventToStreamParts(event, state);

        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({
          type: "tool-input-start",
          id: "call-1",
          toolName: "Bash",
          providerExecuted: true,
        });
      });

      it("should emit tool-call and tool-result for completed tool", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "file1.txt\nfile2.txt",
                title: "List files",
                time: { start: 1000, end: 2000 },
              },
            } as ToolPart,
          },
        };

        const parts = convertEventToStreamParts(event, state);

        // Should emit: tool-input-start, tool-input-end, tool-call, tool-result
        expect(parts.some((p) => p.type === "tool-input-start")).toBe(true);
        expect(parts.some((p) => p.type === "tool-input-end")).toBe(true);
        expect(parts.some((p) => p.type === "tool-call")).toBe(true);
        expect(parts.some((p) => p.type === "tool-result")).toBe(true);

        const toolCall = parts.find((p) => p.type === "tool-call");
        expect(toolCall).toMatchObject({
          toolCallId: "call-1",
          toolName: "Bash",
          providerExecuted: true,
        });

        const toolResult = parts.find((p) => p.type === "tool-result");
        expect(toolResult).toMatchObject({
          toolCallId: "call-1",
          toolName: "Bash",
          result: "file1.txt\nfile2.txt",
          isError: false,
        });
      });

      it("should emit error result for failed tool", () => {
        const state = createStreamState();
        const logger: Logger = { warn: vi.fn(), error: vi.fn() };

        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "error",
                input: { command: "invalid" },
                error: "Command not found",
                time: { start: 1000, end: 2000 },
              },
            } as ToolPart,
          },
        };

        const parts = convertEventToStreamParts(event, state, logger);

        const toolResult = parts.find((p) => p.type === "tool-result");
        expect(toolResult).toMatchObject({
          result: "Command not found",
          isError: true,
        });

        expect(logger.warn).toHaveBeenCalled();
      });

      it("should not duplicate emissions for same tool", () => {
        const state = createStreamState();

        // First event - pending
        const event1: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "pending",
                input: { command: "ls" },
                raw: "{}",
              },
            } as ToolPart,
          },
        };

        convertEventToStreamParts(event1, state);

        // Second event - completed
        const event2: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "result",
                title: "List",
                time: { start: 1000, end: 2000 },
              },
            } as ToolPart,
          },
        };

        const parts2 = convertEventToStreamParts(event2, state);

        // Should not emit tool-input-start again
        expect(
          parts2.filter((p) => p.type === "tool-input-start"),
        ).toHaveLength(0);
      });

      it("should emit running input delta only when input changes", () => {
        const state = createStreamState();

        const runningEvent = (input: Record<string, unknown>) =>
          ({
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-1",
                sessionID: "session-123",
                messageID: "msg-1",
                type: "tool",
                callID: "call-1",
                tool: "Bash",
                state: {
                  status: "running",
                  input,
                  time: { start: 1000 },
                },
              } as ToolPart,
            },
          }) satisfies EventMessagePartUpdated;

        const parts1 = convertEventToStreamParts(
          runningEvent({ command: "ls" }),
          state,
        );
        const deltas1 = parts1.filter((p) => p.type === "tool-input-delta");
        expect(deltas1).toHaveLength(1);
        expect((deltas1[0] as any).delta).toBe(JSON.stringify({ command: "ls" }));

        const parts2 = convertEventToStreamParts(
          runningEvent({ command: "ls" }),
          state,
        );
        const deltas2 = parts2.filter((p) => p.type === "tool-input-delta");
        expect(deltas2).toHaveLength(0);

        const parts3 = convertEventToStreamParts(
          runningEvent({ command: "ls -la" }),
          state,
        );
        const deltas3 = parts3.filter((p) => p.type === "tool-input-delta");
        expect(deltas3).toHaveLength(1);
      });

      it("should dedupe attachment file parts across repeated completed events", () => {
        const state = createStreamState();

        const makeCompletedEvent = (
          attachmentIds: string[],
        ): EventMessagePartUpdated => ({
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Read",
              state: {
                status: "completed",
                input: { file: "README.md" },
                output: "ok",
                title: "Read file",
                time: { start: 1000, end: 2000 },
                attachments: attachmentIds.map((id) => ({
                  id,
                  sessionID: "session-123",
                  messageID: "msg-1",
                  type: "file" as const,
                  mime: "text/plain",
                  url: "data:text/plain;base64,SGVsbG8=",
                  filename: `${id}.txt`,
                })),
              },
            } as ToolPart,
          },
        });

        const parts1 = convertEventToStreamParts(
          makeCompletedEvent(["file-1"]),
          state,
        );
        const files1 = parts1.filter((p) => p.type === "file");
        expect(files1).toHaveLength(1);

        const parts2 = convertEventToStreamParts(
          makeCompletedEvent(["file-1"]),
          state,
        );
        const files2 = parts2.filter((p) => p.type === "file");
        expect(files2).toHaveLength(0);

        const parts3 = convertEventToStreamParts(
          makeCompletedEvent(["file-1", "file-2"]),
          state,
        );
        const files3 = parts3.filter((p) => p.type === "file");
        expect(files3).toHaveLength(1);
      });

      it("should safely handle non-serializable tool input", () => {
        const state = createStreamState();
        const logger: Logger = {
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        };

        const circular: Record<string, unknown> = {};
        circular.self = circular;

        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "tool",
              callID: "call-1",
              tool: "Bash",
              state: {
                status: "running",
                input: circular,
                time: { start: 1000 },
              },
            } as ToolPart,
          },
        };

        const parts = convertEventToStreamParts(event, state, logger);
        const delta = parts.find((p) => p.type === "tool-input-delta") as
          | { delta?: string }
          | undefined;
        expect(delta?.delta).toBe("{}");
        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe("step-finish parts", () => {
      it("should accumulate usage from step-finish", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "step-finish",
              reason: "end_turn",
              cost: 0.01,
              tokens: {
                input: 100,
                output: 50,
                reasoning: 25,
                cache: { read: 10, write: 5 },
              },
            } as StepFinishPart,
          },
        };

        convertEventToStreamParts(event, state);

        expect(state.usage).toEqual({
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 25,
          cachedInputTokens: 10,
          cachedWriteTokens: 5,
          totalCost: 0.01,
        });
      });

      it("should accumulate multiple step-finish parts", () => {
        const state = createStreamState();

        const event1: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "step-finish",
              reason: "tool_use",
              cost: 0.01,
              tokens: {
                input: 100,
                output: 50,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            } as StepFinishPart,
          },
        };

        const event2: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-2",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "step-finish",
              reason: "end_turn",
              cost: 0.02,
              tokens: {
                input: 200,
                output: 100,
                reasoning: 50,
                cache: { read: 20, write: 10 },
              },
            } as StepFinishPart,
          },
        };

        convertEventToStreamParts(event1, state);
        convertEventToStreamParts(event2, state);

        expect(state.usage).toEqual({
          inputTokens: 300,
          outputTokens: 150,
          reasoningTokens: 50,
          cachedInputTokens: 20,
          cachedWriteTokens: 10,
          totalCost: 0.03,
        });
      });
    });

    describe("unknown events", () => {
      it("should return empty array for message.updated", () => {
        const state = createStreamState();
        const event = {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-123",
              role: "assistant",
            },
          },
        };

        const parts = convertEventToStreamParts(event as any, state);

        expect(parts).toHaveLength(0);
      });

      it("should log unknown event types when debug enabled", () => {
        const state = createStreamState();
        const logger: Logger = {
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        };

        const event = {
          type: "custom.event",
          properties: {},
        };

        convertEventToStreamParts(event as any, state, logger);

        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining("custom.event"),
        );
      });
    });

    describe("permission events", () => {
      it("should emit tool-approval-request for permission.asked", () => {
        const state = createStreamState();
        const event: EventPermissionAsked = {
          type: "permission.asked",
          properties: {
            id: "approval-1",
            sessionID: "session-123",
            permission: "bash",
            patterns: ["npm test"],
            tool: {
              messageID: "msg-1",
              callID: "call-1",
            },
          },
        };

        const parts = convertEventToStreamParts(event, state);
        expect(parts).toEqual([
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "call-1",
            providerMetadata: {
              opencode: {
                sessionId: "session-123",
                permission: "bash",
                patterns: ["npm test"],
              },
            },
          },
        ]);
      });
    });

    describe("question events", () => {
      it("should emit an error for question.asked (once per question id)", () => {
        const state = createStreamState();
        const logger: Logger = {
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        };

        const event: EventQuestionAsked = {
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID: "session-123",
            questions: [
              {
                header: "Deploy",
                question: "Pick deployment strategy",
                options: [
                  { label: "Blue/Green", description: "Safer rollout" },
                  { label: "In-place", description: "Faster" },
                ],
              },
            ],
          },
        };

        const parts1 = convertEventToStreamParts(event, state, logger);
        expect(parts1).toHaveLength(1);
        expect(parts1[0]).toMatchObject({ type: "error" });
        expect(logger.warn).toHaveBeenCalled();

        const parts2 = convertEventToStreamParts(event, state, logger);
        expect(parts2).toHaveLength(0);
      });
    });

    describe("file parts", () => {
      it("should emit file parts for data URLs", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "file-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "file",
              mime: "text/plain",
              url: "data:text/plain;base64,SGVsbG8=",
            } as FilePart,
          },
        };

        const parts = convertEventToStreamParts(event, state);
        expect(parts).toEqual([
          {
            type: "file",
            mediaType: "text/plain",
            data: "SGVsbG8=",
          },
        ]);
      });

      it("should ignore malformed non-base64 data URLs without throwing", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "file-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "file",
              mime: "text/plain",
              url: "data:text/plain,%ZZ",
            } as FilePart,
          },
        };

        expect(() => convertEventToStreamParts(event, state)).not.toThrow();
        expect(convertEventToStreamParts(event, state)).toEqual([]);
      });

      it("should handle data URLs with parameters before base64", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "file-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "file",
              mime: "text/plain",
              url: "data:text/plain;charset=utf-8;base64,SGVsbG8=",
            } as FilePart,
          },
        };

        const parts = convertEventToStreamParts(event, state);
        expect(parts).toEqual([
          {
            type: "file",
            mediaType: "text/plain",
            data: "SGVsbG8=",
          },
        ]);
      });

      it("should not emit duplicate document sources for local files with source metadata", () => {
        const state = createStreamState();
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: "file-1",
              sessionID: "session-123",
              messageID: "msg-1",
              type: "file",
              mime: "text/plain",
              filename: "README.md",
              url: "/workspace/README.md",
              source: {
                type: "file",
                path: "/workspace/README.md",
              },
            } as FilePart,
          },
        };

        const parts = convertEventToStreamParts(event, state);
        const documentSources = parts.filter(
          (p) => p.type === "source" && p.sourceType === "document",
        );
        expect(documentSources).toHaveLength(1);
      });
    });
  });

  describe("createFinishParts", () => {
    it("should close text if open", () => {
      const state = createStreamState();
      state.textStarted = true;
      state.textPartId = "text-1";

      const parts = createFinishParts(
        state,
        { unified: "stop", raw: undefined },
        "session-123",
      );

      expect(parts.some((p) => p.type === "text-end")).toBe(true);
    });

    it("should close reasoning if open", () => {
      const state = createStreamState();
      state.reasoningStarted = true;
      state.reasoningPartId = "reason-1";

      const parts = createFinishParts(
        state,
        { unified: "stop", raw: undefined },
        "session-123",
      );

      expect(parts.some((p) => p.type === "reasoning-end")).toBe(true);
    });

    it("should emit finish with usage and metadata", () => {
      const state = createStreamState();
      state.usage = {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 25,
        cachedInputTokens: 10,
        cachedWriteTokens: 5,
        totalCost: 0.01,
      };

      const parts = createFinishParts(
        state,
        { unified: "stop", raw: undefined },
        "session-123",
      );

      const finishPart = parts.find((p) => p.type === "finish");
      expect(finishPart).toMatchObject({
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 115,
            noCache: 100,
            cacheRead: 10,
            cacheWrite: 5,
          },
          outputTokens: {
            total: 50,
            reasoning: 25,
          },
        },
        providerMetadata: {
          opencode: {
            sessionId: "session-123",
            cost: 0.01,
          },
        },
      });
    });

    it("should handle zero usage values", () => {
      const state = createStreamState();

      const parts = createFinishParts(
        state,
        { unified: "stop", raw: undefined },
        "session-123",
      );

      const finishPart = parts.find((p) => p.type === "finish");
      expect(finishPart).toMatchObject({
        type: "finish",
        usage: {
          inputTokens: {
            total: 0,
            noCache: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: {
            total: 0,
          },
        },
      });
    });
  });

  describe("createStreamStartPart", () => {
    it("should create stream-start with empty warnings", () => {
      const part = createStreamStartPart([]);

      expect(part).toEqual({
        type: "stream-start",
        warnings: [],
      });
    });

    it("should convert warnings to CallWarning format", () => {
      const part = createStreamStartPart([
        "Temperature not supported",
        "TopP not supported",
      ]);

      expect(part).toEqual({
        type: "stream-start",
        warnings: [
          { type: "other", message: "Temperature not supported" },
          { type: "other", message: "TopP not supported" },
        ],
      });
    });
  });

  describe("message role tracking", () => {
    it("should track message roles from message.updated events", () => {
      const state = createStreamState();
      const event = {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-1",
            sessionID: "session-123",
            role: "assistant",
          },
        },
      };

      convertEventToStreamParts(event as any, state);

      expect(state.messageRoles.get("msg-1")).toBe("assistant");
    });

    it("should track user message roles", () => {
      const state = createStreamState();
      const event = {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-user-1",
            sessionID: "session-123",
            role: "user",
          },
        },
      };

      convertEventToStreamParts(event as any, state);

      expect(state.messageRoles.get("msg-user-1")).toBe("user");
    });
  });

  describe("user message filtering", () => {
    it("should filter out parts from user messages", () => {
      const state = createStreamState();
      // First, register the user message
      state.messageRoles.set("user-msg-1", "user");

      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "user-msg-1", // User message ID
            type: "text",
            text: "User prompt that should be filtered",
          } as TextPart,
          delta: "User prompt that should be filtered",
        },
      };

      const parts = convertEventToStreamParts(event, state);

      // Should return empty - user messages are filtered
      expect(parts).toHaveLength(0);
    });

    it("should process parts from assistant messages", () => {
      const state = createStreamState();
      // Register an assistant message
      state.messageRoles.set("assistant-msg-1", "assistant");

      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "assistant-msg-1", // Assistant message ID
            type: "text",
            text: "Assistant response",
          } as TextPart,
          delta: "Assistant response",
        },
      };

      const parts = convertEventToStreamParts(event, state);

      // Should process assistant messages
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "text-start", id: "part-1" });
      expect(parts[1]).toEqual({
        type: "text-delta",
        id: "part-1",
        delta: "Assistant response",
      });
    });

    it("should process parts from unknown messages (role not yet tracked)", () => {
      const state = createStreamState();
      // No message role registered yet

      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "unknown-msg-1", // Role not tracked
            type: "text",
            text: "Unknown message",
          } as TextPart,
          delta: "Unknown message",
        },
      };

      const parts = convertEventToStreamParts(event, state);

      // Should process unknown messages (could be assistant before message.updated arrives)
      expect(parts).toHaveLength(2);
    });
  });

  describe("session.diff event", () => {
    it("should return empty array for session.diff events", () => {
      const state = createStreamState();
      const event = {
        type: "session.diff",
        properties: {
          sessionID: "session-123",
          diff: [{ path: "file.ts", additions: 10, deletions: 5 }],
        },
      };

      const parts = convertEventToStreamParts(event as any, state);

      expect(parts).toHaveLength(0);
    });

    it("should not log session.diff as unknown event type", () => {
      const state = createStreamState();
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const event = {
        type: "session.diff",
        properties: {
          sessionID: "session-123",
          diff: [],
        },
      };

      convertEventToStreamParts(event as any, state, logger);

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe("step-start parts", () => {
    it("should return empty array for step-start parts", () => {
      const state = createStreamState();
      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "msg-1",
            type: "step-start",
            snapshot: "some-snapshot-id",
          } as any,
        },
      };

      const parts = convertEventToStreamParts(event, state);

      expect(parts).toHaveLength(0);
    });

    it("should not log step-start as unknown part type", () => {
      const state = createStreamState();
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const event: EventMessagePartUpdated = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-123",
            messageID: "msg-1",
            type: "step-start",
          } as any,
        },
      };

      convertEventToStreamParts(event, state, logger);

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe("known v2 events and parts", () => {
    it("should not log known v2 event types as unknown", () => {
      const state = createStreamState();
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const knownEvents = [
        { type: "question.replied", properties: { sessionID: "session-123" } },
        { type: "question.rejected", properties: { sessionID: "session-123" } },
        { type: "project.updated", properties: {} },
        { type: "server.instance.disposed", properties: {} },
        { type: "global.disposed", properties: {} },
        { type: "worktree.ready", properties: {} },
        { type: "worktree.failed", properties: {} },
        { type: "mcp.tools.changed", properties: {} },
      ];

      for (const event of knownEvents) {
        const parts = convertEventToStreamParts(event as any, state, logger);
        expect(parts).toHaveLength(0);
      }

      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("should not log known v2 part types as unknown", () => {
      const state = createStreamState();
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const knownPartTypes = [
        "subtask",
        "snapshot",
        "patch",
        "agent",
        "retry",
        "compaction",
      ];

      for (const partType of knownPartTypes) {
        const event: EventMessagePartUpdated = {
          type: "message.part.updated",
          properties: {
            part: {
              id: `part-${partType}`,
              sessionID: "session-123",
              messageID: "msg-1",
              type: partType,
            } as any,
          },
        };

        const parts = convertEventToStreamParts(event, state, logger);
        expect(parts).toHaveLength(0);
      }

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });
});
