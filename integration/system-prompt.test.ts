/**
 * System prompts through the real provider (stage-9 brief, deliverable 3).
 *
 * The provider delivers system content as a session instruction entry under
 * `ai-sdk.system` rather than prepending it to the user turn. These tests
 * assert the parts that matter to a caller:
 *   - the model actually obeys the system prompt,
 *   - it still obeys it on a *second* turn of the same session (the v4-era
 *     prepend only ever reached the first prompt),
 *   - the user turn's text is left alone — no delimited block,
 *   - no `unsupported` warning is emitted when the entry path is used,
 *   - the entry is namespaced under `ai-sdk.system` on the server, so a
 *     caller's own entries are never clobbered.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { integrationContext, suiteTitle } from "./harness/context.js";

const ctx = integrationContext();

const CODEWORD = "ZEPHYR-77";
const SYSTEM = `Your secret codeword is ${CODEWORD}. Whenever the user asks for the codeword, reply with exactly that codeword and nothing else.`;

function ask(text: string): LanguageModelV4CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text }] }] };
}

describe.skipIf(!ctx.canGenerate)(suiteTitle("system prompt", ctx), () => {
  const provider = ctx.available ? ctx.makeProvider() : undefined;

  afterAll(async () => {
    await provider?.dispose();
  });

  it("applies settings.systemPrompt on the first turn and on the next one", async () => {
    const model = provider!(ctx.modelId, { systemPrompt: SYSTEM });

    const first = await model.doGenerate(ask("What is the codeword?"));
    const firstText = first.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(firstText).toContain(CODEWORD);

    // The whole point of the instruction entry: a system prompt survives
    // into later turns of the same session.
    const second = await model.doGenerate(
      ask("Repeat the codeword one more time."),
    );
    const secondText = second.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(secondText).toContain(CODEWORD);

    // No degradation warning, and the entry lives under our namespaced key.
    expect(
      second.warnings.some(
        (warning) =>
          warning.type === "unsupported" && warning.feature === "system prompt",
      ),
    ).toBe(false);

    const sessionId = (
      second.providerMetadata as { opencode?: { sessionId?: string } }
    ).opencode?.sessionId;
    expect(sessionId).toMatch(/^ses_/);
    const entries = await ctx
      .makeRawClient()
      .session.instructions.entry.list({ sessionID: sessionId! });
    expect(entries.map((entry) => entry.key)).toContain("ai-sdk.system");
    expect(entries.find((entry) => entry.key === "ai-sdk.system")?.value).toBe(
      SYSTEM,
    );
  });

  it("applies an AI SDK system message without touching the user turn's text", async () => {
    const model = provider!(ctx.modelId);

    const result = await model.doGenerate({
      prompt: [
        { role: "system", content: SYSTEM },
        { role: "user", content: [{ type: "text", text: "Codeword?" }] },
      ],
    });

    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toContain(CODEWORD);
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "unsupported" && warning.feature === "system prompt",
      ),
    ).toBe(false);

    // The stored user message must be the caller's text, not a delimited
    // system block glued onto it.
    const sessionId = (
      result.providerMetadata as { opencode?: { sessionId?: string } }
    ).opencode?.sessionId;
    const messages = await ctx
      .makeRawClient()
      .message.list({ sessionID: sessionId!, order: "asc" });
    const user = messages.data.find((message) => message.type === "user");
    expect(user?.type === "user" ? user.text : "").toBe("Codeword?");
  });
});
