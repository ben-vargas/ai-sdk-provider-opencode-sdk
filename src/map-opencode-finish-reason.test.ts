import { describe, it, expect } from "vitest";
import {
  mapOpencodeFinishReason,
  mapErrorToFinishReasonFromUnknown,
  hasToolCalls,
} from "./map-opencode-finish-reason.js";

describe("map-opencode-finish-reason", () => {
  describe("mapOpencodeFinishReason", () => {
    it('should return "unknown" for undefined message', () => {
      expect(mapOpencodeFinishReason(undefined)).toEqual({
        unified: "other",
        raw: undefined,
      });
    });

    it('should return "stop" for end_turn finish', () => {
      expect(mapOpencodeFinishReason({ finish: "end_turn" })).toEqual({
        unified: "stop",
        raw: "end_turn",
      });
    });

    it('should return "stop" for stop finish', () => {
      expect(mapOpencodeFinishReason({ finish: "stop" })).toEqual({
        unified: "stop",
        raw: "stop",
      });
    });

    it('should return "stop" for end finish', () => {
      expect(mapOpencodeFinishReason({ finish: "end" })).toEqual({
        unified: "stop",
        raw: "end",
      });
    });

    it('should return "length" for max_tokens finish', () => {
      expect(mapOpencodeFinishReason({ finish: "max_tokens" })).toEqual({
        unified: "length",
        raw: "max_tokens",
      });
    });

    it('should return "length" for length finish', () => {
      expect(mapOpencodeFinishReason({ finish: "length" })).toEqual({
        unified: "length",
        raw: "length",
      });
    });

    it('should return "tool-calls" for tool_use finish', () => {
      expect(mapOpencodeFinishReason({ finish: "tool_use" })).toEqual({
        unified: "tool-calls",
        raw: "tool_use",
      });
    });

    it('should return "tool-calls" for tool_calls finish', () => {
      expect(mapOpencodeFinishReason({ finish: "tool_calls" })).toEqual({
        unified: "tool-calls",
        raw: "tool_calls",
      });
    });

    it('should return "content-filter" for content_filter finish', () => {
      expect(mapOpencodeFinishReason({ finish: "content_filter" })).toEqual({
        unified: "content-filter",
        raw: "content_filter",
      });
    });

    it('should return "content-filter" for safety finish', () => {
      expect(mapOpencodeFinishReason({ finish: "safety" })).toEqual({
        unified: "content-filter",
        raw: "safety",
      });
    });

    it('should return "error" for error finish', () => {
      expect(mapOpencodeFinishReason({ finish: "error" })).toEqual({
        unified: "error",
        raw: "error",
      });
    });

    it('should return "stop" for unknown finish values', () => {
      expect(mapOpencodeFinishReason({ finish: "unknown_value" })).toEqual({
        unified: "stop",
        raw: "unknown_value",
      });
    });

    it("should be case insensitive for finish values", () => {
      expect(mapOpencodeFinishReason({ finish: "END_TURN" })).toEqual({
        unified: "stop",
        raw: "END_TURN",
      });
      expect(mapOpencodeFinishReason({ finish: "MAX_TOKENS" })).toEqual({
        unified: "length",
        raw: "MAX_TOKENS",
      });
      expect(mapOpencodeFinishReason({ finish: "Tool_Use" })).toEqual({
        unified: "tool-calls",
        raw: "Tool_Use",
      });
    });

    // Error handling
    it('should return "stop" for MessageAbortedError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "MessageAbortedError" },
        }),
      ).toEqual({ unified: "stop", raw: "MessageAbortedError" });
    });

    it('should return "length" for MessageOutputLengthError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "MessageOutputLengthError" },
        }),
      ).toEqual({ unified: "length", raw: "MessageOutputLengthError" });
    });

    it('should return "error" for ProviderAuthError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "ProviderAuthError" },
        }),
      ).toEqual({ unified: "error", raw: "ProviderAuthError" });
    });

    it('should return "error" for APIError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "APIError" },
        }),
      ).toEqual({ unified: "error", raw: "APIError" });
    });

    it('should return "error" for UnknownError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "UnknownError" },
        }),
      ).toEqual({ unified: "error", raw: "UnknownError" });
    });

    it('should return "error" for unknown error types', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "SomeOtherError" },
        }),
      ).toEqual({ unified: "error", raw: "SomeOtherError" });
    });

    it("should prioritize error over finish", () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: "APIError" },
          finish: "end_turn",
        }),
      ).toEqual({ unified: "error", raw: "APIError" });
    });

    it('should return "stop" for message without error or finish', () => {
      expect(mapOpencodeFinishReason({})).toEqual({
        unified: "stop",
        raw: undefined,
      });
    });
  });

  describe("mapErrorToFinishReasonFromUnknown", () => {
    it('should return "stop" for abort errors', () => {
      const error = { name: "AbortError" };
      expect(mapErrorToFinishReasonFromUnknown(error)).toEqual({
        unified: "stop",
        raw: "abort",
      });
    });

    it('should return "stop" for MessageAbortedError', () => {
      const error = { name: "MessageAbortedError" };
      expect(mapErrorToFinishReasonFromUnknown(error)).toEqual({
        unified: "stop",
        raw: "abort",
      });
    });

    it('should return "length" for output length errors', () => {
      const error = { name: "MessageOutputLengthError" };
      expect(mapErrorToFinishReasonFromUnknown(error)).toEqual({
        unified: "length",
        raw: "output-length",
      });
    });

    it('should return "length" for max tokens error message', () => {
      const error = { message: "Max tokens exceeded" };
      expect(mapErrorToFinishReasonFromUnknown(error)).toEqual({
        unified: "length",
        raw: "output-length",
      });
    });

    it('should return "error" for other errors', () => {
      const error = { name: "NetworkError", message: "Connection failed" };
      expect(mapErrorToFinishReasonFromUnknown(error)).toEqual({
        unified: "error",
        raw: "unknown",
      });
    });

    it('should return "error" for null', () => {
      expect(mapErrorToFinishReasonFromUnknown(null)).toEqual({
        unified: "error",
        raw: "unknown",
      });
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
