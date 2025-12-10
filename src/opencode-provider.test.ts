import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpencode, opencode, OpencodeModels } from './opencode-provider.js';
import { OpencodeClientManager } from './opencode-client-manager.js';

// Mock the client manager
vi.mock('./opencode-client-manager.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./opencode-client-manager.js')>();
  return {
    ...original,
    OpencodeClientManager: {
      getInstance: vi.fn().mockReturnValue({
        getClient: vi.fn().mockResolvedValue({
          session: {
            create: vi.fn(),
            prompt: vi.fn(),
            abort: vi.fn(),
          },
          event: {
            subscribe: vi.fn(),
          },
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
        getServerUrl: vi.fn().mockReturnValue('http://127.0.0.1:4096'),
      }),
      resetInstance: vi.fn(),
    },
    createClientManagerFromSettings: vi.fn().mockReturnValue({
      getClient: vi.fn().mockResolvedValue({}),
      dispose: vi.fn().mockResolvedValue(undefined),
      getServerUrl: vi.fn().mockReturnValue('http://127.0.0.1:4096'),
    }),
  };
});

describe('opencode-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    OpencodeClientManager.resetInstance();
  });

  describe('createOpencode', () => {
    it('should create provider without options', () => {
      const provider = createOpencode();

      expect(provider).toBeDefined();
      expect(typeof provider).toBe('function');
    });

    it('should create provider with options', () => {
      const provider = createOpencode({
        hostname: 'localhost',
        port: 5000,
        autoStartServer: false,
      });

      expect(provider).toBeDefined();
    });

    it('should create language model when called as function', () => {
      const provider = createOpencode();
      const model = provider('anthropic/claude-opus-4-5-20251101');

      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-opus-4-5-20251101');
      expect(model.provider).toBe('opencode');
    });

    it('should merge default settings with model settings', () => {
      const provider = createOpencode({
        defaultSettings: {
          agent: 'build',
          verbose: true,
        },
      });

      const model = provider('anthropic/claude-opus-4-5-20251101', {
        agent: 'plan',
      });

      expect(model).toBeDefined();
    });
  });

  describe('provider methods', () => {
    it('should have languageModel method', () => {
      const provider = createOpencode();

      expect(provider.languageModel).toBeDefined();
      expect(typeof provider.languageModel).toBe('function');
    });

    it('should have chat method (alias)', () => {
      const provider = createOpencode();

      expect(provider.chat).toBeDefined();
      expect(typeof provider.chat).toBe('function');
    });

    it('should have provider property', () => {
      const provider = createOpencode();

      expect(provider.provider).toBe('opencode');
    });

    it('should have getClientManager method', () => {
      const provider = createOpencode();

      const clientManager = provider.getClientManager();
      expect(clientManager).toBeDefined();
    });

    it('should have dispose method', async () => {
      const provider = createOpencode();

      expect(provider.dispose).toBeDefined();
      await expect(provider.dispose()).resolves.toBeUndefined();
    });

    it('languageModel should create same model as direct call', () => {
      const provider = createOpencode();

      const model1 = provider('anthropic/claude-opus-4-5-20251101');
      const model2 = provider.languageModel('anthropic/claude-opus-4-5-20251101');

      expect(model1.modelId).toBe(model2.modelId);
    });

    it('chat should create same model as languageModel', () => {
      const provider = createOpencode();

      const model1 = provider.languageModel('anthropic/claude-opus-4-5-20251101');
      const model2 = provider.chat('anthropic/claude-opus-4-5-20251101');

      expect(model1.modelId).toBe(model2.modelId);
    });
  });

  describe('model creation', () => {
    it('should pass settings to model', () => {
      const provider = createOpencode();
      const model = provider('anthropic/claude-opus-4-5-20251101', {
        sessionId: 'test-session',
        agent: 'build',
      });

      expect(model).toBeDefined();
    });

    it('should handle model-only ID format', () => {
      const provider = createOpencode();
      const model = provider('claude-opus-4-5-20251101');

      expect(model.modelId).toBe('claude-opus-4-5-20251101');
    });

    it('should handle provider/model ID format', () => {
      const provider = createOpencode();
      const model = provider('openai/gpt-4o');

      expect(model.modelId).toBe('openai/gpt-4o');
    });
  });

  describe('default provider instance', () => {
    it('should export default opencode instance', () => {
      expect(opencode).toBeDefined();
      expect(typeof opencode).toBe('function');
    });

    it('should create model from default instance', () => {
      const model = opencode('anthropic/claude-opus-4-5-20251101');

      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-opus-4-5-20251101');
    });
  });

  describe('OpencodeModels', () => {
    it('should have Anthropic model shortcuts', () => {
      expect(OpencodeModels['claude-sonnet-4-5']).toBe('anthropic/claude-sonnet-4-5-20250929');
      expect(OpencodeModels['claude-haiku-4-5']).toBe('anthropic/claude-haiku-4-5-20251001');
      expect(OpencodeModels['claude-opus-4-5']).toBe('anthropic/claude-opus-4-5-20251101');
    });

    it('should have OpenAI model shortcuts', () => {
      expect(OpencodeModels['gpt-4o']).toBe('openai/gpt-4o');
      expect(OpencodeModels['gpt-4o-mini']).toBe('openai/gpt-4o-mini');
    });

    it('should have Google model shortcuts', () => {
      expect(OpencodeModels['gemini-3-pro']).toBe('google/gemini-3-pro-preview');
      expect(OpencodeModels['gemini-2.5-flash']).toBe('google/gemini-2.5-flash');
      expect(OpencodeModels['gemini-2.5-pro']).toBe('google/gemini-2.5-pro');
      expect(OpencodeModels['gemini-2.0-flash']).toBe('google/gemini-2.0-flash');
    });

    it('should use shortcuts with provider', () => {
      const provider = createOpencode();
      const model = provider(OpencodeModels['claude-sonnet-4-5']);

      expect(model.modelId).toBe('anthropic/claude-sonnet-4-5-20250929');
    });
  });

  describe('validation warnings', () => {
    it('should log validation warnings for invalid settings', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      createOpencode({
        port: 70000, // Invalid port
        defaultSettings: {
          sessionId: 'invalid session id!',
        },
      });

      // Should have logged warnings
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });
});
