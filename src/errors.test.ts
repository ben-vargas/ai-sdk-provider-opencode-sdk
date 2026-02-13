import { describe, it, expect } from "vitest";
import {
  isAuthenticationError,
  isTimeoutError,
  isAbortError,
  isOutputLengthError,
  createAuthenticationError,
  createAPICallError,
  createTimeoutError,
  extractErrorMessage,
  wrapError,
} from "./errors.js";
import { LoadAPIKeyError, APICallError } from "@ai-sdk/provider";

describe("errors", () => {
  describe("isAuthenticationError", () => {
    it("should return true for ProviderAuthError name", () => {
      const error = { name: "ProviderAuthError", message: "Auth failed" };
      expect(isAuthenticationError(error)).toBe(true);
    });

    it("should return true for 401 status code", () => {
      const error = { statusCode: 401, message: "Unauthorized" };
      expect(isAuthenticationError(error)).toBe(true);
    });

    it("should return true for 403 status code", () => {
      const error = { statusCode: 403, message: "Forbidden" };
      expect(isAuthenticationError(error)).toBe(true);
    });

    it('should return true for message containing "unauthorized"', () => {
      const error = { message: "Request was unauthorized" };
      expect(isAuthenticationError(error)).toBe(true);
    });

    it('should return true for message containing "api key"', () => {
      const error = { message: "Invalid API key provided" };
      expect(isAuthenticationError(error)).toBe(true);
    });

    it('should return true for message containing "authentication"', () => {
      const error = { message: "Authentication required" };
      expect(isAuthenticationError(error)).toBe(true);
    });

    it("should return false for null", () => {
      expect(isAuthenticationError(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isAuthenticationError(undefined)).toBe(false);
    });

    it("should return false for non-auth errors", () => {
      const error = { name: "NetworkError", message: "Connection failed" };
      expect(isAuthenticationError(error)).toBe(false);
    });
  });

  describe("isTimeoutError", () => {
    it("should return true for timeout in name", () => {
      const error = { name: "TimeoutError", message: "Request timed out" };
      expect(isTimeoutError(error)).toBe(true);
    });

    it("should return false for AbortError name", () => {
      const error = { name: "AbortError", message: "Aborted" };
      expect(isTimeoutError(error)).toBe(false);
    });

    it("should return false for ABORT_ERR code", () => {
      const error = { code: "ABORT_ERR", message: "Operation aborted" };
      expect(isTimeoutError(error)).toBe(false);
    });

    it("should return true for ETIMEDOUT code", () => {
      const error = { code: "ETIMEDOUT", message: "Connection timed out" };
      expect(isTimeoutError(error)).toBe(true);
    });

    it("should return true for ESOCKETTIMEDOUT code", () => {
      const error = { code: "ESOCKETTIMEDOUT", message: "Socket timeout" };
      expect(isTimeoutError(error)).toBe(true);
    });

    it('should return true for message containing "timeout"', () => {
      const error = { message: "Request timeout after 5000ms" };
      expect(isTimeoutError(error)).toBe(true);
    });

    it('should return true for message containing "timed out"', () => {
      const error = { message: "Connection timed out" };
      expect(isTimeoutError(error)).toBe(true);
    });

    it("should return false for null", () => {
      expect(isTimeoutError(null)).toBe(false);
    });

    it("should return false for non-timeout errors", () => {
      const error = { name: "NetworkError", message: "Connection failed" };
      expect(isTimeoutError(error)).toBe(false);
    });
  });

  describe("isAbortError", () => {
    it("should return true for AbortError name", () => {
      const error = { name: "AbortError", message: "Aborted" };
      expect(isAbortError(error)).toBe(true);
    });

    it("should return true for ABORT_ERR code", () => {
      const error = { code: "ABORT_ERR", message: "Operation aborted" };
      expect(isAbortError(error)).toBe(true);
    });

    it("should return true for MessageAbortedError name", () => {
      const error = { name: "MessageAbortedError", message: "Message aborted" };
      expect(isAbortError(error)).toBe(true);
    });

    it("should return false for null", () => {
      expect(isAbortError(null)).toBe(false);
    });

    it("should return false for non-abort errors", () => {
      const error = { name: "NetworkError", message: "Failed" };
      expect(isAbortError(error)).toBe(false);
    });
  });

  describe("isOutputLengthError", () => {
    it("should return true for MessageOutputLengthError name", () => {
      const error = {
        name: "MessageOutputLengthError",
        message: "Output too long",
      };
      expect(isOutputLengthError(error)).toBe(true);
    });

    it('should return true for message containing "output length"', () => {
      const error = { message: "Maximum output length exceeded" };
      expect(isOutputLengthError(error)).toBe(true);
    });

    it('should return true for message containing "max tokens"', () => {
      const error = { message: "Exceeded max tokens limit" };
      expect(isOutputLengthError(error)).toBe(true);
    });

    it('should return true for message containing "token limit"', () => {
      const error = { message: "Token limit reached" };
      expect(isOutputLengthError(error)).toBe(true);
    });

    it("should return true for ContextOverflowError name", () => {
      const error = { name: "ContextOverflowError", message: "Context limit" };
      expect(isOutputLengthError(error)).toBe(true);
    });

    it("should return false for null", () => {
      expect(isOutputLengthError(null)).toBe(false);
    });

    it("should return false for non-length errors", () => {
      const error = { name: "NetworkError", message: "Failed" };
      expect(isOutputLengthError(error)).toBe(false);
    });
  });

  describe("createAuthenticationError", () => {
    it("should create LoadAPIKeyError with message", () => {
      const error = { message: "Invalid API key" };
      const result = createAuthenticationError(error);

      expect(result).toBeInstanceOf(LoadAPIKeyError);
      expect(result.message).toContain("Invalid API key");
    });

    it("should include provider info if available", () => {
      const error = {
        message: "Auth failed",
        data: { providerID: "anthropic" },
      };
      const result = createAuthenticationError(error);

      expect(result.message).toContain("anthropic");
    });
  });

  describe("createAPICallError", () => {
    it("should create APICallError with message", () => {
      const error = { message: "API call failed" };
      const result = createAPICallError(error);

      expect(result).toBeInstanceOf(APICallError);
      expect(result.message).toBe("API call failed");
    });

    it("should include status code if available", () => {
      const error = { message: "Server error", statusCode: 500 };
      const result = createAPICallError(error);

      expect(result.statusCode).toBe(500);
    });

    it("should include metadata", () => {
      const error = { message: "Failed" };
      const result = createAPICallError(error, {
        sessionId: "session-123",
        messageId: "msg-456",
      });

      expect(result.data).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-456",
      });
    });

    it("should mark 5xx errors as retryable", () => {
      const error = { message: "Server error", statusCode: 503 };
      const result = createAPICallError(error);

      expect(result.isRetryable).toBe(true);
    });

    it("should mark 429 as retryable", () => {
      const error = { message: "Rate limited", statusCode: 429 };
      const result = createAPICallError(error);

      expect(result.isRetryable).toBe(true);
    });

    it("should mark abort errors as non-retryable", () => {
      const error = { name: "AbortError", message: "Aborted" };
      const result = createAPICallError(error);

      expect(result.isRetryable).toBe(false);
    });
  });

  describe("createTimeoutError", () => {
    it("should create timeout error with duration", () => {
      const result = createTimeoutError(5000);

      expect(result).toBeInstanceOf(APICallError);
      expect(result.message).toContain("5000ms");
      expect(result.isRetryable).toBe(true);
    });

    it("should include operation in message", () => {
      const result = createTimeoutError(10000, "server startup");

      expect(result.message).toContain("server startup");
    });
  });

  describe("extractErrorMessage", () => {
    it('should return "Unknown error" for null', () => {
      expect(extractErrorMessage(null)).toBe("Unknown error");
    });

    it('should return "Unknown error" for undefined', () => {
      expect(extractErrorMessage(undefined)).toBe("Unknown error");
    });

    it("should return string directly", () => {
      expect(extractErrorMessage("Direct error message")).toBe(
        "Direct error message",
      );
    });

    it("should extract message from Error instance", () => {
      const error = new Error("Test error");
      expect(extractErrorMessage(error)).toBe("Test error");
    });

    it("should extract message property from object", () => {
      const error = { message: "Object error message" };
      expect(extractErrorMessage(error)).toBe("Object error message");
    });

    it("should extract error property from object", () => {
      const error = { error: "Error property message" };
      expect(extractErrorMessage(error)).toBe("Error property message");
    });

    it("should extract nested data.message", () => {
      const error = { data: { message: "Nested message" } };
      expect(extractErrorMessage(error)).toBe("Nested message");
    });

    it('should return "Unknown error" for object without message', () => {
      const error = { code: 500 };
      expect(extractErrorMessage(error)).toBe("Unknown error");
    });
  });

  describe("wrapError", () => {
    it("should wrap authentication errors as LoadAPIKeyError", () => {
      const error = { name: "ProviderAuthError", message: "Auth failed" };
      const result = wrapError(error);

      expect(result).toBeInstanceOf(LoadAPIKeyError);
    });

    it("should wrap timeout errors as APICallError with retryable", () => {
      const error = { name: "TimeoutError", message: "Timed out" };
      const result = wrapError(error);

      expect(result).toBeInstanceOf(APICallError);
      expect((result as APICallError).isRetryable).toBe(true);
      expect(result.message).toContain("5000ms");
    });

    it("should use metadata timeout when wrapping timeout errors", () => {
      const error = { name: "TimeoutError", message: "Timed out" };
      const result = wrapError(error, { timeoutMs: 12000 });

      expect(result).toBeInstanceOf(APICallError);
      expect(result.message).toContain("12000ms");
    });

    it("should use timeout value from error when available", () => {
      const error = {
        name: "TimeoutError",
        message: "Timed out",
        timeoutMs: 7500,
      };
      const result = wrapError(error);

      expect(result).toBeInstanceOf(APICallError);
      expect(result.message).toContain("7500ms");
    });

    it("should wrap other errors as APICallError", () => {
      const error = { message: "Generic error" };
      const result = wrapError(error);

      expect(result).toBeInstanceOf(APICallError);
    });

    it("should pass metadata through", () => {
      const error = { message: "Error" };
      const result = wrapError(error, { sessionId: "session-123" });

      expect((result as APICallError).data).toMatchObject({
        sessionId: "session-123",
      });
    });
  });
});
