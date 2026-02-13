import { generateText, streamText } from "ai";
import { createOpencode } from "../dist/index.js";

type TimeoutController = AbortController & { clearTimeout: () => void };

function createTimeoutController(
  ms: number,
  reason: string,
): TimeoutController {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`${reason} after ${ms}ms`));
  }, ms);
  return Object.assign(controller, {
    clearTimeout: () => clearTimeout(timeoutId),
  });
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" || error.message.toLowerCase().includes("abort")
  );
}

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  console.log("=== OpenCode: Abort Signal Examples ===\n");

  try {
    console.log("1. Request with timeout (45 seconds):\n");
    const controller1 = createTimeoutController(45000, "Request timeout");
    try {
      const { text } = await generateText({
        model: opencode("anthropic/claude-opus-4-5-20251101"),
        prompt: "What is 2 + 2? Respond with only the number.",
        abortSignal: controller1.signal,
      });
      console.log("   Response:", text);
      console.log("   Completed before timeout.\n");
    } catch (error: unknown) {
      if (isAbortError(error)) {
        console.log("   Request was aborted.\n");
      } else {
        console.error("   Error:", error);
      }
    } finally {
      controller1.clearTimeout();
    }

    console.log("2. Cancellation before request starts:\n");
    const controller2 = new AbortController();
    controller2.abort();

    try {
      await generateText({
        model: opencode("anthropic/claude-opus-4-5-20251101"),
        prompt: "This request is pre-aborted.",
        abortSignal: controller2.signal,
      });
      console.log("   Unexpected success.");
    } catch (error: unknown) {
      if (isAbortError(error)) {
        console.log("   Request was aborted before execution.\n");
      } else {
        console.error("   Error:", error);
      }
    }

    console.log("3. Streaming cancellation after partial output:\n");
    const controller3 = createTimeoutController(45000, "Stream timeout");
    let charCount = 0;

    try {
      const { textStream } = streamText({
        model: opencode("anthropic/claude-opus-4-5-20251101"),
        prompt: "Count from 1 to 20 and briefly explain each number.",
        abortSignal: controller3.signal,
      });

      process.stdout.write("   Streaming: ");
      for await (const chunk of textStream) {
        process.stdout.write(chunk);
        charCount += chunk.length;

        if (charCount >= 120) {
          console.log(`\n   Aborting stream after ${charCount} characters...`);
          controller3.abort();
        }
      }
      console.log("\n   Stream ended.\n");
    } catch (error: unknown) {
      if (isAbortError(error)) {
        console.log("\n   Stream was aborted.\n");
      } else {
        console.error("\n   Error:", error);
      }
    } finally {
      controller3.clearTimeout();
    }

    console.log("Done.");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
