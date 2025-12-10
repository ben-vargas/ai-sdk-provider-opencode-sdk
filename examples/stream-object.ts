/**
 * Streaming Object Generation example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Using streamObject() for incremental structured output
 * - Receiving partial objects as they're generated
 * - Real-time progress tracking
 *
 * Note: OpenCode uses prompt engineering for JSON mode, not native
 * structured output. The AI SDK handles streaming and validation.
 */

import { streamObject } from 'ai';
import { createOpencode } from '../dist/index.js';
import { z } from 'zod';

// Define a schema for the structured output
const articleSchema = z.object({
  title: z.string().describe('Article title'),
  author: z.string().describe('Author name'),
  summary: z.string().describe('Brief summary (2-3 sentences)'),
  sections: z
    .array(
      z.object({
        heading: z.string().describe('Section heading'),
        content: z.string().describe('Section content (1-2 paragraphs)'),
      })
    )
    .describe('Article sections'),
  tags: z.array(z.string()).describe('Relevant tags'),
  readingTimeMinutes: z.number().describe('Estimated reading time'),
});

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    console.log('=== OpenCode: Stream Object Example ===\n');
    console.log('Generating a technical article with real-time partial updates...\n');

    const startTime = Date.now();
    let firstPartialTime: number | null = null;
    let partialCount = 0;

    const { partialObjectStream, object } = streamObject({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      schema: articleSchema,
      prompt:
        'Generate a short technical article about the benefits of TypeScript for large-scale applications. Include 2-3 sections.',
    });

    console.log('--- Streaming Progress ---\n');

    for await (const partial of partialObjectStream) {
      partialCount++;

      if (!firstPartialTime) {
        firstPartialTime = Date.now();
        console.log(`[First partial received after ${firstPartialTime - startTime}ms]\n`);
      }

      // Show field completion progress
      const hasTitle = 'title' in partial && partial.title;
      const hasAuthor = 'author' in partial && partial.author;
      const hasSummary = 'summary' in partial && partial.summary;
      const sectionsCount =
        'sections' in partial && Array.isArray(partial.sections) ? partial.sections.length : 0;
      const tagsCount =
        'tags' in partial && Array.isArray(partial.tags) ? partial.tags.length : 0;
      const hasReadingTime =
        'readingTimeMinutes' in partial && partial.readingTimeMinutes !== undefined;

      // Log select updates to show streaming progress
      if (partialCount <= 5 || partialCount % 10 === 0) {
        console.log(
          `  Partial #${partialCount}: title=${hasTitle ? '✓' : '...'} author=${hasAuthor ? '✓' : '...'} summary=${hasSummary ? '✓' : '...'} sections=${sectionsCount} tags=${tagsCount} readingTime=${hasReadingTime ? '✓' : '...'}`
        );
      }
    }

    // Get the final validated object
    const finalObject = await object;
    const endTime = Date.now();

    console.log('\n--- Final Object ---\n');
    console.log(JSON.stringify(finalObject, null, 2));

    console.log('\n--- Statistics ---');
    console.log(`Total partial updates: ${partialCount}`);
    console.log(`Time to first partial: ${firstPartialTime ? firstPartialTime - startTime : 0}ms`);
    console.log(`Total time: ${endTime - startTime}ms`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
