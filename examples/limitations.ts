import { generateText, streamText, Output } from "ai";
import { createOpencode } from "../dist/index.js";
import { z } from "zod";

const MODEL = "openai/gpt-5.3-codex-spark";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getTextPreview(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  console.log("=== OpenCode: Limitations Snapshot ===\n");

  try {
    console.log("1) Ignored sampling parameters");
    const { text } = await generateText({
      model: opencode(MODEL),
      prompt: "Write exactly 5 words.",
      temperature: 0.1,
      topP: 0.9,
      topK: 50,
      presencePenalty: 0.5,
      frequencyPenalty: 0.5,
      stopSequences: ["END"],
      seed: 12345,
      maxOutputTokens: 10,
    });
    console.log(`  response: ${getTextPreview(text)}`);
    console.log("  note: warnings above show these params are ignored.\n");

    console.log("2) Structured output can be unreliable");
    try {
      const { output } = await generateText({
        model: opencode(MODEL, {
          outputFormatRetryCount: 2,
        }),
        output: Output.object({
          schema: z.object({
            answer: z.enum(["ok"]),
          }),
        }),
        prompt: "Return a JSON object with answer set to ok.",
      });
      console.log(`  response: ${JSON.stringify(output)}`);
      console.log("  note: parsed successfully in this run.\n");
    } catch (error) {
      console.log(`  expected limitation: ${formatError(error)}`);
      console.log(
        "  note: model sometimes returns plain text or fenced JSON, which fails strict parsing.\n",
      );
    }

    console.log("3) Streaming also ignores sampling parameters");
    const { textStream } = streamText({
      model: opencode(MODEL),
      prompt: "Count to 3 briefly.",
      temperature: 0,
      maxOutputTokens: 5,
    });
    process.stdout.write("  stream: ");
    for await (const chunk of textStream) {
      process.stdout.write(chunk);
    }
    console.log("\n");

    console.log("4) Other notable limitations");
    console.log("  - Custom AI SDK tools are not executed by OpenCode.");
    console.log("  - Remote image URLs are not supported as image input.");
    console.log(
      "  - OpenCode executes its own server-side tools; observe with fullStream.",
    );
    console.log("  - Tool approvals are surfaced via stream events.\n");
  } catch (error) {
    console.error(`Fatal error: ${formatError(error)}`);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
