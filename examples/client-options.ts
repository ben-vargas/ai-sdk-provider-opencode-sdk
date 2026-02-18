import { generateText } from "ai";
import { createOpencode } from "../dist/index.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const MODEL = "openai/gpt-5.3-codex-spark";
const BASE_URL = "http://127.0.0.1:4096";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runStep(title: string, fn: () => Promise<void>) {
  console.log(title);
  try {
    await fn();
  } catch (error) {
    console.error(`  Error: ${formatError(error)}`);
  }
  console.log();
}

async function main() {
  console.log("=== OpenCode: clientOptions and preconfigured client ===");
  console.log("This example assumes an OpenCode server is available at", BASE_URL);
  console.log();

  const providerWithClientOptions = createOpencode({
    baseUrl: BASE_URL,
    clientOptions: {
      headers: {
        "x-demo-source": "client-options-example",
      },
      credentials: "include",
      throwOnError: true,
    },
  });

  await runStep("1) Provider with clientOptions passthrough", async () => {
    const { text } = await generateText({
      model: providerWithClientOptions(MODEL),
      prompt: 'Reply with exactly: "client-options-ok".',
    });
    console.log(`  Response: ${text}`);
  });

  const preconfiguredClient = await createOpencodeClient({
    baseUrl: BASE_URL,
    headers: {
      "x-demo-source": "preconfigured-client-example",
    },
    throwOnError: true,
  });

  const providerWithPreconfiguredClient = createOpencode({
    client: preconfiguredClient,
  });

  await runStep("2) Provider with preconfigured SDK client", async () => {
    const { text } = await generateText({
      model: providerWithPreconfiguredClient(MODEL),
      prompt: 'Reply with exactly: "preconfigured-client-ok".',
    });
    console.log(`  Response: ${text}`);
  });

  await providerWithClientOptions.dispose?.();
  await providerWithPreconfiguredClient.dispose?.();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
