import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpencodeClientManager, createClientManager, createClientManagerFromSettings } from './opencode-client-manager.js';

// Mock the @opencode-ai/sdk module
vi.mock('@opencode-ai/sdk', () => ({
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
    url: 'http://127.0.0.1:4096',
    close: vi.fn(),
  }),
}));

// Mock fetch for health checks
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('opencode-client-manager', () => {
  beforeEach(() => {
    // Reset singleton before each test
    OpencodeClientManager.resetInstance();
    vi.clearAllMocks();

    // Default: server not running (health check fails)
    mockFetch.mockRejectedValue(new Error('Connection refused'));
  });

  afterEach(() => {
    OpencodeClientManager.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = OpencodeClientManager.getInstance();
      const instance2 = OpencodeClientManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should accept options on first call', () => {
      const instance = OpencodeClientManager.getInstance({
        hostname: 'localhost',
        port: 5000,
      });

      expect(instance).toBeDefined();
    });

    it('should not update options after client initialized', async () => {
      const instance = OpencodeClientManager.getInstance({ port: 4096 });
      await instance.getClient();

      // Try to update options after initialization
      OpencodeClientManager.getInstance({ port: 5000 });

      // Should still use original port
      expect(instance.getServerUrl()).toContain('4096');
    });
  });

  describe('resetInstance', () => {
    it('should reset singleton instance', async () => {
      const instance1 = OpencodeClientManager.getInstance();
      await instance1.getClient();

      OpencodeClientManager.resetInstance();

      const instance2 = OpencodeClientManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('getClient', () => {
    it('should create client when server starts successfully', async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: true,
      });

      const client = await instance.getClient();

      expect(client).toBeDefined();
      expect(client.session).toBeDefined();
    });

    it('should return same client on subsequent calls', async () => {
      const instance = OpencodeClientManager.getInstance();

      const client1 = await instance.getClient();
      const client2 = await instance.getClient();

      expect(client1).toBe(client2);
    });

    it('should throw when disposed', async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.dispose();

      await expect(instance.getClient()).rejects.toThrow('disposed');
    });

    it('should connect to existing server if running', async () => {
      // Simulate server running
      mockFetch.mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      const client = await instance.getClient();
      expect(client).toBeDefined();
    });

    it('should try config endpoint if health fails', async () => {
      // Health fails, config succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Health failed'))
        .mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      const client = await instance.getClient();
      expect(client).toBeDefined();
    });

    it('should throw when server not running and autoStart disabled', async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      await expect(instance.getClient()).rejects.toThrow('No OpenCode server running');
    });

    it('should use baseUrl if provided', async () => {
      const instance = OpencodeClientManager.getInstance({
        baseUrl: 'http://custom-server:8080',
      });

      await instance.getClient();

      const { createOpencodeClient } = await import('@opencode-ai/sdk');
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'http://custom-server:8080',
        })
      );
    });

    it('should handle concurrent getClient calls', async () => {
      const instance = OpencodeClientManager.getInstance();

      const [client1, client2] = await Promise.all([
        instance.getClient(),
        instance.getClient(),
      ]);

      expect(client1).toBe(client2);
    });
  });

  describe('getServerUrl', () => {
    it('should return URL from managed server', async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();

      expect(instance.getServerUrl()).toBe('http://127.0.0.1:4096');
    });

    it('should return baseUrl if provided', () => {
      const instance = OpencodeClientManager.getInstance({
        baseUrl: 'http://custom:8080',
      });

      expect(instance.getServerUrl()).toBe('http://custom:8080');
    });

    it('should return constructed URL from hostname and port', () => {
      const instance = OpencodeClientManager.getInstance({
        hostname: 'localhost',
        port: 5000,
      });

      expect(instance.getServerUrl()).toBe('http://localhost:5000');
    });
  });

  describe('isServerManaged', () => {
    it('should return false before client created', () => {
      const instance = OpencodeClientManager.getInstance();
      expect(instance.isServerManaged()).toBe(false);
    });

    it('should return true when server is started by manager', async () => {
      const instance = OpencodeClientManager.getInstance({
        autoStartServer: true,
      });

      await instance.getClient();

      expect(instance.isServerManaged()).toBe(true);
    });

    it('should return false when connecting to external server', async () => {
      // Server already running
      mockFetch.mockResolvedValueOnce({ ok: true });

      const instance = OpencodeClientManager.getInstance({
        autoStartServer: false,
      });

      await instance.getClient();

      expect(instance.isServerManaged()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should close managed server', async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();

      await instance.dispose();

      const { createOpencodeServer } = await import('@opencode-ai/sdk');
      const server = await (createOpencodeServer as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(server.close).toHaveBeenCalled();
    });

    it('should be idempotent', async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();

      await instance.dispose();
      await instance.dispose();

      // Should not throw
    });

    it('should clear client reference', async () => {
      const instance = OpencodeClientManager.getInstance();
      await instance.getClient();
      await instance.dispose();

      // Attempting to get client should throw
      await expect(instance.getClient()).rejects.toThrow('disposed');
    });
  });

  describe('createClientManager', () => {
    it('should return singleton instance', () => {
      const manager1 = createClientManager();
      const manager2 = createClientManager();

      expect(manager1).toBe(manager2);
    });

    it('should accept options', () => {
      const manager = createClientManager({ port: 5000 });
      expect(manager).toBeDefined();
    });
  });

  describe('createClientManagerFromSettings', () => {
    it('should create manager from provider settings', () => {
      const manager = createClientManagerFromSettings({
        hostname: 'localhost',
        port: 5000,
        autoStartServer: false,
        serverTimeout: 15000,
        defaultSettings: {
          cwd: '/home/user/project',
        },
      });

      expect(manager).toBeDefined();
      expect(manager.getServerUrl()).toBe('http://localhost:5000');
    });

    it('should use baseUrl if provided', () => {
      const manager = createClientManagerFromSettings({
        baseUrl: 'http://custom:8080',
      });

      expect(manager.getServerUrl()).toBe('http://custom:8080');
    });
  });
});
