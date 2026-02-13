import { generateText, type ModelMessage } from "ai";
import { createOpencode } from "../dist/index.js";

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
    defaultSettings: {
      sessionTitle: "Conversation Example",
    },
  });

  const model = opencode("openai/gpt-5.3-codex-spark");
  const messages: ModelMessage[] = [];
  const userTurns = [
    "My name is Alice. Remember this.",
    "What is my name?",
    "How many letters are in my name?",
  ];

  try {
    let lastResult: Awaited<ReturnType<typeof generateText>> | undefined;

    for (const userText of userTurns) {
      messages.push({ role: "user", content: userText });

      const result = await generateText({ model, messages });
      messages.push({ role: "assistant", content: result.text });
      lastResult = result;

      console.log("User:", userText);
      console.log("Assistant:", result.text);
      console.log("---");
    }

    const metadata = lastResult?.providerMetadata?.opencode;
    if (metadata) {
      console.log("Session ID:", metadata.sessionId);
    }
  } finally {
    await opencode.dispose?.();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
