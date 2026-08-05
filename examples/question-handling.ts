import { streamText } from "ai";
import { createOpencode } from "../dist/index.js";
import type { OpencodeQuestionRequest } from "../dist/index.js";

const MODEL = "openai/gpt-5.3-codex-spark";

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
    defaultSettings: {
      directory: process.cwd(),
    },
  });

  try {
    console.log("=== OpenCode: Interactive Question Handling ===\n");

    const model = opencode(MODEL, {
      // Called whenever OpenCode's question tool asks something. Return
      // { type: "answer", answers } with one string[] per question (multiple
      // selections -> multiple strings), or { type: "reject" } to decline.
      //
      // Without a handler the provider rejects questions automatically
      // (questionPolicy: "reject", the default) so generation never hangs.
      // Set questionPolicy: "wait" to restore the legacy behavior of
      // emitting a stream error and waiting for an external answer.
      onQuestion: (request: OpencodeQuestionRequest) => {
        for (const question of request.questions) {
          console.log(`\nquestion: ${question.header} — ${question.question}`);
          for (const option of question.options) {
            console.log(`  - ${option.label}: ${option.description}`);
          }
        }

        // Pick the first option for every question.
        return {
          type: "answer",
          answers: request.questions.map((question) => [
            question.options[0]?.label ?? "",
          ]),
        };
      },
    });

    const result = streamText({
      model,
      prompt:
        "Use the question tool to ask me whether I prefer a formal or a " +
        "casual greeting, then greet me in the style I picked.",
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          if (part.text) {
            process.stdout.write(part.text);
          }
          break;

        case "finish":
          console.log(`\nfinish: ${part.finishReason}`);
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
