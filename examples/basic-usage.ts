/**
 * Basic usage example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Creating a provider instance
 * - Generating text with generateText()
 * - Handling the response
 */

import { generateText } from 'ai';
import { createOpencode } from '../dist/index.js';

async function main() {
  // Create provider with auto-start server
  const opencode = createOpencode({
    autoStartServer: true,
    serverTimeout: 10000,
  });

  try {
    console.log('Generating text with OpenCode...\n');

    // Generate text using Claude
    const result = await generateText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      prompt: 'What is the capital of France? Answer in one sentence.',
    });

    console.log('Response:', result.text);
    console.log('\nUsage:', result.usage);
    console.log('Finish reason:', result.finishReason);

    // Access provider metadata
    const metadata = result.providerMetadata?.opencode;
    if (metadata) {
      console.log('Session ID:', metadata.sessionId);
      console.log('Cost:', metadata.cost);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Clean up
    await opencode.dispose?.();
  }
}

main().catch(console.error);
