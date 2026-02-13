import { generateText } from "ai";
import { createOpencode } from "../dist/index.js";

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
    serverTimeout: 10000,
  });

  try {
    const result = await generateText({
      model: opencode("openai/gpt-5.3-codex-spark"),
      prompt: "What is the capital of France? Answer in one sentence.",
    });

    console.log("Response:", result.text);
    console.log("Usage:", result.usage);
    console.log("Finish reason:", result.finishReason);

    const metadata = result.providerMetadata?.opencode;
    if (metadata) {
      console.log("Session ID:", metadata.sessionId);
      console.log("Cost:", metadata.cost);
    }
  } finally {
    await opencode.dispose?.();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
