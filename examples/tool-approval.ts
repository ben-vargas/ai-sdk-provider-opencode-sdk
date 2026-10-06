/**
 * Two-phase tool-approval round-trip.
 *
 * Requires an OpenCode 2.x server — see examples/env.ts for the server
 * requirement and environment variables. The server must be configured to
 * ask for permission (e.g. `OPENCODE_CONFIG_CONTENT='{"permission":
 * {"shell":"ask"}}'`, which is what the integration harness uses); otherwise
 * tools run without asking and phase 2 never happens.
 *
 * How the round-trip works (this mirrors what the AI SDK does for
 * approval-capable tools, driven here at the model-interface level because
 * OpenCode's tools are server-side and not declared to the AI SDK):
 *
 *   Phase 1: the model calls a tool, the server blocks on
 *   `permission.asked`, and the provider finishes the call with a
 *   `tool-approval-request` content part. The session stays pinned on the
 *   model instance across the boundary.
 *
 *   Phase 2: calling the SAME model instance with the phase-1 history plus
 *   a `tool-approval-response` part sends `permission.reply` and observes
 *   the ORIGINAL blocked execution to completion — no new prompt is sent.
 *
 * Model cooperation is not guaranteed: a model may answer without calling
 * the tool, in which case there is nothing to approve.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { createOpencode } from "../dist/index.js";
import { exampleConfig } from "./env.js";

const PHASE1_PROMPT: LanguageModelV4Prompt = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "Use the shell tool to run exactly `echo approval-ok` and report " +
          "its stdout. Do not answer without running the command.",
      },
    ],
  },
];

async function main() {
  const { providerSettings, modelSettings, modelId } = exampleConfig();
  const opencode = createOpencode(providerSettings);

  try {
    // One model instance = one conversation = one pinned session. The same
    // instance must be used for both phases.
    const model = opencode(modelId, modelSettings);

    console.log("Phase 1: prompting (expecting a blocked tool call)...");
    const phase1 = await model.doGenerate({ prompt: PHASE1_PROMPT });

    const approval = phase1.content.find(
      (part) => part.type === "tool-approval-request",
    );
    if (approval?.type !== "tool-approval-request") {
      console.log(
        "No approval was requested. Either the model answered without the " +
          "tool, or the server runs shell without asking (the 2.x default) — " +
          "restart it with " +
          `OPENCODE_CONFIG_CONTENT='{"permission":{"shell":"ask"}}'.`,
      );
      console.log(
        "Text:",
        phase1.content
          .filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
      );
      return;
    }

    console.log("Approval requested:", approval.approvalId);
    console.log(
      "Pending approvals in metadata:",
      phase1.providerMetadata?.opencode?.approvalRequestIds,
    );

    // The blocked call, not just the first: the model may have made other
    // tool calls (e.g. a failed attempt) earlier in the same turn.
    const toolCall = phase1.content.find(
      (part) =>
        part.type === "tool-call" && part.toolCallId === approval.toolCallId,
    );
    const phase2Prompt: LanguageModelV4Prompt = [
      ...PHASE1_PROMPT,
      {
        role: "assistant",
        content: [
          toolCall?.type === "tool-call"
            ? toolCall
            : {
                type: "tool-call",
                toolCallId: approval.toolCallId ?? "tool_unknown",
                toolName: "shell",
                input: "{}",
              },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: approval.approvalId,
            // `false` rejects. With a `reason`, the model gets it as tool
            // feedback and the turn continues; without one, 2.0.24 ends the
            // turn (interrupted, reason "shutdown" → finish `error`).
            approved: true,
          },
        ],
      },
    ];

    console.log("Phase 2: approving and resuming the blocked execution...");
    const phase2 = await model.doGenerate({ prompt: phase2Prompt });

    console.log("Finish reason:", phase2.finishReason.unified);
    console.log(
      "Replied approvals:",
      phase2.providerMetadata?.opencode?.repliedApprovalIds,
    );
    console.log(
      "Text:",
      phase2.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
    );
  } finally {
    await opencode.dispose();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
