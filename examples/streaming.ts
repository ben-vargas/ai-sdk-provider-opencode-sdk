/**
 * Streaming with `streamText`: live text deltas plus the other stream parts
 * OpenCode emits (reasoning, tool lifecycle, sources/files from tool
 * results).
 *
 * Requires an OpenCode 2.x server — see examples/env.ts for the server
 * requirement and environment variables.
 *
 * OpenCode v2 streams native delta events (`session.text.delta`,
 * `session.reasoning.delta`, `session.tool.input.delta`); the provider maps
 * them 1:1 onto AI SDK stream parts.
 */
import { streamText } from "ai";
import { createOpencode } from "../dist/index.js";
import { exampleConfig } from "./env.js";

async function main() {
  const { providerSettings, modelSettings, modelId } = exampleConfig();
  const opencode = createOpencode(providerSettings);

  try {
    const result = streamText({
      model: opencode(modelId, modelSettings),
      prompt:
        "Write a haiku about code review, then explain it in one sentence.",
    });

    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");

    console.log("Finish reason:", await result.finishReason);
    console.log("Usage:", await result.usage);

    const metadata = (await result.finalStep).providerMetadata?.opencode;
    if (metadata) {
      console.log("Session ID:", metadata.sessionId);
      console.log("Cost (USD):", metadata.cost);
    }
  } finally {
    await opencode.dispose();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
