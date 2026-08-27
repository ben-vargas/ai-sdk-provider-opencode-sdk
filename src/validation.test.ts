import { describe, it, expect, vi } from "vitest";
import {
  validateSettings,
  validateProviderSettings,
  validateModelId,
  validateFormAnswer,
  isValidSessionId,
  isAttachableDataUri,
  isDataUri,
  mergeSettings,
  resolveSessionLocation,
  resolveSessionMode,
} from "./validation.js";
import type {
  Logger,
  OpencodeClient,
  OpencodeFormRequest,
  OpencodeProviderSettings,
  OpencodeSettings,
} from "./types.js";

describe("validation", () => {
  describe("validateSettings", () => {
    it("should return empty object for undefined settings", () => {
      const result = validateSettings(undefined);
      expect(result.value).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });

    it("should pass valid settings through unchanged", () => {
      const settings: OpencodeSettings = {
        sessionId: "test-session-123",
        sessionMode: "existing",
        createNewSession: false,
        sessionTitle: "Test Session",
        agent: "build",
        variant: "safe",
        location: { directory: "/home/user", workspaceID: "ws-1" },
        delivery: "queue",
        resume: false,
        formPolicy: "cancel",
        verbose: true,
      };

      const result = validateSettings(settings);
      expect(result.value).toEqual(settings);
      expect(result.warnings).toHaveLength(0);
    });

    it("should warn about invalid session ID format", () => {
      const settings = {
        sessionId: "invalid session id with spaces!@#",
        sessionMode: "existing" as const,
      };

      const result = validateSettings(settings);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(
        result.warnings.some((w) => w.includes("Invalid session ID")),
      ).toBe(true);
    });

    it("should log warnings when logger is provided", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const settings = {
        sessionId: "bad session!",
        sessionMode: "existing" as const,
      };

      validateSettings(settings, logger);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("should accept onForm and formPolicy settings", () => {
      const settings: OpencodeSettings = {
        onForm: () => ({ type: "cancel" }),
        formPolicy: "wait",
      };

      const result = validateSettings(settings);
      expect(result.value).toEqual(settings);
      expect(result.warnings).toHaveLength(0);
    });

    it("should warn about invalid formPolicy values", () => {
      const settings = {
        formPolicy: "ignore",
      } as unknown as OpencodeSettings;

      const result = validateSettings(settings);
      expect(result.warnings.some((w) => w.includes("formPolicy"))).toBe(true);
    });

    it("should warn about non-function onForm values", () => {
      const settings = {
        onForm: "not a function",
      } as unknown as OpencodeSettings;

      const result = validateSettings(settings);
      expect(result.warnings.some((w) => w.includes("onForm"))).toBe(true);
    });

    it("does not warn about systemPrompt: it is a real system prompt now", () => {
      // v2 delivers it as a session instruction entry that applies to every
      // turn. Only an actual fallback (no route / over the size cap / a
      // failed write) degrades it, and that is a generation-time warning on
      // the call that hit it — construction cannot know.
      const result = validateSettings({ systemPrompt: "You are helpful" });
      expect(result.warnings.some((w) => w.includes("systemPrompt"))).toBe(
        false,
      );
    });

    it("should warn that directory is deprecated", () => {
      const result = validateSettings({ directory: "/home/user" });
      expect(
        result.warnings.some((w) => w.includes("directory is deprecated")),
      ).toBe(true);
    });

    it("should warn that location wins when both location and directory are set", () => {
      const result = validateSettings({
        location: { directory: "/v5" },
        directory: "/v4",
      });
      expect(
        result.warnings.some((w) =>
          w.includes("location takes precedence and directory will be ignored"),
        ),
      ).toBe(true);
    });

    it("should warn when sessionId is set in ephemeral mode", () => {
      const result = validateSettings({
        sessionId: "abc123",
        sessionMode: "ephemeral",
      });
      expect(result.warnings.some((w) => w.includes("ephemeral"))).toBe(true);
    });

    it('should warn when sessionMode "existing" has no sessionId', () => {
      const result = validateSettings({ sessionMode: "existing" });
      expect(
        result.warnings.some((w) => w.includes("requires a sessionId")),
      ).toBe(true);
    });

    it('should warn about the removed "persistent" mode value', () => {
      const settings = {
        sessionMode: "persistent",
      } as unknown as OpencodeSettings;
      const result = validateSettings(settings);
      expect(result.warnings.some((w) => w.includes("sessionMode"))).toBe(true);
    });

    it("should warn about invalid delivery values", () => {
      const settings = { delivery: "interrupt" } as unknown as OpencodeSettings;
      const result = validateSettings(settings);
      expect(result.warnings.some((w) => w.includes("delivery"))).toBe(true);
    });
  });

  describe("validateProviderSettings", () => {
    it("should return empty object for undefined settings", () => {
      const result = validateProviderSettings(undefined);
      expect(result.value).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });

    it("should pass valid provider settings through", () => {
      const settings: OpencodeProviderSettings = {
        baseUrl: "http://127.0.0.1:4096",
        clientOptions: {
          headers: {
            Authorization: "Bearer token",
          },
        },
      };

      const result = validateProviderSettings(settings);
      expect(result.value).toEqual(settings);
      expect(result.warnings).toHaveLength(0);
    });

    it("should accept service options with autoStart", () => {
      const settings: OpencodeProviderSettings = {
        service: {
          file: "/tmp/opencode-service.json",
          version: (version) => version.startsWith("0.0.0-beta"),
          command: ["opencode", "serve", "--service"],
        },
        autoStart: true,
      };

      const result = validateProviderSettings(settings);
      expect(result.warnings).toHaveLength(0);
    });

    it("should warn about invalid baseUrl", () => {
      const result = validateProviderSettings({ baseUrl: "not-a-url" });
      expect(result.warnings.some((w) => w.includes("baseUrl"))).toBe(true);
    });

    it("should warn when both client and baseUrl are provided", () => {
      const settings: OpencodeProviderSettings = {
        client: {} as OpencodeClient,
        baseUrl: "http://127.0.0.1:4096",
      };

      const result = validateProviderSettings(settings);
      expect(
        result.warnings.some((w) => w.includes("client takes precedence")),
      ).toBe(true);
    });

    it("should warn when both client and service are provided", () => {
      const settings: OpencodeProviderSettings = {
        client: {} as OpencodeClient,
        service: { file: "/tmp/service.json" },
      };

      const result = validateProviderSettings(settings);
      expect(result.warnings.some((w) => w.includes("service discovery"))).toBe(
        true,
      );
    });

    it("should warn when both baseUrl and service are provided", () => {
      const settings: OpencodeProviderSettings = {
        baseUrl: "http://127.0.0.1:4096",
        service: { file: "/tmp/service.json" },
      };

      const result = validateProviderSettings(settings);
      expect(
        result.warnings.some((w) => w.includes("baseUrl takes precedence")),
      ).toBe(true);
    });

    it("should warn when both client and clientOptions are provided", () => {
      const settings: OpencodeProviderSettings = {
        client: {} as OpencodeClient,
        clientOptions: {
          headers: {
            "x-test": "value",
          },
        },
      };

      const result = validateProviderSettings(settings);
      expect(result.warnings.some((w) => w.includes("clientOptions"))).toBe(
        true,
      );
    });

    it("should warn when autoStart is combined with client or baseUrl", () => {
      const withClient = validateProviderSettings({
        client: {} as OpencodeClient,
        autoStart: true,
      });
      expect(withClient.warnings.some((w) => w.includes("autoStart"))).toBe(
        true,
      );

      const withBaseUrl = validateProviderSettings({
        baseUrl: "http://127.0.0.1:4096",
        autoStart: true,
      });
      expect(withBaseUrl.warnings.some((w) => w.includes("autoStart"))).toBe(
        true,
      );
    });
  });

  describe("validateModelId", () => {
    it("should parse provider/model format", () => {
      const result = validateModelId("anthropic/claude-3-5-sonnet-20241022");
      expect(result).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet-20241022",
      });
    });

    it("should handle model-only format", () => {
      const result = validateModelId("claude-3-5-sonnet-20241022");
      expect(result).toEqual({
        providerID: "",
        modelID: "claude-3-5-sonnet-20241022",
      });
    });

    it("should return null for empty string", () => {
      const result = validateModelId("");
      expect(result).toBeNull();
    });

    it("should return null for whitespace-only string", () => {
      const result = validateModelId("   ");
      expect(result).toBeNull();
    });

    it("should handle multiple slashes by using first segment as provider", () => {
      const result = validateModelId("org/provider/model");
      expect(result).not.toBeNull();
      expect(result?.providerID).toBe("org");
      expect(result?.modelID).toBe("provider/model");
    });

    it("should correctly parse litellm proxy model IDs", () => {
      const result = validateModelId("litellm/anthropic/claude-sonnet-4-6");
      expect(result).not.toBeNull();
      expect(result?.providerID).toBe("litellm");
      expect(result?.modelID).toBe("anthropic/claude-sonnet-4-6");
    });

    it("should trim whitespace", () => {
      const result = validateModelId("  anthropic/claude  ");
      expect(result).toEqual({
        providerID: "anthropic",
        modelID: "claude",
      });
    });

    it("should log error for invalid model ID when logger provided", () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      validateModelId("", logger);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("isValidSessionId", () => {
    it("should accept valid UUID-like session IDs", () => {
      expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(
        true,
      );
    });

    it("should accept alphanumeric session IDs", () => {
      expect(isValidSessionId("abc123")).toBe(true);
    });

    it("should accept session IDs with underscores", () => {
      expect(isValidSessionId("session_123_abc")).toBe(true);
    });

    it("should accept session IDs with hyphens", () => {
      expect(isValidSessionId("session-123-abc")).toBe(true);
    });

    it("should reject empty strings", () => {
      expect(isValidSessionId("")).toBe(false);
    });

    it("should reject null/undefined", () => {
      expect(isValidSessionId(null as unknown as string)).toBe(false);
      expect(isValidSessionId(undefined as unknown as string)).toBe(false);
    });

    it("should reject session IDs with spaces", () => {
      expect(isValidSessionId("session 123")).toBe(false);
    });

    it("should reject session IDs with special characters", () => {
      expect(isValidSessionId("session@123")).toBe(false);
      expect(isValidSessionId("session!123")).toBe(false);
    });

    it("should reject very long session IDs", () => {
      const longId = "a".repeat(200);
      expect(isValidSessionId(longId)).toBe(false);
    });
  });

  describe("validateFormAnswer", () => {
    const form: OpencodeFormRequest = {
      id: "form_1",
      sessionID: "ses_1",
      title: "Deployment options",
      fields: [
        { key: "env", type: "string", required: true, options: [] },
        { key: "replicas", type: "integer" },
        { key: "ratio", type: "number" },
        { key: "confirm", type: "boolean", required: true, default: false },
        {
          key: "regions",
          type: "multiselect",
          options: [
            { label: "us-east", value: "us-east" },
            { label: "eu-west", value: "eu-west" },
          ],
        },
        { key: "callback", type: "external", url: "https://example.com" },
      ] as OpencodeFormRequest["fields"],
    };

    it("should accept a well-formed answer", () => {
      const result = validateFormAnswer(form, {
        env: "production",
        replicas: 3,
        ratio: 0.5,
        confirm: true,
        regions: ["us-east"],
      });
      expect(result.warnings).toHaveLength(0);
    });

    it("should warn about unknown answer keys", () => {
      const result = validateFormAnswer(form, { env: "prod", bogus: "x" });
      expect(result.warnings.some((w) => w.includes('"bogus"'))).toBe(true);
    });

    it("should warn about wrong value shapes per field type", () => {
      const result = validateFormAnswer(form, {
        env: 42,
        replicas: 1.5,
        ratio: "a lot",
        confirm: "yes",
        regions: "us-east",
      });
      expect(
        result.warnings.some(
          (w) => w.includes('"env"') && w.includes("string"),
        ),
      ).toBe(true);
      expect(
        result.warnings.some(
          (w) => w.includes('"replicas"') && w.includes("integer"),
        ),
      ).toBe(true);
      expect(
        result.warnings.some(
          (w) => w.includes('"ratio"') && w.includes("number"),
        ),
      ).toBe(true);
      expect(
        result.warnings.some(
          (w) => w.includes('"confirm"') && w.includes("boolean"),
        ),
      ).toBe(true);
      expect(
        result.warnings.some(
          (w) => w.includes('"regions"') && w.includes("array of strings"),
        ),
      ).toBe(true);
    });

    it("should warn about missing required fields without defaults", () => {
      const result = validateFormAnswer(form, {});
      expect(result.warnings.some((w) => w.includes('"env"'))).toBe(true);
      // confirm has a default, so it is not reported missing
      expect(result.warnings.some((w) => w.includes('"confirm"'))).toBe(false);
    });

    it("should not require conditional (when-gated) fields", () => {
      const conditionalForm: OpencodeFormRequest = {
        ...form,
        fields: [
          {
            key: "reason",
            type: "string",
            required: true,
            when: [{ key: "confirm", equals: true }],
          },
        ] as unknown as OpencodeFormRequest["fields"],
      };
      const result = validateFormAnswer(conditionalForm, {});
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("mergeSettings", () => {
    it("should return empty object when both are undefined", () => {
      const result = mergeSettings(undefined, undefined);
      expect(result).toEqual({});
    });

    it("should return defaults when overrides is undefined", () => {
      const defaults = { agent: "build", verbose: true };
      const result = mergeSettings(defaults, undefined);
      expect(result).toEqual(defaults);
    });

    it("should return overrides when defaults is undefined", () => {
      const overrides = { agent: "plan", verbose: false };
      const result = mergeSettings(undefined, overrides);
      expect(result).toEqual(overrides);
    });

    it("should merge settings with overrides taking precedence", () => {
      const defaults: OpencodeSettings = {
        agent: "build",
        verbose: true,
        sessionTitle: "Default",
      };
      const overrides: OpencodeSettings = {
        agent: "plan",
        delivery: "steer",
      };
      const result = mergeSettings(defaults, overrides);

      expect(result).toEqual({
        agent: "plan",
        verbose: true,
        sessionTitle: "Default",
        delivery: "steer",
      });
    });

    it("should prefer override location wholesale", () => {
      const defaults: OpencodeSettings = {
        location: { directory: "/default", workspaceID: "ws-default" },
      };
      const overrides: OpencodeSettings = {
        location: { directory: "/override" },
      };
      const result = mergeSettings(defaults, overrides);

      expect(result.location).toEqual({ directory: "/override" });
    });

    it("should keep default location when overrides omit it", () => {
      const defaults: OpencodeSettings = {
        location: { directory: "/default" },
      };
      const result = mergeSettings(defaults, { agent: "plan" });

      expect(result.location).toEqual({ directory: "/default" });
    });

    it("should let an override directory supersede a default location", () => {
      const defaults: OpencodeSettings = {
        location: { directory: "/default", workspaceID: "ws-default" },
      };
      const result = mergeSettings(defaults, { directory: "/override" });

      expect(result.location).toBeUndefined();
      expect(result.directory).toBe("/override");
    });

    it("should let an override location supersede a default directory", () => {
      const defaults: OpencodeSettings = { directory: "/default" };
      const result = mergeSettings(defaults, {
        location: { directory: "/override" },
      });

      expect(result.location).toEqual({ directory: "/override" });
      expect(result.directory).toBeUndefined();
    });

    it("should keep default directory when overrides omit both", () => {
      const defaults: OpencodeSettings = { directory: "/default" };
      const result = mergeSettings(defaults, { agent: "plan" });

      expect(result.directory).toBe("/default");
    });
  });

  describe("resolveSessionLocation", () => {
    it("should return undefined when neither location nor directory is set", () => {
      expect(resolveSessionLocation({})).toBeUndefined();
    });

    it("should map the deprecated directory alias to location.directory", () => {
      expect(resolveSessionLocation({ directory: "/v4-dir" })).toEqual({
        directory: "/v4-dir",
      });
    });

    it("should prefer location over the deprecated directory alias", () => {
      expect(
        resolveSessionLocation({
          location: { directory: "/v5-dir", workspaceID: "ws-1" },
          directory: "/v4-dir",
        }),
      ).toEqual({ directory: "/v5-dir", workspaceID: "ws-1" });
    });
  });

  describe("resolveSessionMode", () => {
    it("defaults to ephemeral", () => {
      expect(resolveSessionMode({})).toBe("ephemeral");
    });

    it("implies existing when a sessionId is pinned without a mode", () => {
      expect(resolveSessionMode({ sessionId: "ses_1" })).toBe("existing");
    });

    it("lets an explicit mode win over a conflicting sessionId", () => {
      expect(
        resolveSessionMode({ sessionId: "ses_1", sessionMode: "ephemeral" }),
      ).toBe("ephemeral");
    });

    it('falls back to ephemeral for "existing" without a sessionId', () => {
      expect(resolveSessionMode({ sessionMode: "existing" })).toBe("ephemeral");
    });

    it('resolves "existing" with a sessionId as existing', () => {
      expect(
        resolveSessionMode({ sessionId: "ses_1", sessionMode: "existing" }),
      ).toBe("existing");
    });
  });

  describe("isDataUri", () => {
    it("should accept data URIs", () => {
      expect(isDataUri("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    });

    it("should reject non-data URI schemes", () => {
      expect(isDataUri("file:///tmp/red.png")).toBe(false);
      expect(isDataUri("https://example.com/red.png")).toBe(false);
      expect(isDataUri("/tmp/red.png")).toBe(false);
      expect(isDataUri("red.png")).toBe(false);
    });
  });

  describe("isAttachableDataUri", () => {
    it("accepts well-formed data URIs", () => {
      expect(isAttachableDataUri("data:image/png;base64,iVBORw0KGgo=")).toBe(
        true,
      );
      expect(isAttachableDataUri("data:text/plain,hello")).toBe(true);
      expect(
        isAttachableDataUri("data:text/plain;charset=utf-8;base64,aGk="),
      ).toBe(true);
    });

    it("rejects non-data schemes", () => {
      expect(isAttachableDataUri("https://example.com/red.png")).toBe(false);
      expect(isAttachableDataUri("file:///tmp/red.png")).toBe(false);
    });

    it("rejects data URIs without a comma or payload", () => {
      expect(isAttachableDataUri("data:image/png;base64")).toBe(false);
      expect(isAttachableDataUri("data:image/png;base64,")).toBe(false);
      expect(isAttachableDataUri("data:")).toBe(false);
    });

    it("rejects data URIs without a concrete type/subtype mediatype", () => {
      expect(isAttachableDataUri("data:;base64,aGk=")).toBe(false);
      expect(isAttachableDataUri("data:image;base64,aGk=")).toBe(false);
      expect(isAttachableDataUri("data:image/*;base64,aGk=")).toBe(false);
      expect(isAttachableDataUri("data:*/*;base64,aGk=")).toBe(false);
      expect(isAttachableDataUri("data:/png;base64,aGk=")).toBe(false);
      expect(isAttachableDataUri("data:image/;base64,aGk=")).toBe(false);
    });
  });
});
