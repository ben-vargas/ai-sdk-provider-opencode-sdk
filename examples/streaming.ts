/**
 * Streaming example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Streaming text generation with streamText()
 * - Processing stream chunks
 * - Handling tool observations
 */

import { streamText } from "ai";
import { createOpencode } from "../dist/index.js";

async function main() {
  // Create provider
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    console.log("Streaming text with OpenCode...\n");

    // Stream text
    const result = streamText({
      model: opencode("anthropic/claude-opus-4-5-20251101"),
      prompt: "Count from 1 to 5, explaining each number briefly.",
    });

    // Process the text stream
    console.log("Response:\n");
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    console.log("\n");

    // Get final result - usage and finishReason are promises that resolve after stream completes
    const [usage, finishReason] = await Promise.all([
      result.usage,
      result.finishReason,
    ]);
    console.log("\nUsage:", usage);
    console.log("Finish reason:", finishReason);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
