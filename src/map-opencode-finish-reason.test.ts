import { describe, it, expect } from "vitest";
import {
  mapOpencodeFinishReason,
  mapErrorToFinishReasonFromUnknown,
  hasToolCalls,
} from "./map-opencode-finish-reason.js";

const unified = (message: Parameters<typeof mapOpencodeFinishReason>[0]) =>
  mapOpencodeFinishReason(message).unified;
const unifiedFromError = (error: unknown) =>
  mapErrorToFinishReasonFromUnknown(error).unified;

describe("map-opencode-finish-reason", () => {
  describe("mapOpencodeFinishReason", () => {
    it('should return "unknown" for undefined message', () => {
      const result = mapOpencodeFinishReason(undefined);
      expect(result.unified).toBe("other");
      expect(result.raw).toBeUndefined();
    });

    it('should return "stop" for end_turn finish', () => {
      expect(unified({ finish: "end_turn" })).toBe("stop");
    });

    it('should return "stop" for stop finish', () => {
      expect(unified({ finish: "stop" })).toBe("stop");
    });

    it('should return "stop" for end finish', () => {
      expect(unified({ finish: "end" })).toBe("stop");
    });

    it('should return "length" for max_tokens finish', () => {
      expect(unified({ finish: "max_tokens" })).toBe("length");
    });

    it('should return "length" for length finish', () => {
      expect(unified({ finish: "length" })).toBe("length");
    });

    it('should return "tool-calls" for tool_use finish', () => {
      expect(unified({ finish: "tool_use" })).toBe("tool-calls");
    });

    it('should return "tool-calls" for tool_calls finish', () => {
      expect(unified({ finish: "tool_calls" })).toBe("tool-calls");
    });

    it('should return "content-filter" for content_filter finish', () => {
      expect(unified({ finish: "content_filter" })).toBe("content-filter");
    });

    it('should return "content-filter" for safety finish', () => {
      expect(unified({ finish: "safety" })).toBe("content-filter");
    });

    it('should return "error" for error finish', () => {
      expect(unified({ finish: "error" })).toBe("error");
    });

    it('should return "stop" for unknown finish values', () => {
      expect(unified({ finish: "unknown_value" })).toBe("other");
    });

    it("should be case insensitive for finish values", () => {
      expect(unified({ finish: "END_TURN" })).toBe("stop");
      expect(unified({ finish: "MAX_TOKENS" })).toBe("length");
      expect(unified({ finish: "Tool_Use" })).toBe("tool-calls");
    });

    // Error handling
    it('should return "stop" for MessageAbortedError', () => {
      expect(
        unified({
          error: { name: "MessageAbortedError" },
        }),
      ).toBe("stop");
    });

    it('should return "length" for MessageOutputLengthError', () => {
      expect(
        unified({
          error: { name: "MessageOutputLengthError" },
        }),
      ).toBe("length");
    });

    it('should return "length" for ContextOverflowError', () => {
      expect(
        unified({
          error: { name: "ContextOverflowError" },
        }),
      ).toBe("length");
    });

    it('should return "error" for StructuredOutputError', () => {
      expect(
        unified({
          error: { name: "StructuredOutputError" },
        }),
      ).toBe("error");
    });

    it('should return "error" for ProviderAuthError', () => {
      expect(
        unified({
          error: { name: "ProviderAuthError" },
        }),
      ).toBe("error");
    });

    it('should return "error" for APIError', () => {
      expect(
        unified({
          error: { name: "APIError" },
        }),
      ).toBe("error");
    });

    it('should return "error" for UnknownError', () => {
      expect(
        unified({
          error: { name: "UnknownError" },
        }),
      ).toBe("error");
    });

    it('should return "error" for unknown error types', () => {
      expect(
        unified({
          error: { name: "SomeOtherError" },
        }),
      ).toBe("error");
    });

    it("should prioritize error over finish", () => {
      expect(
        unified({
          error: { name: "APIError" },
          finish: "end_turn",
        }),
      ).toBe("error");
    });

    it('should return "stop" for message without error or finish', () => {
      expect(unified({})).toBe("stop");
    });
  });

  describe("mapErrorToFinishReasonFromUnknown", () => {
    it('should return "stop" for abort errors', () => {
      const error = { name: "AbortError" };
      expect(unifiedFromError(error)).toBe("stop");
    });

    it('should return "stop" for MessageAbortedError', () => {
      const error = { name: "MessageAbortedError" };
      expect(unifiedFromError(error)).toBe("stop");
    });

    it('should return "length" for output length errors', () => {
      const error = { name: "MessageOutputLengthError" };
      expect(unifiedFromError(error)).toBe("length");
    });

    it('should return "length" for max tokens error message', () => {
      const error = { message: "Max tokens exceeded" };
      expect(unifiedFromError(error)).toBe("length");
    });

    it('should return "error" for other errors', () => {
      const error = { name: "NetworkError", message: "Connection failed" };
      expect(unifiedFromError(error)).toBe("error");
    });

    it('should return "error" for null', () => {
      expect(unifiedFromError(null)).toBe("error");
    });
  });

  describe("hasToolCalls", () => {
    it("should return true when parts contain tool type", () => {
      const parts = [{ type: "text" }, { type: "tool" }, { type: "text" }];
      expect(hasToolCalls(parts)).toBe(true);
    });

    it("should return false when parts have no tool type", () => {
      const parts = [
        { type: "text" },
        { type: "reasoning" },
        { type: "step-finish" },
      ];
      expect(hasToolCalls(parts)).toBe(false);
    });

    it("should return false for empty array", () => {
      expect(hasToolCalls([])).toBe(false);
    });

    it("should handle multiple tool parts", () => {
      const parts = [{ type: "tool" }, { type: "tool" }];
      expect(hasToolCalls(parts)).toBe(true);
    });
  });
});
