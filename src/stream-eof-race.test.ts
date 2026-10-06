import { describe, expect, it } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OpencodeLanguageModel } from "./opencode-language-model.js";

/**
 * Prompt failure and an unexpected event-stream end race through the real
 * SDK: the prompt rejection is delayed by N microtask ticks while the SSE
 * response ends immediately, sweeping every relative ordering.
 */
describe("prompt failure vs. unexpected event-stream end", () => {
  function later(ticks: number, callback: () => void): void {
    if (ticks === 0) {
      callback();
    } else {
      queueMicrotask(() => later(ticks - 1, callback));
    }
  }

  async function run(ticks: number) {
    let promptCalls = 0;
    const client = createOpencodeClient({
      baseUrl: "http://review.invalid",
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/event") {
          return new Response("", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        promptCalls += 1;
        return await new Promise<Response>((_, reject) =>
          later(ticks, () => reject(new Error("prompt transport failed"))),
        );
      },
    });
    const model = new OpencodeLanguageModel({
      modelId: "anthropic/claude-sonnet-4",
      settings: { sessionId: "session-123", logger: false },
      clientManager: {
        getClient: async () => client,
        registerEventSubscription: () => () => {},
      } as never,
    });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    const parts: { type: string }[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as { type: string });
    }
    return {
      errors: parts.filter((part) => part.type === "error").length,
      promptCalls,
    };
  }

  it("reports exactly one error and sends the prompt once, in every order", async () => {
    for (let ticks = 0; ticks < 40; ticks++) {
      const outcome = await run(ticks);
      expect({ ticks, ...outcome }).toEqual({
        ticks,
        errors: 1,
        promptCalls: 1,
      });
    }
  });
});
