/**
 * Provider Limitations example for the OpenCode AI SDK provider.
 *
 * This example explicitly demonstrates which AI SDK features are NOT supported
 * by the OpenCode provider. Understanding these limitations helps set correct
 * expectations and suggests workarounds where possible.
 *
 * Note: OpenCode is a server-based architecture that executes tools server-side.
 * It differs from direct API access in several important ways.
 */

import { generateText, streamText, generateObject } from 'ai';
import { createOpencode } from '../dist/index.js';
import { z } from 'zod';

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  console.log('=== OpenCode: Provider Limitations ===\n');
  console.log(
    'This example demonstrates features that are NOT supported or work differently.\n'
  );

  try {
    // 1. Parameters that are silently ignored
    console.log('1. Parameters that are IGNORED (no effect):\n');

    const { text, usage } = await generateText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      prompt: 'Write exactly 5 words.',
      // These parameters are part of the AI SDK spec but are ignored by OpenCode
      temperature: 0.1, // ❌ Ignored - OpenCode doesn't expose temperature
      maxOutputTokens: 10, // ❌ Ignored - OpenCode doesn't expose output limits
      topP: 0.9, // ❌ Ignored - OpenCode doesn't expose nucleus sampling
      topK: 50, // ❌ Ignored - OpenCode doesn't expose top-k sampling
      presencePenalty: 0.5, // ❌ Ignored - OpenCode doesn't expose penalties
      frequencyPenalty: 0.5, // ❌ Ignored - OpenCode doesn't expose penalties
      stopSequences: ['END'], // ❌ Ignored - OpenCode doesn't expose stop sequences
      seed: 12345, // ❌ Ignored - OpenCode doesn't support deterministic output
    });

    console.log('   Result:', text);
    console.log('   Tokens used:', usage.totalTokens);
    console.log(
      '\n   ⚠️  Note: All sampling parameters were silently ignored.'
    );
    console.log('   ⚠️  The provider emits warnings for each ignored parameter.\n');

    // 2. Object generation - supported but via prompt engineering
    console.log('2. Object generation (supported with caveats):\n');

    const PersonSchema = z.object({
      name: z.string(),
      age: z.number(),
      occupation: z.string(),
    });

    try {
      const { object } = await generateObject({
        model: opencode('anthropic/claude-opus-4-5-20251101'),
        schema: PersonSchema,
        prompt: 'Generate a person who is a software developer',
      });
      console.log('   ✅ Object generated:', object);
      console.log('\n   Note: OpenCode uses prompt engineering for JSON mode,');
      console.log('         not native structured output. The AI SDK handles validation.');
      console.log('         Results may occasionally fail schema validation.\n');
    } catch (error: unknown) {
      const err = error as Error;
      console.log('   ❌ Error:', err.message, '\n');
    }

    // 3. Custom tool definitions - ignored
    console.log('3. Custom tool definitions:\n');
    console.log('   ❌ NOT SUPPORTED - Custom tools are ignored');
    console.log('   ℹ️  OpenCode executes its own tools server-side (Read, Write, Bash, etc.)');
    console.log('   ℹ️  You can OBSERVE tool execution but cannot define custom tools.');
    console.log('   ℹ️  Use the streaming API with tool observation to see what tools are used.\n');

    // 4. Image inputs - partially supported
    console.log('4. Image inputs:\n');
    console.log('   ⚠️  PARTIAL - Only base64/data URL images supported');
    console.log('   ❌ Remote image URLs are NOT supported');
    console.log('   ✅ Local images converted to base64 data URLs work');
    console.log('   ℹ️  See image-input.ts for a working example\n');

    // 5. Streaming with ignored parameters
    console.log('5. Streaming with ignored parameters:\n');

    const { textStream } = streamText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      prompt: 'Count to 3 briefly.',
      temperature: 0, // ❌ Still ignored in streaming mode
      maxOutputTokens: 5, // ❌ Still ignored in streaming mode
    });

    process.stdout.write('   Streaming: ');
    for await (const chunk of textStream) {
      process.stdout.write(chunk);
    }
    console.log('\n   ⚠️  Parameters were ignored in streaming mode too\n');

    // 6. Tool result injection - not supported
    console.log('6. Tool result injection:\n');
    console.log('   ❌ NOT SUPPORTED - Cannot provide tool results in prompts');
    console.log('   ℹ️  OpenCode manages its own tool execution loop');
    console.log('   ℹ️  Tool results from prompts are converted to context text only\n');

    // Summary of workarounds
    console.log('=== Workarounds and Recommendations ===\n');

    console.log('For temperature/sampling control:');
    console.log('   - Adjust your prompts to be more specific');
    console.log('   - Use phrases like "be creative" or "be precise"');
    console.log('   - Not possible to get deterministic output\n');

    console.log('For output length control:');
    console.log('   - Specify length in prompt: "Write exactly 50 words"');
    console.log('   - Use explicit instructions: "Keep your response brief"\n');

    console.log('For structured output:');
    console.log('   - ✅ Use generateObject/streamObject with Zod schemas');
    console.log('   - The AI SDK handles validation and retries');
    console.log('   - May occasionally fail with complex schemas\n');

    console.log('For custom tools/functions:');
    console.log('   - Not possible - OpenCode uses server-side tools');
    console.log('   - Implement your own prompt-based routing');
    console.log("   - Parse Claude's response to determine actions\n");

    console.log('For deterministic output:');
    console.log('   - Not possible with OpenCode');
    console.log('   - Each request will produce different results\n');

    console.log('=== What DOES Work Well ===\n');
    console.log('✅ Basic text generation and streaming');
    console.log('✅ Structured outputs via generateObject/streamObject');
    console.log('✅ Multi-turn conversations (session persistence)');
    console.log('✅ Tool observation (see what tools are executed)');
    console.log('✅ Abort signals for cancellation');
    console.log('✅ System prompts and custom agents');
    console.log('✅ Base64 image inputs (vision models)');
    console.log('✅ Custom logging configuration');
    console.log('✅ Session management (resume, new session)');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
