import { streamText } from "ai";
import { createOpencode } from "../dist/index.js";

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    const result = streamText({
      model: opencode("anthropic/claude-opus-4-5-20251101"),
      prompt: "Count from 1 to 5, explaining each number briefly.",
    });

    console.log("Response:");
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    console.log();

    const [usage, finishReason] = await Promise.all([
      result.usage,
      result.finishReason,
    ]);
    console.log("Usage:", usage);
    console.log("Finish reason:", finishReason);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
