import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getLogger,
  defaultLogger,
  silentLogger,
  createContextLogger,
  logUnsupportedFeature,
  logUnsupportedParameter,
  logUnsupportedCallOptions,
} from "./logger.js";
import type { Logger } from "./types.js";

describe("logger", () => {
  describe("defaultLogger", () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    });

    it("should log warnings with prefix", () => {
      defaultLogger.warn("Test warning");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[opencode-provider] Test warning",
      );
    });

    it("should log errors with prefix", () => {
      defaultLogger.error("Test error");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[opencode-provider] Test error",
      );
    });

    it("should log debug with prefix", () => {
      defaultLogger.debug?.("Test debug");
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        "[opencode-provider] Test debug",
      );
    });
  });

  describe("silentLogger", () => {
    it("should not log anything", () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      silentLogger.warn("Test");
      silentLogger.error("Test");
      silentLogger.debug?.("Test");

      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("getLogger", () => {
    it("should return silent logger when false is passed", () => {
      const logger = getLogger(false);
      expect(logger).toBe(silentLogger);
    });

    it("should return provided logger when valid logger passed", () => {
      const customLogger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };
      const logger = getLogger(customLogger);
      expect(logger.warn).toBe(customLogger.warn);
      expect(logger.error).toBe(customLogger.error);
    });

    it("should add debug function if verbose and logger lacks it", () => {
      const customLogger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };
      const logger = getLogger(customLogger, true);

      logger.debug?.("test");
      expect(customLogger.warn).toHaveBeenCalledWith("[DEBUG] test");
    });

    it("should return default logger when undefined passed", () => {
      const logger = getLogger(undefined);
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
    });

    it("should disable debug on default logger when not verbose", () => {
      const consoleDebugSpy = vi
        .spyOn(console, "debug")
        .mockImplementation(() => {});
      const logger = getLogger(undefined, false);

      logger.debug?.("test");
      expect(consoleDebugSpy).not.toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
    });

    it("should enable debug on default logger when verbose", () => {
      const consoleDebugSpy = vi
        .spyOn(console, "debug")
        .mockImplementation(() => {});
      const logger = getLogger(undefined, true);

      logger.debug?.("test");
      expect(consoleDebugSpy).toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
    });
  });

  describe("createContextLogger", () => {
    it("should prefix messages with context", () => {
      const baseLogger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const contextLogger = createContextLogger(baseLogger, "TestContext");

      contextLogger.warn("warning message");
      contextLogger.error("error message");
      contextLogger.debug?.("debug message");

      expect(baseLogger.warn).toHaveBeenCalledWith(
        "[TestContext] warning message",
      );
      expect(baseLogger.error).toHaveBeenCalledWith(
        "[TestContext] error message",
      );
      expect(baseLogger.debug).toHaveBeenCalledWith(
        "[TestContext] debug message",
      );
    });

    it("should not have debug if base logger lacks it", () => {
      const baseLogger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const contextLogger = createContextLogger(baseLogger, "TestContext");
      expect(contextLogger.debug).toBeUndefined();
    });
  });

  describe("logUnsupportedFeature", () => {
    it("should log feature name", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      logUnsupportedFeature(logger, "custom tools");
      expect(logger.warn).toHaveBeenCalledWith(
        "Unsupported feature: custom tools",
      );
    });

    it("should include details if provided", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      logUnsupportedFeature(
        logger,
        "image URLs",
        "Only base64 data URLs are supported",
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Unsupported feature: image URLs - Only base64 data URLs are supported",
      );
    });
  });

  describe("logUnsupportedParameter", () => {
    it("should log parameter name without value", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      logUnsupportedParameter(logger, "temperature");
      expect(logger.warn).toHaveBeenCalledWith(
        "Parameter 'temperature' is not supported by OpenCode",
      );
    });

    it("should log parameter name with value", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      logUnsupportedParameter(logger, "temperature", 0.7);
      expect(logger.warn).toHaveBeenCalledWith(
        "Parameter 'temperature' is not supported by OpenCode (value: 0.7)",
      );
    });
  });

  describe("logUnsupportedCallOptions", () => {
    it("should return warnings for defined parameters", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const warnings = logUnsupportedCallOptions(logger, {
        temperature: 0.7,
        topP: 0.9,
      });

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("temperature");
      expect(warnings[1]).toContain("topP");
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("should not warn for undefined parameters", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const warnings = logUnsupportedCallOptions(logger, {
        temperature: undefined,
        topP: undefined,
      });

      expect(warnings).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("should handle all supported parameters", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const warnings = logUnsupportedCallOptions(logger, {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        frequencyPenalty: 0.5,
        presencePenalty: 0.5,
        stopSequences: ["stop"],
        seed: 123,
        maxTokens: 1000,
      });

      expect(warnings).toHaveLength(8);
    });

    it("should return empty array for empty options", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const warnings = logUnsupportedCallOptions(logger, {});
      expect(warnings).toHaveLength(0);
    });
  });
});
