/**
 * Long-Running Tasks example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Custom timeouts using AbortSignal
 * - User-cancellable requests
 * - Graceful timeout with retry logic
 * - Timeout helper patterns
 *
 * Note: These patterns are useful when tasks may take varying amounts
 * of time, such as code analysis, file operations, or complex generation.
 */

import { generateText, streamText } from 'ai';
import { createOpencode } from '../dist/index.js';

const opencode = createOpencode({
  autoStartServer: true,
});

/**
 * Helper function to create an AbortController with a timeout.
 */
function createTimeoutController(
  ms: number,
  reason = 'Request timeout'
): AbortController & { clearTimeout: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`${reason} after ${ms}ms`));
  }, ms);

  return Object.assign(controller, {
    clearTimeout: () => clearTimeout(timeoutId),
  });
}

/**
 * Example 1: Custom timeout for long task
 */
async function withTimeout() {
  console.log('1. Custom timeout for long task:\n');

  // Create an AbortController with a 30-second timeout
  const controller = createTimeoutController(30000, 'Long task timeout');

  try {
    console.log('   Starting task with 30-second timeout...');

    const { text } = await generateText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      prompt: 'Explain quantum computing in 2 sentences.',
      abortSignal: controller.signal,
    });

    controller.clearTimeout(); // Clear timeout on success
    console.log('   Response:', text);
    console.log('   ✅ Completed within timeout\n');
  } catch (error: unknown) {
    controller.clearTimeout();
    const err = error as Error;

    if (err.name === 'AbortError' || err.message?.includes('timeout')) {
      console.log('   ❌ Request timed out after 30 seconds');
      console.log('   Consider breaking the task into smaller parts\n');
    } else {
      console.error('   Error:', err.message, '\n');
    }
  }
}

/**
 * Example 2: User-cancellable STREAMING request
 * Note: Abort signals work best with streaming requests since they can
 * be cancelled mid-generation. Non-streaming requests complete atomically.
 */
async function withUserCancellation() {
  console.log('2. User-cancellable streaming request:\n');

  const controller = new AbortController();
  let charCount = 0;

  // Simulate user cancellation after 100 characters
  console.log('   Starting streaming task (will cancel after 100 chars)...');
  process.stdout.write('   Output: ');

  try {
    const { textStream } = streamText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      prompt: 'Write a comprehensive guide to machine learning.',
      abortSignal: controller.signal,
    });

    for await (const chunk of textStream) {
      process.stdout.write(chunk);
      charCount += chunk.length;

      if (charCount > 100) {
        console.log('\n   [User clicked cancel at', charCount, 'characters]');
        controller.abort();
        break;
      }
    }
    console.log('   ✅ Streaming request cancelled by user\n');
  } catch (error: unknown) {
    const err = error as Error;

    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      console.log('   ✅ Request successfully cancelled by user\n');
    } else {
      console.error('   Error:', err.message, '\n');
    }
  }
}

/**
 * Example 3: Graceful timeout with retry
 */
async function withGracefulTimeout() {
  console.log('3. Graceful timeout with retry option:\n');

  async function attemptWithTimeout(
    timeoutMs: number
  ): Promise<{ success: boolean; text?: string; timeout?: boolean }> {
    const controller = createTimeoutController(timeoutMs);

    try {
      const { text } = await generateText({
        model: opencode('anthropic/claude-opus-4-5-20251101'),
        prompt: 'What is the theory of relativity in one sentence?',
        abortSignal: controller.signal,
      });

      controller.clearTimeout();
      return { success: true, text };
    } catch (error: unknown) {
      controller.clearTimeout();
      const err = error as Error;

      if (err.name === 'AbortError') {
        return { success: false, timeout: true };
      }
      throw error;
    }
  }

  // Try with 30-second timeout first
  console.log('   Attempting with 30-second timeout...');
  let result = await attemptWithTimeout(30000);

  if (!result.success && result.timeout) {
    console.log('   ⏱️  First attempt timed out, trying with 60-second timeout...');

    // Retry with longer timeout
    result = await attemptWithTimeout(60000);
  }

  if (result.success) {
    console.log('   ✅ Success:', result.text);
  } else {
    console.log('   ❌ Failed even with extended timeout');
  }
  console.log();
}

/**
 * Example 4: Progress tracking pattern
 */
async function withProgressTracking() {
  console.log('4. Progress tracking for long tasks:\n');

  const startTime = Date.now();
  const controller = createTimeoutController(60000, 'Progress task timeout');

  // Set up progress indicator
  const progressInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   ⏳ Running... ${elapsed}s elapsed`);
  }, 1000);

  try {
    const { text, usage } = await generateText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      prompt: 'Explain the benefits of TypeScript in 3 bullet points.',
      abortSignal: controller.signal,
    });

    clearInterval(progressInterval);
    controller.clearTimeout();

    const totalTime = Math.floor((Date.now() - startTime) / 1000);
    console.log(`\r   ✅ Completed in ${totalTime}s                    `);
    console.log('   Response:', text.substring(0, 150) + '...');
    console.log('   Tokens:', usage.totalTokens, '\n');
  } catch (error: unknown) {
    clearInterval(progressInterval);
    controller.clearTimeout();
    const err = error as Error;
    console.log('\r   ❌ Error:', err.message, '                    \n');
  }
}

async function main() {
  console.log('=== OpenCode: Long-Running Task Examples ===\n');
  console.log('These examples show how to handle timeouts and cancellation');
  console.log('for tasks that may take varying amounts of time.\n');

  try {
    await withTimeout();
    await withUserCancellation();
    await withGracefulTimeout();
    await withProgressTracking();

    console.log('=== Key Takeaways ===\n');
    console.log('- Use AbortController for all cancellation needs');
    console.log('- Set custom timeouts based on expected task complexity');
    console.log('- Always clear timeouts on success to prevent memory leaks');
    console.log('- Consider retry logic with extended timeouts for important tasks');
    console.log('- Complex tasks (code analysis, file operations) may need 1-5 minutes');
    console.log('- Simple generations typically complete in seconds\n');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
