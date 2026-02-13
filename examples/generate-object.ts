import { generateText, Output } from "ai";
import { createOpencode } from "../dist/index.js";
import { z } from "zod";

const MODEL = "anthropic/claude-opus-4-5-20251101";

const profileSchema = z.object({
  name: z.string(),
  role: z.string(),
  yearsExperience: z.number(),
  skills: z.array(z.string()),
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

async function generateNativeObject(
  opencode: ReturnType<typeof createOpencode>,
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { output } = await generateText({
        model: opencode(MODEL, { outputFormatRetryCount: 2 }),
        output: Output.object({ schema: profileSchema }),
        prompt: "Generate a realistic senior backend developer profile.",
      });
      return output;
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
      console.log(
        `Native attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}. Retrying...`,
      );
    }
  }

  throw new Error("Unreachable");
}

async function generateFallbackJson(
  opencode: ReturnType<typeof createOpencode>,
) {
  const { text } = await generateText({
    model: opencode(MODEL),
    prompt: [
      "Return only valid JSON (no prose, no markdown).",
      'Use exactly: {"name":string,"role":string,"yearsExperience":number,"skills":string[]}.',
      "Generate a realistic senior backend developer profile.",
    ].join(" "),
  });

  const json = extractJsonObject(text);
  if (!json) {
    throw new Error("Fallback response did not contain a JSON object.");
  }
  return profileSchema.parse(JSON.parse(json));
}

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    console.log("=== OpenCode: Generate Object ===\n");

    let profile: z.infer<typeof profileSchema>;
    try {
      profile = await generateNativeObject(opencode);
      console.log("Used native json_schema mode.");
    } catch (error) {
      console.log(
        `Native structured output failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log("Falling back to strict JSON prompting.");
      profile = await generateFallbackJson(opencode);
    }

    console.log("Validated profile:");
    console.log(JSON.stringify(profile, null, 2));
  } finally {
    await opencode.dispose?.();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
