/**
 * File attach via `data:` URI (stage-6 brief, deliverable 2): the provider
 * converts binary file parts to base64 `data:` URIs — the one scheme the
 * spike verified reaches the model — and the server stores the attachment on
 * the user message with the URI's declared media type.
 */
import { afterAll, describe, expect, it } from "vitest";
import { integrationContext, suiteTitle } from "./harness/context.js";

const ctx = integrationContext();

/** 64×64 solid-red PNG (spike finding Q1: 8×8 images get misread; 64×64 is
 * reliably identified by both zen vision models). */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

const suite = describe.skipIf(!ctx.canGenerate);

suite(suiteTitle("file attach (data: URI)", ctx), () => {
  const provider = ctx.available ? ctx.makeProvider() : undefined;

  afterAll(async () => {
    await provider?.dispose();
  });

  it("attaches an image as a data: URI and the model sees its content", async (t) => {
    // Needs an image-capable zen model (zen auth) — the resolved test model
    // is text-focused and may not be image-capable, so this test picks its
    // own model from the catalog and skips without zen credentials.
    if (!ctx.authAvailable) {
      t.skip();
      return;
    }
    const raw = ctx.makeRawClient();
    const catalog = await raw.model.list({});
    const imageModel = catalog.data.find(
      (model) =>
        model.providerID === "opencode" &&
        model.modelID.endsWith("-free") &&
        (model.capabilities?.input ?? []).includes("image"),
    );
    if (imageModel === undefined) {
      t.skip();
      return;
    }

    const model = provider!(`${imageModel.providerID}/${imageModel.modelID}`);
    const result = await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What single color dominates this image? Answer with one word.",
            },
            {
              type: "file",
              mediaType: "image/png",
              filename: "red-square.png",
              data: { type: "data", data: RED_PNG_BASE64 },
            },
          ],
        },
      ],
    });

    expect(result.finishReason.unified).toBe("stop");
    const textPart = result.content.find((part) => part.type === "text");
    expect(textPart).toBeDefined();
    if (textPart?.type === "text") {
      expect(textPart.text).toMatch(/red/i);
    }

    // The stored user message carries the attachment normalized to base64
    // payload + MIME (the beta contract's stored shape, unlike the dev
    // server's raw-URI storage).
    const metadata = result.providerMetadata?.opencode as {
      sessionId: string;
    };
    const messages = await raw.message.list({
      sessionID: metadata.sessionId,
    });
    const user = messages.data.find((message) => message.type === "user");
    expect(user).toBeDefined();
    if (user?.type === "user") {
      expect(user.files?.[0]?.mime).toBe("image/png");
      expect(user.files?.[0]?.data.length).toBeGreaterThan(0);
    }
  });
});
