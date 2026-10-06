/**
 * Prompt → stream → finish round-trips through the real provider against the
 * beta-source server (stage-6 brief, deliverable 2): doStream part sequence,
 * doGenerate reconciliation, and usage/finish assertions.
 */
import { afterAll, describe, expect, it } from "vitest";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { OpencodeProviderMetadata } from "../src/index.js";
import {
  collectStream,
  integrationContext,
  suiteTitle,
} from "./harness/context.js";

const ctx = integrationContext();

function prompt(text: string): LanguageModelV4CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text }] }] };
}

function opencodeMetadata(
  providerMetadata: unknown,
): OpencodeProviderMetadata["opencode"] {
  return (providerMetadata as OpencodeProviderMetadata).opencode;
}

describe.skipIf(!ctx.canGenerate)(suiteTitle("round-trip", ctx), () => {
  const provider = ctx.available ? ctx.makeProvider() : undefined;

  afterAll(async () => {
    await provider?.dispose();
  });

  it("doStream: streams text parts and finishes with usage + metadata", async () => {
    const model = provider!(ctx.modelId);
    const parts = await collectStream<LanguageModelV4StreamPart>(
      await model.doStream(prompt("Reply with exactly: OK")),
    );

    expect(parts[0]?.type).toBe("stream-start");

    const deltas = parts.filter((part) => part.type === "text-delta");
    expect(deltas.length).toBeGreaterThan(0);
    const text = deltas.map((part) => part.delta).join("");
    expect(text.length).toBeGreaterThan(0);

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toBeDefined();
    if (finish?.type !== "finish") {
      return;
    }
    expect(finish.finishReason.unified).toBe("stop");
    expect(finish.usage.inputTokens?.total).toBeGreaterThan(0);

    const metadata = opencodeMetadata(finish.providerMetadata);
    expect(metadata.sessionId).toMatch(/^ses_/);
    expect(metadata.outcome).toBe("succeeded");
    expect(metadata.finish).toBe("stop");
    expect(metadata.inboxId).toMatch(/^msg_/);
  });

  it("doGenerate: aggregates the turn and reconciles with the message store", async () => {
    const model = provider!(ctx.modelId);
    const result = await model.doGenerate(prompt("Reply with exactly: PONG"));

    const textPart = result.content.find((part) => part.type === "text");
    expect(textPart).toBeDefined();
    if (textPart?.type === "text") {
      expect(textPart.text.length).toBeGreaterThan(0);
    }
    expect(result.finishReason.unified).toBe("stop");
    expect(result.usage.inputTokens?.total).toBeGreaterThan(0);

    const metadata = opencodeMetadata(result.providerMetadata);
    expect(metadata.sessionId).toMatch(/^ses_/);
    expect(metadata.outcome).toBe("succeeded");

    // The reconciliation source of truth: the server's message store holds
    // the user turn and a finished assistant message on that session.
    const raw = ctx.makeRawClient();
    const messages = await raw.message.list({ sessionID: metadata.sessionId });
    const roles = messages.data.map((message) => message.type);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const assistant = messages.data.filter(
      (message) => message.type === "assistant",
    );
    expect(assistant.some((message) => message.finish === "stop")).toBe(true);
  });

  it("pins one session per model instance across calls", async () => {
    const model = provider!(ctx.modelId);
    const first = await model.doGenerate(prompt("Reply with exactly: ONE"));
    const second = await model.doGenerate(prompt("Reply with exactly: TWO"));

    const firstSession = opencodeMetadata(first.providerMetadata).sessionId;
    const secondSession = opencodeMetadata(second.providerMetadata).sessionId;
    expect(firstSession).toMatch(/^ses_/);
    expect(secondSession).toBe(firstSession);
  });
});
