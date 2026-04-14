import { describe, it, expect, vi } from 'vitest';
import {
  validateSettings,
  validateProviderSettings,
  validateModelId,
  isValidSessionId,
  mergeSettings,
} from './validation.js';
import type { Logger } from './types.js';

describe('validation', () => {
  describe('validateSettings', () => {
    it('should return empty object for undefined settings', () => {
      const result = validateSettings(undefined);
      expect(result.value).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });

    it('should pass valid settings through unchanged', () => {
      const settings = {
        sessionId: 'test-session-123',
        createNewSession: false,
        sessionTitle: 'Test Session',
        agent: 'build',
        systemPrompt: 'You are helpful',
        tools: { Bash: true, Write: false },
        cwd: '/home/user',
        verbose: true,
      };

      const result = validateSettings(settings);
      expect(result.value).toEqual(settings);
      expect(result.warnings).toHaveLength(0);
    });

    it('should warn about invalid session ID format', () => {
      const settings = {
        sessionId: 'invalid session id with spaces!@#',
      };

      const result = validateSettings(settings);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('Invalid session ID'))).toBe(true);
    });

    it('should log warnings when logger is provided', () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const settings = {
        sessionId: 'bad session!',
      };

      validateSettings(settings, logger);
      expect(logger.warn).toHaveBeenCalled();
    });

    describe('logger schema (zod 3/4 compatibility)', () => {
      // Regression tests for https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/issues/17
      // The loggerSchema was previously built with `z.function().args().returns()`
      // which was removed in zod 4. These tests exercise the settings.logger
      // validation path to ensure it works across both major zod versions.

      it('should accept a valid logger with warn and error functions', () => {
        const settings = {
          logger: {
            warn: vi.fn(),
            error: vi.fn(),
          },
        };

        const result = validateSettings(settings);
        expect(result.warnings).toHaveLength(0);
      });

      it('should accept a valid logger with optional debug function', () => {
        const settings = {
          logger: {
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        };

        const result = validateSettings(settings);
        expect(result.warnings).toHaveLength(0);
      });

      it('should accept logger === false (disables logging)', () => {
        const settings = {
          logger: false as const,
        };

        const result = validateSettings(settings);
        expect(result.warnings).toHaveLength(0);
      });

      it('should reject logger where warn is not a function', () => {
        const settings = {
          logger: {
            warn: 'not a function',
            error: vi.fn(),
          },
        } as unknown as Parameters<typeof validateSettings>[0];

        const result = validateSettings(settings);
        expect(
          result.warnings.some((w) => w.includes('Settings validation'))
        ).toBe(true);
      });

      it('should reject logger where error is missing', () => {
        const settings = {
          logger: {
            warn: vi.fn(),
          },
        } as unknown as Parameters<typeof validateSettings>[0];

        const result = validateSettings(settings);
        expect(
          result.warnings.some((w) => w.includes('Settings validation'))
        ).toBe(true);
      });

      it('should validate nested logger under defaultSettings in provider schema', () => {
        const providerSettings = {
          hostname: 'localhost',
          defaultSettings: {
            logger: {
              warn: vi.fn(),
              error: vi.fn(),
            },
          },
        };

        const result = validateProviderSettings(providerSettings);
        expect(result.warnings).toHaveLength(0);
      });
    });
  });

  describe('validateProviderSettings', () => {
    it('should return empty object for undefined settings', () => {
      const result = validateProviderSettings(undefined);
      expect(result.value).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });

    it('should pass valid provider settings through', () => {
      const settings = {
        hostname: 'localhost',
        port: 4096,
        autoStartServer: true,
        serverTimeout: 10000,
      };

      const result = validateProviderSettings(settings);
      expect(result.value).toEqual(settings);
      expect(result.warnings).toHaveLength(0);
    });

    it('should warn about invalid port', () => {
      const settings = {
        port: 70000,
      };

      const result = validateProviderSettings(settings);
      expect(result.warnings.some((w) => w.includes('port') || w.includes('Port'))).toBe(true);
    });

    it('should warn about very short timeout', () => {
      const settings = {
        serverTimeout: 100,
      };

      const result = validateProviderSettings(settings);
      expect(result.warnings.some((w) => w.includes('timeout'))).toBe(true);
    });
  });

  describe('validateModelId', () => {
    it('should parse provider/model format', () => {
      const result = validateModelId('anthropic/claude-3-5-sonnet-20241022');
      expect(result).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-3-5-sonnet-20241022',
      });
    });

    it('should handle model-only format', () => {
      const result = validateModelId('claude-3-5-sonnet-20241022');
      expect(result).toEqual({
        providerID: '',
        modelID: 'claude-3-5-sonnet-20241022',
      });
    });

    it('should return null for empty string', () => {
      const result = validateModelId('');
      expect(result).toBeNull();
    });

    it('should return null for whitespace-only string', () => {
      const result = validateModelId('   ');
      expect(result).toBeNull();
    });

    it('should handle multiple slashes', () => {
      const result = validateModelId('org/provider/model');
      expect(result).not.toBeNull();
      expect(result?.modelID).toBe('model');
    });

    it('should trim whitespace', () => {
      const result = validateModelId('  anthropic/claude  ');
      expect(result).toEqual({
        providerID: 'anthropic',
        modelID: 'claude',
      });
    });

    it('should log error for invalid model ID when logger provided', () => {
      const logger: Logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      validateModelId('', logger);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('isValidSessionId', () => {
    it('should accept valid UUID-like session IDs', () => {
      expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should accept alphanumeric session IDs', () => {
      expect(isValidSessionId('abc123')).toBe(true);
    });

    it('should accept session IDs with underscores', () => {
      expect(isValidSessionId('session_123_abc')).toBe(true);
    });

    it('should accept session IDs with hyphens', () => {
      expect(isValidSessionId('session-123-abc')).toBe(true);
    });

    it('should reject empty strings', () => {
      expect(isValidSessionId('')).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(isValidSessionId(null as unknown as string)).toBe(false);
      expect(isValidSessionId(undefined as unknown as string)).toBe(false);
    });

    it('should reject session IDs with spaces', () => {
      expect(isValidSessionId('session 123')).toBe(false);
    });

    it('should reject session IDs with special characters', () => {
      expect(isValidSessionId('session@123')).toBe(false);
      expect(isValidSessionId('session!123')).toBe(false);
    });

    it('should reject very long session IDs', () => {
      const longId = 'a'.repeat(200);
      expect(isValidSessionId(longId)).toBe(false);
    });
  });

  describe('mergeSettings', () => {
    it('should return empty object when both are undefined', () => {
      const result = mergeSettings(undefined, undefined);
      expect(result).toEqual({});
    });

    it('should return defaults when overrides is undefined', () => {
      const defaults = { agent: 'build', verbose: true };
      const result = mergeSettings(defaults, undefined);
      expect(result).toEqual(defaults);
    });

    it('should return overrides when defaults is undefined', () => {
      const overrides = { agent: 'plan', verbose: false };
      const result = mergeSettings(undefined, overrides);
      expect(result).toEqual(overrides);
    });

    it('should merge settings with overrides taking precedence', () => {
      const defaults = { agent: 'build', verbose: true, sessionTitle: 'Default' };
      const overrides = { agent: 'plan', cwd: '/home' };
      const result = mergeSettings(defaults, overrides);

      expect(result).toEqual({
        agent: 'plan',
        verbose: true,
        sessionTitle: 'Default',
        cwd: '/home',
      });
    });

    it('should merge tools objects', () => {
      const defaults = { tools: { Bash: true, Write: true } };
      const overrides = { tools: { Write: false, Read: true } };
      const result = mergeSettings(defaults, overrides);

      expect(result.tools).toEqual({
        Bash: true,
        Write: false,
        Read: true,
      });
    });

    it('should handle tools in defaults only', () => {
      const defaults = { tools: { Bash: true } };
      const overrides = { agent: 'build' };
      const result = mergeSettings(defaults, overrides);

      expect(result.tools).toEqual({ Bash: true });
    });

    it('should handle tools in overrides only', () => {
      const defaults = { agent: 'build' };
      const overrides = { tools: { Bash: false } };
      const result = mergeSettings(defaults, overrides);

      expect(result.tools).toEqual({ Bash: false });
    });
  });
});
