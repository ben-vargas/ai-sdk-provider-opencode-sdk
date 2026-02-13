import { generateText, Output } from "ai";
import { createOpencode } from "../dist/index.js";
import type { Logger } from "../dist/index.js";
import { z } from "zod";

const MODEL = "anthropic/claude-opus-4-5-20251101";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return body.slice(start, end + 1);
}

async function runStep(title: string, fn: () => Promise<void>) {
  console.log(title);
  try {
    await fn();
  } catch (error) {
    console.error(`  Error: ${formatError(error)}`);
  }
  console.log();
}

async function main() {
  const provider = createOpencode({
    hostname: "127.0.0.1",
    port: 4096,
    autoStartServer: true,
    serverTimeout: 15000,
    defaultSettings: {
      sessionTitle: "Custom Config Demo",
      verbose: false,
    },
  });

  const logger: Logger = {
    debug: (message) => console.log(`[debug] ${message}`),
    warn: (message) => console.log(`[warn] ${message}`),
    error: (message) => console.error(`[error] ${message}`),
  };

  console.log("=== OpenCode: Custom Configuration ===\n");

  await runStep("1) Provider defaults", async () => {
    const { text } = await generateText({
      model: provider(MODEL),
      prompt: "What is the capital of France? One word only.",
    });
    console.log(`  Response: ${text}`);
  });

  await runStep("2) Per-model prompt/agent", async () => {
    const { text } = await generateText({
      model: provider(MODEL, {
        agent: "general",
        systemPrompt: "Answer like a pirate in one short sentence.",
      }),
      prompt: "Where is the Eiffel Tower located?",
    });
    console.log(`  Response: ${text}`);
  });

  await runStep("3) Directory + permission rules", async () => {
    const { text } = await generateText({
      model: provider(MODEL, {
        directory: process.cwd(),
        permission: [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "write", pattern: "*", action: "deny" },
        ],
      }),
      prompt:
        'Reply with exactly: "ready". Do not run any tools for this request.',
    });
    console.log(`  Response: ${text}`);
  });

  await runStep("4) Structured output retry tuning", async () => {
    const schema = z.object({
      topic: z.string(),
      difficulty: z.enum(["easy", "medium", "hard"]),
    });

    try {
      const { output } = await generateText({
        model: provider(MODEL, {
          outputFormatRetryCount: 2,
        }),
        output: Output.object({ schema }),
        prompt: "Classify TypeScript generics difficulty for beginners.",
      });
      console.log(`  Output: ${JSON.stringify(output)}`);
      return;
    } catch (error) {
      console.log(
        `  Native structured output failed: ${formatError(error)}. Using strict JSON fallback.`,
      );
    }

    const fallback = await generateText({
      model: provider(MODEL),
      prompt: [
        "Return only valid JSON (no prose, no markdown).",
        'Use exactly: {"topic":string,"difficulty":"easy"|"medium"|"hard"}.',
        "Classify TypeScript generics difficulty for beginners.",
      ].join(" "),
    });

    const json = extractJsonObject(fallback.text);
    if (!json) {
      throw new Error("Fallback response did not contain a JSON object.");
    }
    const parsed = schema.parse(JSON.parse(json));
    console.log(`  Output: ${JSON.stringify(parsed)}`);
  });

  await runStep("5) Custom logger", async () => {
    const { text } = await generateText({
      model: provider(MODEL, {
        logger,
        verbose: true,
      }),
      prompt: 'Reply with exactly: "done".',
    });
    console.log(`  Response: ${text}`);
  });

  await provider.dispose?.();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
