/**
 * Abort behavior against the real server (stage-6 brief, deliverable 2):
 *
 * - post-delivery: a caller abort mid-execution errors the provider stream
 *   and interrupts the server-side turn; the pinned session stays usable.
 * - pre-delivery: `inbox.cancel` on a queued-but-undelivered item (the exact
 *   call the provider's abort cleanup makes) prevents the turn from ever
 *   running. Exercised through the raw client because an undelivered receipt
 *   requires a busy session, and sharing a busy session with the provider is
 *   outside its exclusivity contract (no inbox→execution correlation key).
 */
import { afterAll, describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { OpencodeLanguageModel } from "../src/index.js";
import {
  integrationContext,
  parseModelRef,
  pollUntil,
  suiteTitle,
} from "./harness/context.js";

const ctx = integrationContext();

describe.skipIf(!ctx.canGenerate)(suiteTitle("abort", ctx), () => {
  const provider = ctx.available ? ctx.makeProvider() : undefined;

  afterAll(async () => {
    await provider?.dispose();
  });

  it("post-delivery: abort mid-stream rejects, interrupts server-side, and the session recovers", async () => {
    const model = provider!(ctx.modelId) as OpencodeLanguageModel;
    const controller = new AbortController();
    const result = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Write a story about a lighthouse in about 150 words.",
            },
          ],
        },
      ],
      abortSignal: controller.signal,
    });

    // Consume until the turn is demonstrably delivered and producing output,
    // then abort.
    const reader = result.stream.getReader();
    let sessionId = "";
    let aborted = false;
    let rejection: unknown;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        const part = value as LanguageModelV4StreamPart;
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          sessionId = model.getSessionId() ?? "";
          controller.abort();
          aborted = true;
        }
      }
    } catch (error) {
      rejection = error;
    } finally {
      reader.releaseLock();
    }

    expect(aborted).toBe(true);
    expect(rejection).toBeDefined();
    sessionId = sessionId !== "" ? sessionId : (model.getSessionId() ?? "");
    expect(sessionId).toMatch(/^ses_/);

    // Server side: the interrupted execution settles (assistant message gets
    // a finish, or the partial turn is dropped) and the session accepts a
    // new prompt from the same model instance.
    const raw = ctx.makeRawClient();
    await pollUntil(
      async () => {
        const messages = await raw.message.list({ sessionID: sessionId });
        const assistant = messages.data.filter(
          (message) => message.type === "assistant",
        );
        const unsettled = assistant.some(
          (message) => message.finish === undefined,
        );
        return unsettled ? undefined : true;
      },
      { timeoutMs: 60_000, label: "interrupted turn settles" },
    );

    const recovery = await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply with exactly: RECOVERED" }],
        },
      ],
    });
    expect(recovery.finishReason.unified).toBe("stop");
  });

  it("pre-delivery: inbox.cancel on a queued undelivered item prevents the turn", async () => {
    const raw = ctx.makeRawClient();
    const model = parseModelRef(ctx.modelId);
    // Model is session state on the v2 contract (no per-prompt model field).
    const session = await raw.session.create({
      title: "integration-abort-pre-delivery",
      location: { directory: ctx.workdir },
      model: { id: model.modelID, providerID: model.providerID },
    });

    // Occupy the session, then enqueue a second prompt behind it.
    await raw.session.prompt({
      sessionID: session.id,
      text: "Write a story about a lighthouse in about 150 words.",
    });
    const queued = await raw.session.prompt({
      sessionID: session.id,
      text: "Reply with exactly: CANCELLED_MARKER",
      delivery: "queue",
    });
    expect(queued.id).toMatch(/^msg_/);

    // The queued item is visible as pending, then cancelled.
    const pending = await raw.session.inbox.list({ sessionID: session.id });
    expect(pending.some((item) => item.id === queued.id)).toBe(true);
    await raw.session.inbox.cancel({
      sessionID: session.id,
      inboxID: queued.id,
    });

    // Wait for the occupying turn to finish, plus a grace window in which a
    // wrongly-surviving queued item would have been delivered.
    await pollUntil(
      async () => {
        const messages = await raw.message.list({ sessionID: session.id });
        const assistant = messages.data.filter(
          (message) => message.type === "assistant",
        );
        return assistant.some((message) => message.finish !== undefined)
          ? true
          : undefined;
      },
      { timeoutMs: 90_000, label: "occupying turn finishes" },
    );
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const messages = await raw.message.list({ sessionID: session.id });
    const userTexts = messages.data
      .filter((message) => message.type === "user")
      .map((message) => message.text);
    expect(userTexts.join("\n")).not.toContain("CANCELLED_MARKER");
    const inbox = await raw.session.inbox.list({ sessionID: session.id });
    expect(inbox.some((item) => item.id === queued.id)).toBe(false);
  });
});
