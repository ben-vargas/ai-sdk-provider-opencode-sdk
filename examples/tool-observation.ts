import { streamText } from "ai";
import { createOpencode } from "../dist/index.js";

const MODEL = "anthropic/claude-opus-4-5-20251101";

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
    defaultSettings: {
      directory: process.cwd(),
    },
  });

  try {
    console.log("=== OpenCode: Tool Observation ===\n");

    const result = streamText({
      model: opencode(MODEL),
      prompt:
        "List the files in the current directory and tell me how many there are.",
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "tool-call":
          console.log(`tool-call: ${part.toolName}`);
          console.log(`  input: ${JSON.stringify(part.input)}`);
          break;

        case "tool-result": {
          const output =
            part.output == null
              ? "(no output)"
              : typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output);
          const preview = output.slice(0, 160);
          console.log(`tool-result: ${part.toolName}`);
          console.log(
            `  output: ${preview}${output.length > 160 ? "..." : ""}`,
          );
          break;
        }

        case "tool-approval-request":
          console.log(`tool-approval-request: ${part.toolCall.toolName}`);
          console.log(`  approvalId: ${part.approvalId}`);
          break;

        case "file":
          console.log(
            `file: ${part.file.mediaType} (${part.file.uint8Array.length} bytes)`,
          );
          break;

        case "source":
          console.log(`source: ${part.sourceType}`);
          break;

        case "text-delta":
          if (part.text) {
            process.stdout.write(part.text);
          }
          break;

        case "finish":
          console.log(`\nfinish: ${part.finishReason}`);
          console.log(`usage: ${JSON.stringify(part.totalUsage)}`);
          break;

        case "error":
          console.error(`\nstream-error: ${String(part.error)}`);
          break;
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
