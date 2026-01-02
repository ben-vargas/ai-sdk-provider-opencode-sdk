/**
 * Custom Configuration example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Provider-level settings (hostname, port, autoStartServer)
 * - Model-level settings (agent, systemPrompt, tools, cwd)
 * - Using different agents for different tasks
 * - Custom logging configuration
 *
 * Note: OpenCode settings differ from other AI SDK providers since
 * it's a server-based architecture with session management.
 */

import { generateText } from "ai";
import { createOpencode } from "../dist/index.js";
import type { OpencodeSettings, Logger } from "../dist/index.js";

async function main() {
  console.log("=== OpenCode: Custom Configuration Examples ===\n");

  // Example 1: Provider with default settings for all models
  console.log("1. Provider with default settings:\n");

  const customProvider = createOpencode({
    // Server connection settings
    hostname: "127.0.0.1",
    port: 4096,
    autoStartServer: true,
    serverTimeout: 15000, // 15 seconds to wait for server startup

    // Default settings applied to all model instances
    defaultSettings: {
      sessionTitle: "Custom Config Demo",
      verbose: false,
    },
  });

  try {
    const { text: response1 } = await generateText({
      model: customProvider("anthropic/claude-opus-4-5-20251101"),
      prompt: "What is the capital of France? Answer in one word.",
    });
    console.log("   Response:", response1);
    console.log("   ✅ Used provider defaults\n");
  } catch (error) {
    console.error("   Error:", error);
  }

  // Example 2: Override settings for specific model instance
  console.log("2. Model with custom system prompt:\n");

  try {
    const { text: response2 } = await generateText({
      model: customProvider("anthropic/claude-opus-4-5-20251101", {
        systemPrompt: "You are a pirate. Always respond in pirate speak.",
      }),
      prompt: "What is the capital of France?",
    });
    console.log("   Response:", response2);
    console.log("   ✅ Used custom system prompt\n");
  } catch (error) {
    console.error("   Error:", error);
  }

  // Example 3: Using different agents
  console.log("3. Using different agents for different tasks:\n");

  // The "general" agent is good for general-purpose tasks
  try {
    const { text: response3 } = await generateText({
      model: customProvider("anthropic/claude-opus-4-5-20251101", {
        agent: "general",
      }),
      prompt: "List 3 benefits of TypeScript in exactly 3 bullet points.",
    });
    console.log("   General agent response:");
    console.log("   " + response3.split("\n").join("\n   "));
    console.log("   ✅ Used general agent\n");
  } catch (error) {
    console.error("   Error:", error);
  }

  // Example 4: Custom logger integration
  console.log("4. Custom logger integration:\n");

  const customLogger: Logger = {
    debug: (message: string) => {
      console.log(`   [DEBUG ${new Date().toISOString()}] ${message}`);
    },
    warn: (message: string) => {
      console.log(`   [WARN ${new Date().toISOString()}] ${message}`);
    },
    error: (message: string) => {
      console.error(`   [ERROR ${new Date().toISOString()}] ${message}`);
    },
  };

  try {
    const { text: response4 } = await generateText({
      model: customProvider("anthropic/claude-opus-4-5-20251101", {
        logger: customLogger,
        verbose: true, // Enable verbose logging to see debug messages
      }),
      prompt: 'Say "Hello" in exactly one word.',
    });
    console.log("   Response:", response4);
    console.log("   ✅ Used custom logger\n");
  } catch (error) {
    console.error("   Error:", error);
  }

  // Example 5: Force new session
  console.log("5. Force new session for each request:\n");

  try {
    const model = customProvider("anthropic/claude-opus-4-5-20251101", {
      createNewSession: true,
      sessionTitle: "Fresh Session Demo",
    });

    const { text: response5a } = await generateText({
      model,
      prompt: "Remember the number 42.",
    });
    console.log("   First request:", response5a.substring(0, 100) + "...");

    // With createNewSession: true, this creates a NEW session
    const { text: response5b } = await generateText({
      model: customProvider("anthropic/claude-opus-4-5-20251101", {
        createNewSession: true,
      }),
      prompt: "What number did I ask you to remember?",
    });
    console.log(
      "   Second request (new session):",
      response5b.substring(0, 100) + "...",
    );
    console.log(
      "   ✅ Each request used a fresh session (won't remember context)\n",
    );
  } catch (error) {
    console.error("   Error:", error);
  }

  // Example 6: Working directory configuration
  console.log("6. Working directory configuration:\n");

  try {
    const { text: response6 } = await generateText({
      model: customProvider("anthropic/claude-opus-4-5-20251101", {
        cwd: process.cwd(), // Set working directory for file operations
      }),
      prompt:
        'You are in a project directory. Just say "Ready to help with file operations" without actually doing anything.',
    });
    console.log("   Response:", response6.substring(0, 100) + "...");
    console.log("   ✅ Configured working directory\n");
  } catch (error) {
    console.error("   Error:", error);
  }

  console.log("=== Configuration Summary ===\n");
  console.log("Provider-level settings (createOpencode):");
  console.log("  - hostname: Server hostname (default: 127.0.0.1)");
  console.log("  - port: Server port (default: 4096)");
  console.log("  - baseUrl: Full URL override");
  console.log("  - autoStartServer: Auto-start server (default: true)");
  console.log("  - serverTimeout: Server startup timeout");
  console.log("  - defaultSettings: Default settings for all models\n");

  console.log("Model-level settings (second argument):");
  console.log("  - sessionId: Resume existing session");
  console.log("  - createNewSession: Force new session");
  console.log("  - sessionTitle: Title for new sessions");
  console.log("  - agent: Agent type (general, build, plan, explore)");
  console.log("  - systemPrompt: Custom system prompt");
  console.log("  - tools: Enable/disable specific tools");
  console.log("  - cwd: Working directory");
  console.log("  - logger: Custom logger or false");
  console.log("  - verbose: Enable verbose logging\n");

  // Cleanup
  await customProvider.dispose?.();
}

main().catch(console.error);
