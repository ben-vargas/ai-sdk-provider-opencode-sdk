import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpencodeClientManager,
  createClientManager,
  createClientManagerFromSettings,
} from "./opencode-client-manager.js";
import type { OpencodeClient } from "./types.js";

// Mock the @opencode-ai/sdk/v2 module
vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn().mockResolvedValue({
    session: {
      create: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
    },
    event: {
      subscribe: vi.fn(),
    },
  }),
  createOpencodeServer: vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:4096",
    close: vi.fn(),
  }),
}));

// Mock fetch for health checks
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("opencode-client-manager", () => {
  beforeEach(() => {
    // Reset singleton before each test
    OpencodeClientManager.resetInstance();
    vi.clearAllMocks();

    // Default: server not running (health check fails)
    mockFetch.mockRejectedValue(new Error("Connection refused"));
  });

  afterEach(() => {
    OpencodeClientManager.resetInstance();
  });

  describe("getInstance", () => {
    it("should return singleton instance", () => {
      const instance1 = OpencodeClientManager.getInstance();
      const instance2 = OpencodeClientManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it("should accept options on first call", () => {
      const instance = OpencodeClientManager.getInstance({
        hostname: "localhost",
        port: 5000,
      });

      expect(instance).toBeDefined();
    });

    it("should not update options after client initialized", async () => {
      const warn = vi.fn();
      const instance = OpencodeClientManager.getInstance({
        port: 4096,
        logger: {
          warn,
          error: vi.fn(),
        },
      });
      await instance.getClient();

      // Try to update options after initialization
      OpencodeClientManager.getInstance({ port: 5000 });

      // Should still use original port
      expect(instance.getServerUrl()).toContain("4096");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("already initialized"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("options from createOpencode() were ignored"),
      );
    });

    it("should warn explicitly when a different preconfigured client is provided after initialization", async () => {
      const warn = vi.fn();

      const initialClient = {
        session: {
          create: vi.fn(),
          prompt: vi.fn(),
          abort: vi.fn(),
        },
        event: {
          subscribe: vi.fn(),
        },
      };

      const nextClient = {
        session: {
          create: vi.fn(),
          prompt: vi.fn(),
          abort: vi.fn(),
        },
        event: {
          subscribe: vi.fn(),
        },
      };

      const instance = OpencodeClientManager.getInstance({
        client: initialClient as Awaited<
          ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
        >,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await instance.getClient();

      OpencodeClientManager.getInstance({
        client: nextClient as Awaited<
          ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
        >,
      });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("provided preconfigured client was ignored"),
      );
    });
  });

  describe("resetInstance", () => {
    it("should reset singleton instance", async () => {
      const instance1 = OpencodeClientManager.getInstance();
      await instance1.getClient();

      OpencodeClientManager.resetInstance();

      const instance2 = OpencodeClientManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("getClient", () => {
    it("should create client when server starts successfully", async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: true,
      });

      const client = await instance.getClient();

      expect(client).toBeDefined();
      expect(client.session).toBeDefined();
    });

    it("should return same client on subsequent calls", async () => {
      const instance = OpencodeClientManager.getInstance();

      const client1 = await instance.getClient();
      const client2 = await instance.getClient();

      expect(client1).toBe(client2);
    });

    it("should throw when disposed", async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.dispose();

      await expect(instance.getClient()).rejects.toThrow("disposed");
    });

    it("should connect to existing server if running", async () => {
      // Simulate server running
      mockFetch.mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      const client = await instance.getClient();
      expect(client).toBeDefined();
    });

    it("should try config endpoint if health fails", async () => {
      // Health fails, config succeeds
      mockFetch
        .mockRejectedValueOnce(new Error("Health failed"))
        .mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      const client = await instance.getClient();
      expect(client).toBeDefined();
    });

    it("should throw when server not running and autoStart disabled", async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      await expect(instance.getClient()).rejects.toThrow(
        "No OpenCode server running",
      );
    });

    it("should use baseUrl if provided", async () => {
      const instance = OpencodeClientManager.getInstance({
        baseUrl: "http://custom-server:8080",
      });

      await instance.getClient();

      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://custom-server:8080",
        }),
      );
    });

    it("should forward clientOptions when baseUrl is provided", async () => {
      const instance = OpencodeClientManager.getInstance({
        baseUrl: "http://custom-server:8080",
        clientOptions: {
          headers: {
            "x-api-key": "test-key",
          },
          throwOnError: true,
          credentials: "include",
        },
      });

      await instance.getClient();

      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://custom-server:8080",
          headers: {
            "x-api-key": "test-key",
          },
          throwOnError: true,
          credentials: "include",
        }),
      );
    });

    it("should forward clientOptions when connecting to existing server", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
        clientOptions: {
          headers: {
            Authorization: "Bearer test-token",
          },
          credentials: "omit",
        },
      });

      await instance.getClient();

      const { createOpencodeClient, createOpencodeServer } = await import(
        "@opencode-ai/sdk/v2"
      );
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://127.0.0.1:4096",
          headers: {
            Authorization: "Bearer test-token",
          },
          credentials: "omit",
        }),
      );
      expect(createOpencodeServer).not.toHaveBeenCalled();
    });

    it("should forward clientOptions when starting managed server", async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: true,
        clientOptions: {
          headers: {
            "x-trace-id": "trace-123",
          },
          keepalive: true,
        },
      });

      await instance.getClient();

      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://127.0.0.1:4096",
          headers: {
            "x-trace-id": "trace-123",
          },
          keepalive: true,
        }),
      );
    });

    it("should ignore clientOptions.baseUrl and clientOptions.directory", async () => {
      const warn = vi.fn();

      const instance = OpencodeClientManager.getInstance({
        baseUrl: "http://custom-server:8080",
        clientOptions: {
          baseUrl: "http://ignored:9999",
          directory: "/tmp/ignored",
          headers: { "x-test": "value" },
        } as unknown as NonNullable<
          Parameters<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>[0]
        >,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await instance.getClient();

      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://custom-server:8080",
          headers: { "x-test": "value" },
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring clientOptions.baseUrl"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring clientOptions.directory"),
      );
    });

    it("should not warn for undefined reserved keys in clientOptions", async () => {
      const warn = vi.fn();

      const instance = OpencodeClientManager.getInstance({
        baseUrl: "http://custom-server:8080",
        clientOptions: {
          baseUrl: undefined,
          directory: undefined,
          headers: { "x-test": "value" },
        } as unknown as NonNullable<
          Parameters<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>[0]
        >,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await instance.getClient();

      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Ignoring clientOptions.baseUrl"),
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Ignoring clientOptions.directory"),
      );
    });

    it("should use preconfigured client when provided", async () => {
      const warn = vi.fn();
      const preconfiguredClient = {
        session: {
          create: vi.fn(),
          prompt: vi.fn(),
          abort: vi.fn(),
        },
        event: {
          subscribe: vi.fn(),
        },
      };

      const instance = OpencodeClientManager.getInstance({
        client: preconfiguredClient as Awaited<
          ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
        >,
        clientOptions: {
          headers: { "x-ignored": "value" },
        },
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      const client = await instance.getClient();

      const { createOpencodeClient, createOpencodeServer } = await import(
        "@opencode-ai/sdk/v2"
      );
      expect(client).toBe(preconfiguredClient);
      expect(createOpencodeClient).not.toHaveBeenCalled();
      expect(createOpencodeServer).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("clientOptions will be ignored"),
      );
    });

    it("should handle concurrent getClient calls", async () => {
      const instance = OpencodeClientManager.getInstance();

      const [client1, client2] = await Promise.all([
        instance.getClient(),
        instance.getClient(),
      ]);

      expect(client1).toBe(client2);
    });
  });

  describe("getServerUrl", () => {
    it("should return URL from managed server", async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();

      expect(instance.getServerUrl()).toBe("http://127.0.0.1:4096");
    });

    it("should return baseUrl if provided", () => {
      const instance = OpencodeClientManager.getInstance({
        baseUrl: "http://custom:8080",
      });

      expect(instance.getServerUrl()).toBe("http://custom:8080");
    });

    it("should return constructed URL from hostname and port", () => {
      const instance = OpencodeClientManager.getInstance({
        hostname: "localhost",
        port: 5000,
      });

      expect(instance.getServerUrl()).toBe("http://localhost:5000");
    });
  });

  describe("isServerManaged", () => {
    it("should return false before client created", () => {
      const instance = OpencodeClientManager.getInstance();
      expect(instance.isServerManaged()).toBe(false);
    });

    it("should return true when server is started by manager", async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: true,
      });

      await instance.getClient();

      expect(instance.isServerManaged()).toBe(true);
    });

    it("should return false when connecting to external server", async () => {
      // Server already running
      mockFetch.mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      await instance.getClient();

      expect(instance.isServerManaged()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("should close managed server", async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();

      await instance.dispose();

      const { createOpencodeServer } = await import("@opencode-ai/sdk/v2");
      const server = await (createOpencodeServer as ReturnType<typeof vi.fn>)
        .mock.results[0].value;
      expect(server.close).toHaveBeenCalled();
    });

    it("should be idempotent", async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();

      await instance.dispose();
      await instance.dispose();

      // Should not throw
    });

    it("should clear client reference", async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();
      await instance.dispose();

      // Attempting to get client should throw
      await expect(instance.getClient()).rejects.toThrow("disposed");
    });
  });

  describe("createClientManager", () => {
    it("should return singleton instance", () => {
      const manager1 = createClientManager();
      const manager2 = createClientManager();

      expect(manager1).toBe(manager2);
    });

    it("should accept options", () => {
      const manager = createClientManager({ port: 5000 });
      expect(manager).toBeDefined();
    });
  });

  describe("createClientManagerFromSettings", () => {
    it("should create manager from provider settings", () => {
      const manager = createClientManagerFromSettings({
        hostname: "localhost",
        port: 5000,
        autoStartServer: false,
        serverTimeout: 15000,
        defaultSettings: {
          cwd: "/home/user/project",
        },
      });

      expect(manager).toBeDefined();
      expect(manager.getServerUrl()).toBe("http://localhost:5000");
    });

    it("should use baseUrl if provided", () => {
      const manager = createClientManagerFromSettings({
        baseUrl: "http://custom:8080",
      });

      expect(manager.getServerUrl()).toBe("http://custom:8080");
    });

    it("should accept defaultSettings.directory", () => {
      const manager = createClientManagerFromSettings({
        defaultSettings: {
          directory: "/tmp/project",
        },
      });

      expect(manager).toBeDefined();
    });

    it("should forward clientOptions from provider settings", async () => {
      const manager = createClientManagerFromSettings({
        baseUrl: "http://custom:8080",
        clientOptions: {
          headers: {
            "x-provider": "settings",
          },
          throwOnError: true,
        },
      });

      await manager.getClient();

      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://custom:8080",
          headers: {
            "x-provider": "settings",
          },
          throwOnError: true,
        }),
      );
    });

    it("should use preconfigured client from provider settings", async () => {
      const preconfiguredClient = {
        session: {
          create: vi.fn(),
          prompt: vi.fn(),
          abort: vi.fn(),
        },
        event: {
          subscribe: vi.fn(),
        },
      };

      const manager = createClientManagerFromSettings({
        client: preconfiguredClient as Awaited<
          ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
        >,
      });

      const client = await manager.getClient();
      expect(client).toBe(preconfiguredClient);
    });
  });

  describe("createInstance", () => {
    it("should return a new instance each time (not the singleton)", () => {
      const a = OpencodeClientManager.createInstance({});
      const b = OpencodeClientManager.createInstance({});
      const singleton = OpencodeClientManager.getInstance();

      expect(a).not.toBe(b);
      expect(a).not.toBe(singleton);
      expect(b).not.toBe(singleton);
    });

    it("should use its own client independently of the singleton", async () => {
      const clientA = {
        session: { create: vi.fn(), prompt: vi.fn(), abort: vi.fn() },
        event: { subscribe: vi.fn() },
      } as unknown as OpencodeClient;

      const clientB = {
        session: { create: vi.fn(), prompt: vi.fn(), abort: vi.fn() },
        event: { subscribe: vi.fn() },
      } as unknown as OpencodeClient;

      const a = OpencodeClientManager.createInstance({ client: clientA });
      const b = OpencodeClientManager.createInstance({ client: clientB });

      expect(await a.getClient()).toBe(clientA);
      expect(await b.getClient()).toBe(clientB);
    });

    it("should not affect each other when disposed", async () => {
      const clientA = {
        session: { create: vi.fn(), prompt: vi.fn(), abort: vi.fn() },
        event: { subscribe: vi.fn() },
      } as unknown as OpencodeClient;

      const clientB = {
        session: { create: vi.fn(), prompt: vi.fn(), abort: vi.fn() },
        event: { subscribe: vi.fn() },
      } as unknown as OpencodeClient;

      const a = OpencodeClientManager.createInstance({ client: clientA });
      const b = OpencodeClientManager.createInstance({ client: clientB });

      await a.dispose();

      await expect(a.getClient()).rejects.toThrow("disposed");
      expect(await b.getClient()).toBe(clientB);
    });
  });
});
