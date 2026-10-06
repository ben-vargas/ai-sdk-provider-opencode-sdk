/**
 * Interactive forms: OpenCode v2's replacement for v4's questions.
 *
 * Requires an OpenCode 2.x server — see examples/env.ts for the server
 * requirement and environment variables.
 *
 * When server-side tooling needs input mid-turn it emits a `form.created`
 * event with typed, keyed fields. The provider invokes your `onForm`
 * callback and replies with the keyed answer you return (`form.reply`) or
 * cancels (`form.cancel`).
 *
 * Lifecycle, per the OpenCode source (`packages/core/src/form.ts` @
 * `v2.0.24`): a tool that asks a form suspends on it until the form is
 * replied to or cancelled — both outcomes resolve that wait, so cancelling
 * does unblock the tool, though the tool may then fail its own call (the
 * built-in websearch tool does exactly that).
 *
 * `formPolicy` applies when **no handler is set**: "cancel" (default)
 * settles the form, "wait" leaves it pending for an external client (e.g. a
 * TUI attached to the same server). It does NOT cover a configured handler
 * that throws — that form is always cancelled, under either policy.
 *
 * Triggering one: OpenCode 2.x's built-in `question` tool asks through a
 * form (one field per question, keyed `q0`, `q1`, …), so this example asks
 * the model to use it. Whether the model complies is still its choice.
 *
 * Cancelling a `question` form does not let the turn carry on: 2.0.24 ends
 * it as interrupted (reason "shutdown"), so the call finishes with `error`.
 * See docs/known-upstream-issues/decline-interrupt-reason.md.
 */
import { generateText } from "ai";
import { createOpencode } from "../dist/index.js";
import type {
  OpencodeFormAnswer,
  OpencodeFormRequest,
  OpencodeFormResponse,
  OpencodeProviderMetadata,
} from "../dist/index.js";
import { exampleConfig } from "./env.js";

/**
 * Answer every field with its default or, for choice fields, the last
 * option — not the first, so the reply visibly steers the model.
 */
function answerForm(form: OpencodeFormRequest): OpencodeFormResponse {
  const answer: OpencodeFormAnswer = {};
  for (const field of form.fields) {
    switch (field.type) {
      case "string":
        answer[field.key] =
          field.default ?? field.options?.at(-1)?.value ?? "example answer";
        break;
      case "number":
      case "integer":
        answer[field.key] = field.default ?? 0;
        break;
      case "boolean":
        answer[field.key] = field.default ?? true;
        break;
      case "multiselect":
        answer[field.key] =
          field.default ??
          (field.options.length > 0 ? [field.options.at(-1)!.value] : []);
        break;
      case "external":
        // External fields point at a URL a human must visit; a programmatic
        // handler cannot complete them — cancel instead.
        return { type: "cancel" };
    }
  }
  return { type: "answer", answer };
}

async function main() {
  const { providerSettings, modelSettings, modelId } = exampleConfig();
  const opencode = createOpencode(providerSettings);

  try {
    const model = opencode(modelId, {
      ...modelSettings,
      onForm: (form) => {
        console.log(`\nForm received: "${form.title}" (${form.id})`);
        for (const field of form.fields) {
          console.log(`  - ${field.key} (${field.type})`);
        }
        const response = answerForm(form);
        console.log(
          response.type === "answer"
            ? `  answering: ${JSON.stringify(response.answer)}`
            : "  cancelling (unanswerable programmatically)",
        );
        return response;
      },
      // Applies only when no handler is set: "cancel" (default) settles the
      // form, "wait" leaves it for an external client. A handler that throws
      // always cancels, regardless of this policy.
      formPolicy: "cancel",
    });

    // OpenCode 2.x's built-in `question` tool asks via a form, so asking
    // the model to use it is the most reliable way to trigger one.
    const result = await generateText({
      model,
      prompt:
        "Use the question tool to ask me which language to greet in, " +
        "offering English, French and Spanish. Then greet me in the " +
        "language I pick, in one short sentence.",
    });

    console.log("\nResponse:", result.text);
    const metadata = result.finalStep.providerMetadata?.opencode as
      | OpencodeProviderMetadata["opencode"]
      | undefined;
    if (metadata?.formIds?.length) {
      console.log("Forms handled this turn:", metadata.formIds);
    } else {
      console.log(
        "(no form fired this turn — the model answered without the question tool)",
      );
    }
  } finally {
    await opencode.dispose();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
