import { describe, it, expect } from 'vitest';
import {
  mapOpencodeFinishReason,
  mapErrorToFinishReasonFromUnknown,
  hasToolCalls,
} from './map-opencode-finish-reason.js';

describe('map-opencode-finish-reason', () => {
  describe('mapOpencodeFinishReason', () => {
    it('should return "unknown" for undefined message', () => {
      expect(mapOpencodeFinishReason(undefined)).toBe('unknown');
    });

    it('should return "stop" for end_turn finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'end_turn' })).toBe('stop');
    });

    it('should return "stop" for stop finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'stop' })).toBe('stop');
    });

    it('should return "stop" for end finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'end' })).toBe('stop');
    });

    it('should return "length" for max_tokens finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'max_tokens' })).toBe('length');
    });

    it('should return "length" for length finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'length' })).toBe('length');
    });

    it('should return "tool-calls" for tool_use finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'tool_use' })).toBe('tool-calls');
    });

    it('should return "tool-calls" for tool_calls finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'tool_calls' })).toBe('tool-calls');
    });

    it('should return "content-filter" for content_filter finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'content_filter' })).toBe('content-filter');
    });

    it('should return "content-filter" for safety finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'safety' })).toBe('content-filter');
    });

    it('should return "error" for error finish', () => {
      expect(mapOpencodeFinishReason({ finish: 'error' })).toBe('error');
    });

    it('should return "stop" for unknown finish values', () => {
      expect(mapOpencodeFinishReason({ finish: 'unknown_value' })).toBe('stop');
    });

    it('should be case insensitive for finish values', () => {
      expect(mapOpencodeFinishReason({ finish: 'END_TURN' })).toBe('stop');
      expect(mapOpencodeFinishReason({ finish: 'MAX_TOKENS' })).toBe('length');
      expect(mapOpencodeFinishReason({ finish: 'Tool_Use' })).toBe('tool-calls');
    });

    // Error handling
    it('should return "stop" for MessageAbortedError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'MessageAbortedError' },
        })
      ).toBe('stop');
    });

    it('should return "length" for MessageOutputLengthError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'MessageOutputLengthError' },
        })
      ).toBe('length');
    });

    it('should return "error" for ProviderAuthError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'ProviderAuthError' },
        })
      ).toBe('error');
    });

    it('should return "error" for APIError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'APIError' },
        })
      ).toBe('error');
    });

    it('should return "error" for UnknownError', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'UnknownError' },
        })
      ).toBe('error');
    });

    it('should return "error" for unknown error types', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'SomeOtherError' },
        })
      ).toBe('error');
    });

    it('should prioritize error over finish', () => {
      expect(
        mapOpencodeFinishReason({
          error: { name: 'APIError' },
          finish: 'end_turn',
        })
      ).toBe('error');
    });

    it('should return "stop" for message without error or finish', () => {
      expect(mapOpencodeFinishReason({})).toBe('stop');
    });
  });

  describe('mapErrorToFinishReasonFromUnknown', () => {
    it('should return "stop" for abort errors', () => {
      const error = { name: 'AbortError' };
      expect(mapErrorToFinishReasonFromUnknown(error)).toBe('stop');
    });

    it('should return "stop" for MessageAbortedError', () => {
      const error = { name: 'MessageAbortedError' };
      expect(mapErrorToFinishReasonFromUnknown(error)).toBe('stop');
    });

    it('should return "length" for output length errors', () => {
      const error = { name: 'MessageOutputLengthError' };
      expect(mapErrorToFinishReasonFromUnknown(error)).toBe('length');
    });

    it('should return "length" for max tokens error message', () => {
      const error = { message: 'Max tokens exceeded' };
      expect(mapErrorToFinishReasonFromUnknown(error)).toBe('length');
    });

    it('should return "error" for other errors', () => {
      const error = { name: 'NetworkError', message: 'Connection failed' };
      expect(mapErrorToFinishReasonFromUnknown(error)).toBe('error');
    });

    it('should return "error" for null', () => {
      expect(mapErrorToFinishReasonFromUnknown(null)).toBe('error');
    });
  });

  describe('hasToolCalls', () => {
    it('should return true when parts contain tool type', () => {
      const parts = [
        { type: 'text' },
        { type: 'tool' },
        { type: 'text' },
      ];
      expect(hasToolCalls(parts)).toBe(true);
    });

    it('should return false when parts have no tool type', () => {
      const parts = [
        { type: 'text' },
        { type: 'reasoning' },
        { type: 'step-finish' },
      ];
      expect(hasToolCalls(parts)).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(hasToolCalls([])).toBe(false);
    });

    it('should handle multiple tool parts', () => {
      const parts = [
        { type: 'tool' },
        { type: 'tool' },
      ];
      expect(hasToolCalls(parts)).toBe(true);
    });
  });
});
