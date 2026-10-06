/**
 * Backend selection and client configuration.
 *
 * Requires an OpenCode 2.x server — see examples/env.ts for the server
 * requirement and environment variables.
 *
 * The provider picks exactly one backend, in precedence order:
 *   1. `client`        — a caller-supplied `OpenCode.make(...)` client
 *   2. `clientManager` — a caller-supplied manager (advanced injection seam)
 *   3. `baseUrl`       — the provider constructs the client (+ clientOptions)
 *   4. service discovery — `Service.discover()` via the registration file
 *      (`autoStart: true` additionally spawns via `Service.ensure`; note no
 *      published CLI supports `serve --service` yet)
 *
 * `clientOptions` is the v2 construction passthrough: `{headers, fetch}`.
 * Beta servers require Basic auth (`opencode:<password>`) on every route,
 * so `headers.Authorization` is how you connect to one via `baseUrl`.
 */
import { generateText } from "ai";
import { OpenCode } from "@opencode/client";
import { createOpencode } from "../dist/index.js";
import { exampleConfig } from "./env.js";

async function main() {
  const { providerSettings, modelSettings, modelId } = exampleConfig();
  const baseUrl = providerSettings.baseUrl!;
  const headers = providerSettings.clientOptions!.headers as Record<
    string,
    string
  >;

  // --- 1. baseUrl backend with headers and a logging fetch wrapper ---
  let requests = 0;
  const withLoggingFetch = createOpencode({
    baseUrl,
    clientOptions: {
      headers,
      fetch: (input, init) => {
        requests += 1;
        const url = input instanceof Request ? input.url : String(input);
        console.log(`  [fetch #${requests}] ${init?.method ?? "GET"} ${url}`);
        return fetch(input, init);
      },
    },
  });

  try {
    console.log("baseUrl backend (custom fetch logs every request):");
    const result = await generateText({
      model: withLoggingFetch(modelId, modelSettings),
      prompt: "Reply with the single word: ready",
    });
    console.log("Response:", result.text.trim());
    console.log("Requests made:", requests);
  } finally {
    await withLoggingFetch.dispose();
  }

  // --- 2. caller-supplied client (provider never disposes it) ---
  const client = OpenCode.make({ baseUrl, headers });
  const withClient = createOpencode({ client });
  try {
    console.log("\nCaller-supplied client backend:");
    const info = await client.server.info();
    console.log("Server info:", { version: info.version, pid: info.pid });
    const result = await generateText({
      model: withClient(modelId, modelSettings),
      prompt: "Reply with the single word: ready",
    });
    console.log("Response:", result.text.trim());
  } finally {
    // dispose() never closes a caller-supplied client — its lifecycle is
    // yours.
    await withClient.dispose();
  }

  // --- 3. service discovery (shown, not run: needs a registered service) ---
  // const discovered = createOpencode({
  //   service: { file: "/path/to/service-registration.json" },
  //   autoStart: false, // discovery only; ensure/spawn is opt-in
  // });
}

main().catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
