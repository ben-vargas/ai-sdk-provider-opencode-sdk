import { generateText } from "ai";
import { createOpencode, OpencodeClientManager } from "../dist/index.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const MODEL = process.env.OPENCODE_MODEL ?? "openai/gpt-5.3-codex-spark";
const BASE_URL = "http://127.0.0.1:4096";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Wraps fetch to echo each outgoing request's x-demo-source header, so the
// output proves which client a request actually flowed through.
function echoingFetch(): typeof fetch {
  return (input, init) => {
    const headers =
      input instanceof Request ? input.headers : new Headers(init?.headers);
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    const method =
      (input instanceof Request ? input.method : init?.method) ?? "GET";
    const source = headers.get("x-demo-source") ?? "(none)";
    console.log(
      `  [http] ${method} ${new URL(url).pathname} x-demo-source: ${source}`,
    );
    return fetch(input, init);
  };
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
  console.log(
    "This example assumes an OpenCode server is available at",
    BASE_URL,
  );
  console.log();

  const providerWithClientOptions = createOpencode({
    baseUrl: BASE_URL,
    clientOptions: {
      headers: {
        "x-demo-source": "client-options-example",
      },
      fetch: echoingFetch(),
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

  // createOpencodeClient() is synchronous in @opencode-ai/sdk/v2.
  const preconfiguredClient = createOpencodeClient({
    baseUrl: BASE_URL,
    headers: {
      "x-demo-source": "preconfigured-client-example",
    },
    fetch: echoingFetch(),
    throwOnError: true,
  });

  // createOpencode({ client }) hands the client to the process-wide singleton
  // client manager. Step 1 already initialized that singleton, so the client
  // would be ignored (with a warning) and requests would keep flowing through
  // step 1's client. An isolated manager guarantees this provider really uses
  // the preconfigured client.
  const providerWithPreconfiguredClient = createOpencode({
    clientManager: OpencodeClientManager.createInstance({
      client: preconfiguredClient,
    }),
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
