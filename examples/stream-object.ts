import { streamObject, streamText } from "ai";
import { createOpencode } from "../dist/index.js";
import { z } from "zod";

const MODEL = "anthropic/claude-opus-4-5-20251101";

const checklistSchema = z.object({
  topic: z.string(),
  owner: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      done: z.boolean(),
    }),
  ),
});

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

async function runNativeStreamObject(
  opencode: ReturnType<typeof createOpencode>,
) {
  const result = streamObject({
    model: opencode(MODEL, { outputFormatRetryCount: 2 }),
    schema: checklistSchema,
    prompt: [
      "Generate a release-readiness checklist for an API launch.",
      "Return only valid JSON and include exactly 4 steps.",
    ].join(" "),
  });

  let partialCount = 0;
  for await (const partial of result.partialObjectStream) {
    partialCount += 1;
    if (partialCount <= 5 || partialCount % 10 === 0) {
      const stepCount = Array.isArray(partial.steps) ? partial.steps.length : 0;
      console.log(
        `partial #${partialCount}: topic=${partial.topic ? "yes" : "..."} steps=${stepCount}`,
      );
    }
  }

  const finalObject = await result.object;
  return { finalObject, partialCount };
}

async function runFallbackJsonStream(
  opencode: ReturnType<typeof createOpencode>,
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = streamText({
      model: opencode(MODEL),
      prompt: [
        "Return only valid JSON (no prose, no markdown).",
        'Required shape example: {"topic":"API Launch","owner":"Platform Team","steps":[{"title":"Run smoke tests","done":false}]}.',
        "Generate a release-readiness checklist for an API launch with exactly 4 steps.",
      ].join(" "),
    });

    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
    }

    const json = extractJsonObject(text);
    if (!json) {
      if (attempt === 3) {
        throw new Error("Fallback response did not contain a JSON object.");
      }
      continue;
    }

    try {
      return checklistSchema.parse(JSON.parse(json));
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
    }
  }

  throw new Error("Unreachable");
}

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    console.log("=== OpenCode: Stream Object ===\n");

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Native attempt ${attempt}/3`);
        const { finalObject, partialCount } =
          await runNativeStreamObject(opencode);
        console.log(`Total partial updates: ${partialCount}`);
        console.log("\nFinal checklist:");
        console.log(JSON.stringify(finalObject, null, 2));
        return;
      } catch (error) {
        if (attempt === 3) {
          console.log(
            `Native structured stream failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          console.log("Falling back to strict JSON streaming.");
          const recovered = await runFallbackJsonStream(opencode);
          console.log("\nFinal checklist:");
          console.log(JSON.stringify(recovered, null, 2));
          return;
        }
        console.log(
          `Attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}. Retrying...\n`,
        );
      }
    }
  } finally {
    await opencode.dispose?.();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
