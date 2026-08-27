/**
 * Tool-approval round-trip (stage-6 brief, deliverable 2): the harness
 * server runs with `permission: { bash: "ask" }`, so a bash tool call blocks
 * on a real `permission.asked`. Phase 1 must surface the approval request
 * and finish on quiescence; the phase-2 continuation replies and returns the
 * resumed execution's result.
 *
 * Model cooperation is not guaranteed (the zen free model may answer without
 * calling the tool); when no tool call happens the test skips rather than
 * fails.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { integrationContext, suiteTitle } from "./harness/context.js";

const ctx = integrationContext();

const PHASE1_PROMPT: LanguageModelV4Prompt = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "Use the bash tool to run exactly `echo approval-ok` and report " +
          "its stdout. Do not answer without running the command.",
      },
    ],
  },
];

describe.skipIf(!ctx.canGenerate)(suiteTitle("tool approvals", ctx), () => {
  const provider = ctx.available ? ctx.makeProvider() : undefined;

  afterAll(async () => {
    await provider?.dispose();
  });

  it("phase 1 blocks on permission.asked; phase 2 approves and resumes", async (t) => {
    const model = provider!(ctx.modelId);
    const phase1 = await model.doGenerate({ prompt: PHASE1_PROMPT });

    const approval = phase1.content.find(
      (part) => part.type === "tool-approval-request",
    );
    if (approval === undefined) {
      // The model answered without attempting the bash tool — nothing to
      // approve. Not a provider defect, but the skip must be LOUD: the
      // approval round-trip (permission.asked → reply → resumed execution)
      // went completely untested this run.
      console.warn(
        `[integration] APPROVAL PATH UNTESTED: ${ctx.modelId} answered without ` +
          `calling the bash tool, so the permission.asked → approval-reply → ` +
          `resume round-trip was NOT exercised. Re-run with a model that ` +
          `tool-calls (OPENCODE_TEST_MODEL=providerID/modelID) to cover it.`,
      );
      expect(phase1.finishReason.unified).toBeDefined();
      t.skip();
      return;
    }
    if (approval.type !== "tool-approval-request") {
      return;
    }

    const metadata = phase1.providerMetadata?.opencode as {
      sessionId: string;
      approvalRequestId?: string;
      approvalRequestIds?: string[];
    };
    expect(metadata.approvalRequestId).toBe(approval.approvalId);
    expect(metadata.approvalRequestIds).toContain(approval.approvalId);

    // Phase 2: replay the phase-1 turn plus the approval response, the way
    // an AI SDK caller would.
    const toolCall = phase1.content.find((part) => part.type === "tool-call");
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
                toolName: "bash",
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
            approved: true,
          },
        ],
      },
    ];
    const phase2 = await model.doGenerate({ prompt: phase2Prompt });

    expect(phase2.finishReason.unified).toBe("stop");
    const meta2 = phase2.providerMetadata?.opencode as {
      sessionId: string;
      repliedApprovalIds?: string[];
    };
    expect(meta2.sessionId).toBe(metadata.sessionId);
    expect(meta2.repliedApprovalIds).toContain(approval.approvalId);

    // The resumed execution actually ran the tool.
    const partTypes = phase2.content.map((part) => part.type);
    expect(partTypes).toContain("tool-result");
    const text = phase2.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(text.toLowerCase()).toContain("approval-ok");
  }, 180_000);
});
