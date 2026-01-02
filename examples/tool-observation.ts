/**
 * Tool observation example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Observing tool execution in streaming mode
 * - Accessing tool call and result information
 *
 * Note: OpenCode executes tools server-side. You can observe
 * tool execution but cannot provide custom tool implementations.
 */

import { streamText } from "ai";
import { createOpencode } from "../dist/index.js";

async function main() {
  // Create provider with a working directory
  const opencode = createOpencode({
    autoStartServer: true,
    defaultSettings: {
      cwd: process.cwd(),
    },
  });

  try {
    console.log("Observing tool execution with OpenCode...\n");

    // Ask OpenCode to do something that requires tools
    const result = streamText({
      model: opencode("anthropic/claude-opus-4-5-20251101"),
      prompt:
        "List the files in the current directory and tell me how many there are.",
    });

    // Process the full stream to observe all events
    console.log("Processing stream events:\n");

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          // AI SDK TextStreamPart uses 'text' field, not 'textDelta'
          if (part.text) {
            process.stdout.write(part.text);
          }
          break;

        case "tool-input-start":
          console.log(`\n[Tool Input Start: ${part.toolName}]`);
          break;

        case "tool-input-delta":
          // Tool input arrives as JSON text deltas. Ignore for brevity.
          break;

        case "tool-input-end":
          console.log("[Tool Input End]");
          break;

        case "tool-call":
          console.log(`\n[Tool Call: ${part.toolName}]`);
          console.log(`  Input: ${JSON.stringify(part.input, null, 2)}`);
          break;

        case "tool-result": {
          console.log(`[Tool Result: ${part.toolName}]`);
          // Truncate long results - handle undefined/null
          const resultStr =
            part.result == null
              ? "(no output)"
              : typeof part.result === "string"
                ? part.result
                : JSON.stringify(part.result);
          console.log(
            `  Output: ${resultStr.substring(0, 200)}${resultStr.length > 200 ? "..." : ""}`,
          );
          break;
        }

        case "finish":
          console.log(`\n\n[Finished: ${part.finishReason}]`);
          console.log(`Usage: ${JSON.stringify(part.totalUsage)}`);
          break;

        case "error":
          console.error("\n[Error]:", part.error);
          break;
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
