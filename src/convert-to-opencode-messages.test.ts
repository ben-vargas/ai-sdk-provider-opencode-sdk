import { describe, it, expect, vi } from "vitest";
import {
  convertToOpencodeMessages,
  extractTextFromParts,
} from "./convert-to-opencode-messages.js";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { Logger } from "./types.js";

describe("convert-to-opencode-messages", () => {
  describe("convertToOpencodeMessages", () => {
    describe("system messages", () => {
      it("should extract system message as systemPrompt", () => {
        const prompt: LanguageModelV3Prompt = [
          { role: "system", content: "You are a helpful assistant." },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.systemPrompt).toBe("You are a helpful assistant.");
        expect(result.parts).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
      });

      it("should concatenate multiple system messages", () => {
        const prompt: LanguageModelV3Prompt = [
          { role: "system", content: "First instruction." },
          { role: "system", content: "Second instruction." },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.systemPrompt).toBe(
          "First instruction.\n\nSecond instruction.",
        );
      });
    });

    describe("user messages", () => {
      it("should convert text parts", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [{ type: "text", text: "Hello, world!" }],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toEqual({
          type: "text",
          text: "Hello, world!",
        });
      });

      it("should convert multiple text parts", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              { type: "text", text: "First part." },
              { type: "text", text: "Second part." },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(2);
      });

      it("should convert base64 file parts to data URLs", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: "SGVsbG8gV29ybGQ=",
                mediaType: "image/png",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toMatchObject({
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,SGVsbG8gV29ybGQ=",
        });
      });

      it("should pass through data URLs unchanged", () => {
        const dataUrl = "data:image/png;base64,SGVsbG8gV29ybGQ=";
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: dataUrl,
                mediaType: "image/png",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts[0]).toMatchObject({
          type: "file",
          url: dataUrl,
        });
      });

      it("should warn about remote URLs", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: "https://example.com/image.png",
                mediaType: "image/png",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(0);
        expect(result.warnings.some((w) => w.includes("Remote URLs"))).toBe(
          true,
        );
      });

      it("should convert Uint8Array to base64 data URL", () => {
        const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data,
                mediaType: "image/png",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toMatchObject({
          type: "file",
          mime: "image/png",
        });
        expect((result.parts[0] as { url: string }).url).toMatch(
          /^data:image\/png;base64,/,
        );
      });

      it("should include filename when provided", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: "SGVsbG8=",
                mediaType: "image/png",
                filename: "test.png",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts[0]).toMatchObject({
          filename: "test.png",
        });
      });

      it("should warn about unknown part types", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [{ type: "unknown" as "text", text: "test" }],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.warnings.some((w) => w.includes("Unknown"))).toBe(true);
      });
    });

    describe("assistant messages", () => {
      it("should convert assistant text as synthetic context", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "assistant",
            content: [{ type: "text", text: "I can help with that." }],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toMatchObject({
          type: "text",
          text: "[Assistant]: I can help with that.",
          synthetic: true,
        });
      });

      it("should convert reasoning parts as synthetic context", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "Let me think about this...",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toMatchObject({
          type: "text",
          text: "[Reasoning]: Let me think about this...",
          synthetic: true,
        });
      });

      it("should convert tool calls as synthetic context", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-123",
                toolName: "search",
                input: { query: "test" },
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toMatchObject({
          type: "text",
          synthetic: true,
        });
        expect((result.parts[0] as { text: string }).text).toContain(
          "[Tool Call: search]",
        );
      });

      it("should warn about file parts in assistant messages", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "assistant",
            content: [
              {
                type: "file",
                data: "test",
                mediaType: "image/png",
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(
          result.warnings.some((w) => w.includes("File parts in assistant")),
        ).toBe(true);
      });
    });

    describe("tool messages", () => {
      it("should convert tool results as synthetic context", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-123",
                toolName: "search",
                output: { type: "text", value: "Search results..." },
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect(result.parts).toHaveLength(1);
        expect(result.parts[0]).toMatchObject({
          type: "text",
          synthetic: true,
        });
        expect((result.parts[0] as { text: string }).text).toContain(
          "[Tool Result: search]",
        );
        expect(
          result.warnings.some((w) => w.includes("Tool results in prompts")),
        ).toBe(true);
      });

      it("should format JSON tool results", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-123",
                toolName: "getData",
                output: { type: "json", value: { key: "value" } },
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect((result.parts[0] as { text: string }).text).toContain('"key"');
      });

      it("should format error tool results", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-123",
                toolName: "failing",
                output: { type: "error-text", value: "Something went wrong" },
              },
            ],
          },
        ];

        const result = convertToOpencodeMessages(prompt);

        expect((result.parts[0] as { text: string }).text).toContain("Error:");
      });
    });

    describe("JSON mode", () => {
      it("should add JSON mode instruction", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [{ type: "text", text: "Give me data" }],
          },
        ];

        const result = convertToOpencodeMessages(prompt, {
          mode: { type: "object-json" },
        });

        expect(result.parts).toHaveLength(2);
        expect((result.parts[1] as { text: string }).text).toContain(
          "valid JSON",
        );
      });

      it("should include schema in JSON mode instruction", () => {
        const schema = {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        };

        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [{ type: "text", text: "Give me data" }],
          },
        ];

        const result = convertToOpencodeMessages(prompt, {
          mode: { type: "object-json", schema },
        });

        expect((result.parts[1] as { text: string }).text).toContain("schema");
        expect((result.parts[1] as { text: string }).text).toContain("name");
      });
    });

    describe("logging", () => {
      it("should log warnings when logger provided", () => {
        const logger: Logger = {
          warn: vi.fn(),
          error: vi.fn(),
        };

        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: "https://example.com/image.png",
                mediaType: "image/png",
              },
            ],
          },
        ];

        convertToOpencodeMessages(prompt, { logger });

        expect(logger.warn).toHaveBeenCalled();
      });

      it("should not log when logger is false", () => {
        const prompt: LanguageModelV3Prompt = [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: "https://example.com/image.png",
                mediaType: "image/png",
              },
            ],
          },
        ];

        // Should not throw
        const result = convertToOpencodeMessages(prompt, { logger: false });
        expect(result.warnings.length).toBeGreaterThan(0);
      });
    });
  });

  describe("extractTextFromParts", () => {
    it("should extract text from text parts", () => {
      const parts = [
        { type: "text" as const, text: "Hello" },
        { type: "text" as const, text: "World" },
      ];

      const result = extractTextFromParts(parts);

      expect(result).toBe("Hello\nWorld");
    });

    it("should skip non-text parts", () => {
      const parts = [
        { type: "text" as const, text: "Hello" },
        { type: "file" as const, mime: "image/png", url: "data:..." },
        { type: "text" as const, text: "World" },
      ];

      const result = extractTextFromParts(parts);

      expect(result).toBe("Hello\nWorld");
    });

    it("should return empty string for empty array", () => {
      const result = extractTextFromParts([]);
      expect(result).toBe("");
    });

    it("should return empty string for array with no text parts", () => {
      const parts = [
        { type: "file" as const, mime: "image/png", url: "data:..." },
      ];

      const result = extractTextFromParts(parts);
      expect(result).toBe("");
    });
  });
});
