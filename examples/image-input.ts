/**
 * Image Input example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Sending images to vision-capable models
 * - Converting local images to base64 data URLs
 * - Using the file part type in messages
 *
 * Note: Image input requires a vision-capable model (e.g., Claude, GPT-4o).
 * Only base64/data URL images are supported - remote URLs are not supported.
 */

import { readFileSync } from 'node:fs';
import { extname, basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamText } from 'ai';
import { createOpencode } from '../dist/index.js';

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function toDataUrl(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mediaType = SUPPORTED_EXTENSIONS[ext];
  if (!mediaType) {
    throw new Error(
      `Unsupported image extension "${ext}". Supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(', ')}`
    );
  }

  const contents = readFileSync(filePath);
  const base64 = contents.toString('base64');
  return `data:${mediaType};base64,${base64}`;
}

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    // Use bundled bull.webp as default if no path provided
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const defaultImagePath = join(__dirname, 'bull.webp');

    const filePath = process.argv[2] || defaultImagePath;
    if (!process.argv[2]) {
      console.log(`Using default image: ${defaultImagePath}`);
      console.log(
        'Tip: Pass a custom image path as argument: node image-input.ts /path/to/image.png\n'
      );
    }

    console.log('Analyzing image with OpenCode...\n');

    const dataUrl = toDataUrl(filePath);
    const ext = extname(filePath).toLowerCase();
    const mediaType = SUPPORTED_EXTENSIONS[ext]!;

    const result = streamText({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Describe the mood conveyed by "${basename(filePath)}" in one sentence.`,
            },
            { type: 'file', data: dataUrl, mediaType },
          ],
        },
      ],
    });

    process.stdout.write('Assistant: ');
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');

    // Get final usage
    const [usage, finishReason] = await Promise.all([result.usage, result.finishReason]);
    console.log('\nUsage:', usage);
    console.log('Finish reason:', finishReason);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
