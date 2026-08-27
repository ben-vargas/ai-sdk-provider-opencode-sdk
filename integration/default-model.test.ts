/**
 * Default-model canary (stage-10 decision C): the rest of the suite runs on
 * a pinned test model precisely because the server's own default model
 * (`opencode/nemotron-3.5-lightning-free` at the time of writing) has been
 * observed accepting prompts and never answering. This canary is the one
 * place that still exercises the default: when IT fails, the upstream
 * default is broken — read other suites' timeouts in that light, and do not
 * chase them as provider regressions.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  integrationContext,
  pollUntil,
  suiteTitle,
} from "./harness/context.js";

const ctx = integrationContext();

/** Bounded window for the default model to produce an assistant message. */
const CANARY_TIMEOUT_MS = 120_000;

const canRun = ctx.available && ctx.authAvailable && ctx.defaultModelId !== "";

describe.skipIf(!canRun)(suiteTitle("default-model canary", ctx), () => {
  const raw = ctx.available ? ctx.makeRawClient() : undefined;

  afterAll(() => {
    // Raw client holds no resources; sessions live in the sandbox.
  });

  it(
    `server default model (${ctx.defaultModelId}) produces an assistant message`,
    async () => {
      const client = raw!;
      const [providerID, modelID] = [
        ctx.defaultModelId.slice(0, ctx.defaultModelId.indexOf("/")),
        ctx.defaultModelId.slice(ctx.defaultModelId.indexOf("/") + 1),
      ];
      const session = await client.session.create({
        title: "default-model-canary",
        model: { providerID, id: modelID },
        location: { directory: ctx.workdir },
      });
      await client.session.prompt({
        sessionID: session.id,
        text: "Reply with exactly: OK",
      });

      let finished = false;
      try {
        await pollUntil(
          async () => {
            const messages = await client.message.list({
              sessionID: session.id,
            });
            return messages.data.some(
              (message) =>
                message.type === "assistant" &&
                typeof message.finish === "string" &&
                message.finish.length > 0,
            )
              ? true
              : undefined;
          },
          {
            timeoutMs: CANARY_TIMEOUT_MS,
            intervalMs: 2_000,
            label: "assistant message from the server default model",
          },
        );
        finished = true;
      } catch {
        finished = false;
      }

      expect(
        finished,
        `upstream default model appears broken: ${ctx.defaultModelId} accepted the prompt ` +
          `but produced no finished assistant message within ${CANARY_TIMEOUT_MS}ms. ` +
          `This is an upstream outage of the server's default model, NOT a provider ` +
          `regression — timeouts elsewhere in the suite (if any) likely share this cause.`,
      ).toBe(true);
    },
    CANARY_TIMEOUT_MS + 60_000,
  );
});
