/**
 * Abort Signal example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Cancelling in-progress requests using AbortController
 * - Timeout implementation patterns
 * - User-initiated cancellation
 * - Streaming cancellation after partial response
 *
 * Note: OpenCode supports session.abort() which cleanly terminates
 * the current request on the server side.
 */

import { generateText, streamText } from 'ai';
import { createOpencode } from '../dist/index.js';

// Suppress uncaught abort errors from child processes
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
    // Silently ignore abort errors - they're expected
    return;
  }
  // Re-throw other errors
  throw err;
});

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  console.log('=== OpenCode: Abort Signal Examples ===\n');

  try {
    // Example 1: Successful request with 30 second timeout
    console.log('1. Request with generous timeout (30 seconds)...\n');

    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => {
      console.log('   ⏱️  Cancelling request...');
      controller1.abort();
    }, 30000);

    try {
      const { text } = await generateText({
        model: opencode('anthropic/claude-opus-4-5-20251101'),
        prompt: 'What is 2 + 2? Answer with just the number.',
        abortSignal: controller1.signal,
      });

      clearTimeout(timeout1);
      console.log('   Response:', text);
      console.log('   ✅ Completed within timeout\n');
    } catch (error: unknown) {
      clearTimeout(timeout1);
      const err = error as Error;
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        console.log('   ✅ Request successfully cancelled\n');
      } else {
        console.error('   ❌ Error:', err.message);
      }
    }

    // Example 2: Immediate cancellation (before request starts)
    console.log('2. Testing immediate cancellation (before request starts)...\n');

    const controller2 = new AbortController();
    controller2.abort(); // Cancel immediately

    try {
      await generateText({
        model: opencode('anthropic/claude-opus-4-5-20251101'),
        prompt: 'This should not execute',
        abortSignal: controller2.signal,
      });

      console.log('   ❌ This should not be reached');
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        console.log('   ✅ Request cancelled before execution\n');
      } else {
        console.error('   ❌ Error:', err.message);
      }
    }

    // Example 3: Streaming cancellation after partial response
    console.log('3. Testing streaming cancellation after partial response...\n');

    const controller3 = new AbortController();
    let charCount = 0;

    try {
      const { textStream } = streamText({
        model: opencode('anthropic/claude-opus-4-5-20251101'),
        prompt: 'Count slowly from 1 to 20, explaining each number in detail.',
        abortSignal: controller3.signal,
      });

      process.stdout.write('   Streaming: ');
      for await (const chunk of textStream) {
        process.stdout.write(chunk);
        charCount += chunk.length;

        // Cancel after receiving 100 characters
        if (charCount > 100) {
          console.log('\n   ⏱️  Cancelling stream after', charCount, 'characters...');
          controller3.abort();
          break;
        }
      }
      console.log('   ✅ Stream cancelled successfully\n');
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        console.log('   ✅ Stream successfully cancelled\n');
      } else {
        console.error('   ❌ Error:', err.message);
      }
    }

    // Example 4: Timeout helper function
    console.log('4. Using timeout helper pattern...\n');

    function createTimeoutController(ms: number, reason = 'Request timeout'): AbortController {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error(`${reason} after ${ms}ms`));
      }, ms);

      // Store cleanup function
      (controller as AbortController & { clearTimeout: () => void }).clearTimeout = () =>
        clearTimeout(timeoutId);

      return controller;
    }

    const controller4 = createTimeoutController(60000, 'Analysis timeout');

    try {
      const { text } = await generateText({
        model: opencode('anthropic/claude-opus-4-5-20251101'),
        prompt: 'What is 2 + 2?',
        abortSignal: controller4.signal,
      });

      (controller4 as AbortController & { clearTimeout: () => void }).clearTimeout();
      console.log('   Response:', text);
      console.log('   ✅ Completed within timeout\n');
    } catch (error: unknown) {
      const err = error as Error;
      console.error('   ❌ Error:', err.message);
    }

    console.log('=== Use Cases for AbortSignal ===\n');
    console.log('- User-initiated cancellations (e.g., "Stop generating" button)');
    console.log('- Component unmount cleanup in React/Vue');
    console.log('- Request timeouts');
    console.log('- Rate limiting and request management');
    console.log('- Graceful shutdown handling');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await opencode.dispose?.();
    // Force exit since AbortController may leave pending timers
    process.exit(0);
  }
}

main().catch(console.error);
