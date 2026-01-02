/**
 * Multi-turn conversation example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Creating a conversation with multiple turns
 * - Session persistence across calls
 * - Using ModelMessage format
 */

import { generateText, type ModelMessage } from "ai";
import { createOpencode } from "../dist/index.js";

async function main() {
  // Create provider
  const opencode = createOpencode({
    autoStartServer: true,
    defaultSettings: {
      sessionTitle: "Conversation Example",
    },
  });

  // Create a model instance (session persists across calls)
  const model = opencode("anthropic/claude-opus-4-5-20251101");

  try {
    console.log("Multi-turn conversation with OpenCode...\n");

    // Build conversation history
    const messages: ModelMessage[] = [];

    // Turn 1: Introduce yourself
    messages.push({
      role: "user",
      content: "My name is Alice. Remember this.",
    });

    let result = await generateText({
      model,
      messages,
    });

    console.log("User: My name is Alice. Remember this.");
    console.log("Assistant:", result.text);
    console.log("---\n");

    // Add assistant response to history
    messages.push({ role: "assistant", content: result.text });

    // Turn 2: Ask a question that requires remembering
    messages.push({ role: "user", content: "What is my name?" });

    result = await generateText({
      model,
      messages,
    });

    console.log("User: What is my name?");
    console.log("Assistant:", result.text);
    console.log("---\n");

    // Add assistant response to history
    messages.push({ role: "assistant", content: result.text });

    // Turn 3: Follow-up
    messages.push({
      role: "user",
      content: "How many letters are in my name?",
    });

    result = await generateText({
      model,
      messages,
    });

    console.log("User: How many letters are in my name?");
    console.log("Assistant:", result.text);

    // Show session info
    const metadata = result.providerMetadata?.opencode;
    if (metadata) {
      console.log("\nSession ID:", metadata.sessionId);
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
