import { generateText, Output } from "ai";
import { createOpencode } from "../dist/index.js";
import { z } from "zod";

const MODEL = "openai/gpt-5.3-codex-spark";

const profileSchema = z.object({
  name: z.string(),
  role: z.string(),
  yearsExperience: z.number(),
  skills: z.array(z.string()),
});

// Preferred flow:
// 1) Try native structured output (Output.object -> provider json_schema format).
// 2) If native mode is unreliable for the selected model/backend route, fallback
//    to strict JSON prompting and local parse+Zod validation.

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
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { text } = await generateText({
      model: opencode(MODEL),
      prompt: [
        "Return only valid JSON (no prose, no markdown).",
        'Required shape example: {"name":"Jane Doe","role":"Staff Engineer","yearsExperience":12,"skills":["Go","PostgreSQL","Kubernetes"]}.',
        "Generate a realistic senior backend developer profile.",
      ].join(" "),
    });

    const json = extractJsonObject(text);
    if (!json) {
      if (attempt === 3) {
        throw new Error("Fallback response did not contain a JSON object.");
      }
      continue;
    }

    try {
      return profileSchema.parse(JSON.parse(json));
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
      console.log(
        `Fallback attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}. Retrying...`,
      );
    }
  }

  throw new Error("Unreachable");
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
