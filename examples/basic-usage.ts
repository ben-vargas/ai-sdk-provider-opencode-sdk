/**
 * Minimal text generation with `generateText`.
 *
 * Requires an OpenCode 2.x server — see examples/env.ts for the server
 * requirement and the OPENCODE_URL / OPENCODE_PASSWORD /
 * OPENCODE_MODEL environment variables.
 *
 * The provider creates a session for the conversation, sends the prompt,
 * observes the turn to completion over the event stream, and returns the
 * assistant text plus native usage/cost under `providerMetadata.opencode`.
 */
import { generateText } from "ai";
import { createOpencode } from "../dist/index.js";
import { exampleConfig } from "./env.js";

async function main() {
  const { providerSettings, modelSettings, modelId } = exampleConfig();
  const opencode = createOpencode(providerSettings);

  try {
    const result = await generateText({
      model: opencode(modelId, modelSettings),
      prompt: "What is the capital of France? Answer in one sentence.",
    });

    console.log("Response:", result.text);
    console.log("Usage:", result.usage);
    console.log("Finish reason:", result.finishReason);

    const metadata = result.finalStep.providerMetadata?.opencode;
    if (metadata) {
      console.log("Session ID:", metadata.sessionId);
      console.log("Outcome:", metadata.outcome);
      console.log("Cost (USD):", metadata.cost);
      console.log("Native tokens:", metadata.tokens);
    }
  } finally {
    await opencode.dispose();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
