/**
 * `session.wait` watchdog on a healthy turn (stage-7 brief, deliverable 1):
 * the watchdog must be a no-op — completion stays event-driven, and none of
 * the watchdog/reconciliation recovery paths fire (each of those logs a
 * warning through the model's logger, which this test captures).
 */
import { afterAll, describe, expect, it } from "vitest";
import { integrationContext, suiteTitle } from "./harness/context.js";

const ctx = integrationContext();

describe.skipIf(!ctx.canGenerate)(suiteTitle("wait watchdog", ctx), () => {
  const warnings: string[] = [];
  const provider = ctx.available
    ? ctx.makeProvider({
        defaultSettings: {
          logger: {
            warn: (message: string) => warnings.push(message),
            error: (message: string) => warnings.push(message),
          },
        },
      })
    : undefined;

  afterAll(async () => {
    await provider?.dispose();
  });

  it("completes a healthy turn from events with no watchdog recovery", async () => {
    const model = provider!(ctx.modelId);
    const result = await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply with exactly: WATCHDOG-OK" }],
        },
      ],
    });

    expect(result.finishReason.unified).toBe("stop");
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(text.length).toBeGreaterThan(0);

    // No recovery path fired: the wait watchdog armed, lost the race to the
    // event stream's terminal, and was torn down silently.
    const recovery = warnings.filter(
      (message) =>
        /session\.wait/i.test(message) ||
        /finalizing from the message store/i.test(message) ||
        /watchdog/i.test(message),
    );
    expect(recovery).toEqual([]);
  }, 180_000);
});
