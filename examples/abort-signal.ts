/**
 * Cancellation with AbortSignal.
 *
 * Requires an OpenCode 2.x server — see examples/env.ts for the server
 * requirement and environment variables.
 *
 * What abort does server-side depends on where the turn is:
 *   - before the prompt is delivered: the pending inbox item is cancelled
 *     (`session.inbox.cancel`) and nothing runs;
 *   - mid-turn: the execution is interrupted (`session.interrupt`), the
 *     server emits `session.execution.interrupted`, and the partial
 *     assistant message is kept server-side.
 *
 * How it surfaces to you depends on the AI SDK call, not on the phase:
 * `generateText()` rejects with an abort error, while consuming
 * `streamText().textStream` just ends the iteration — the AI SDK absorbs
 * the abort there and does not throw. Both halves are shown below.
 */
import { generateText, streamText } from "ai";
import { createOpencode } from "../dist/index.js";
import { exampleConfig } from "./env.js";

async function main() {
  const { providerSettings, modelSettings, modelId } = exampleConfig();
  const opencode = createOpencode(providerSettings);

  try {
    // --- 1. Abort a stream after the first few chunks ---
    console.log("Streaming, aborting after ~3 chunks:");
    const controller = new AbortController();
    const stream = streamText({
      model: opencode(modelId, modelSettings),
      prompt: "Count slowly from 1 to 100, one number per line.",
      abortSignal: controller.signal,
    });

    // Note: streamText handles the abort itself — the stream just ends
    // (no throw); the server-side execution is interrupted.
    let chunks = 0;
    for await (const chunk of stream.textStream) {
      process.stdout.write(chunk);
      chunks += 1;
      if (chunks >= 3) {
        controller.abort();
      }
    }
    console.log(`\nStream ended after abort (${chunks} chunks consumed)`);

    // --- 2. Abort a non-streaming call with a timeout ---
    console.log("\ngenerateText with a 2s timeout:");
    try {
      const result = await generateText({
        model: opencode(modelId, modelSettings),
        prompt: "Write a 2000-word essay about build systems.",
        abortSignal: AbortSignal.timeout(2000),
      });
      console.log("Finished within the timeout:", result.text.length, "chars");
    } catch (error) {
      console.log(`Call aborted by timeout (${(error as Error).name})`);
    }
  } finally {
    await opencode.dispose();
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
