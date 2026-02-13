import { generateText, streamText } from "ai";
import { createOpencode } from "../dist/index.js";

const opencode = createOpencode({
  autoStartServer: true,
});

type TimeoutController = AbortController & { clearTimeout: () => void };

function createTimeoutController(
  ms: number,
  reason = "Request timeout",
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

async function runWithTimeout(
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = createTimeoutController(timeoutMs);
  try {
    const { text } = await generateText({
      model: opencode("anthropic/claude-opus-4-5-20251101"),
      prompt,
      abortSignal: controller.signal,
    });
    return text;
  } finally {
    controller.clearTimeout();
  }
}

async function withTimeout() {
  console.log("1. Time-boxed request:\n");

  try {
    const text = await runWithTimeout(
      "Explain quantum computing in two short sentences.",
      45000,
    );
    console.log("   Response:", text);
    console.log("   Completed before timeout.\n");
  } catch (error: unknown) {
    if (isAbortError(error)) {
      console.log("   Request timed out and was cancelled.\n");
    } else {
      console.error("   Error:", error, "\n");
    }
  }
}

async function withUserCancellation() {
  console.log("2. User-cancellable streaming request:\n");

  const controller = createTimeoutController(45000, "Stream timeout");
  let charCount = 0;
  console.log("   Starting stream (auto-cancel after ~120 chars)...");
  process.stdout.write("   Output: ");

  try {
    const { textStream } = streamText({
      model: opencode("anthropic/claude-opus-4-5-20251101"),
      prompt: "Write a comprehensive guide to machine learning.",
      abortSignal: controller.signal,
    });

    for await (const chunk of textStream) {
      process.stdout.write(chunk);
      charCount += chunk.length;

      if (charCount >= 120) {
        console.log(`\n   [Cancel requested at ${charCount} characters]`);
        controller.abort();
      }
    }
    console.log("\n   Stream ended.\n");
  } catch (error: unknown) {
    if (isAbortError(error)) {
      console.log("\n   Streaming request cancelled.\n");
    } else {
      console.error("\n   Error:", error, "\n");
    }
  } finally {
    controller.clearTimeout();
  }
}

async function withGracefulTimeout() {
  console.log("3. Retry with a longer timeout:\n");
  const prompt = "Explain the theory of relativity in one sentence.";
  try {
    const text = await runWithTimeout(prompt, 20000);
    console.log("   Success on first attempt:", text, "\n");
  } catch (error: unknown) {
    if (!isAbortError(error)) {
      console.error("   Error:", error, "\n");
      return;
    }
    console.log("   First attempt timed out. Retrying with 45 seconds...");
    try {
      const retryText = await runWithTimeout(prompt, 45000);
      console.log("   Retry succeeded:", retryText, "\n");
    } catch (retryError) {
      console.error("   Retry failed:", retryError, "\n");
    }
  }
}

async function main() {
  console.log("=== OpenCode: Long-Running Task Examples ===\n");
  console.log("Simple patterns for timeouts, cancellation, and retries.\n");

  try {
    await withTimeout();
    await withUserCancellation();
    await withGracefulTimeout();
    console.log("Done.");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
