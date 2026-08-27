/**
 * Busy-session semantics on the beta-source server (stage-6 brief,
 * deliverable 2): prompting a busy session must not throw Conflict/busy, and
 * `delivery: "queue"` runs the second prompt after the current turn.
 *
 * Exercised at the raw-client level: the server-side contract is what the
 * provider's queue default and busy-retry path rely on, and driving a
 * foreign-busy session through the provider itself is outside its
 * exclusive-session contract (event attribution is ordering-based).
 */
import { describe, expect, it } from "vitest";
import {
  integrationContext,
  parseModelRef,
  pollUntil,
  suiteTitle,
} from "./harness/context.js";

const ctx = integrationContext();

describe.skipIf(!ctx.canGenerate)(suiteTitle("busy + queue", ctx), () => {
  it("queues a prompt behind a busy turn without ConflictError and runs it after", async () => {
    const raw = ctx.makeRawClient();
    const model = parseModelRef(ctx.modelId);
    // Model is session state on the v2 contract (no per-prompt model field).
    const session = await raw.session.create({
      title: "integration-busy-queue",
      location: { directory: ctx.workdir },
      model: { id: model.modelID, providerID: model.providerID },
    });

    const first = await raw.session.prompt({
      sessionID: session.id,
      text: "Write a story about a lighthouse in about 150 words.",
    });

    // Busy session + queue: must be admitted (409/SessionBusyError would
    // reject here), and must not run until the story turn completes.
    const queued = await raw.session.prompt({
      sessionID: session.id,
      text: "Reply with exactly: MANGO",
      delivery: "queue",
    });
    expect(queued.id).toMatch(/^msg_/);
    expect(queued.delivery).toBe("queue");

    const messages = await pollUntil(
      async () => {
        const list = await raw.message.list({
          sessionID: session.id,
          order: "asc",
        });
        const assistant = list.data.filter(
          (message) => message.type === "assistant",
        );
        const settled =
          assistant.length >= 2 &&
          assistant.every((message) => message.finish !== undefined);
        return settled ? list.data : undefined;
      },
      { timeoutMs: 180_000, label: "both turns complete" },
    );

    // Order: first turn's messages fully precede the queued turn's.
    const userIndexes = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.type === "user");
    expect(userIndexes.length).toBe(2);
    const [firstUser, queuedUser] = userIndexes;
    expect(firstUser!.message.id).toBe(first.id);
    expect(queuedUser!.message.id).toBe(queued.id);
    expect(firstUser!.index).toBeLessThan(queuedUser!.index);

    // The queued turn answered its own question.
    const finalAssistant = messages[messages.length - 1];
    expect(finalAssistant?.type).toBe("assistant");
    if (finalAssistant?.type === "assistant") {
      const text = finalAssistant.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      expect(text).toContain("MANGO");
    }
    // Two sequential model turns; free-tier models have run at 45-60 s per
    // story turn, so the vitest default 120 s budget flakes.
  }, 240_000);
});
