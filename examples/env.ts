/**
 * Shared connection plumbing for the examples.
 *
 * Server requirement (all examples): a running OpenCode 2.x server. The
 * provider pins `@opencode/client@2.0.24`; the matching server is the
 * published `@opencode/cli` at the same version (binary `opencode`, also
 * exposed as `opencode2`):
 *
 *   npx @opencode/cli@2.0.24 serve --port 4096
 *
 * `opencode-ai` is the **v1** package and speaks a different protocol; it
 * will not work. The repo's integration harness starts the right binary for
 * you (`npm run test:integration`, isolated from your real config).
 *
 * Environment variables:
 *   OPENCODE_URL            server base URL, e.g. http://127.0.0.1:4096
 *                           (required; `OPENCODE_BETA_URL` is accepted too)
 *   OPENCODE_PASSWORD       the serve password; every v2 route requires
 *                           Basic auth `opencode:<password>`. Use the same
 *                           value you started `serve` with, or copy the
 *                           `server password <...>` line it prints
 *                           (`OPENCODE_BETA_PASSWORD` is accepted too)
 *   OPENCODE_MODEL          providerID/modelID (default:
 *                           opencode/nemotron-3.5-lightning-free — the zen
 *                           free tier; no credentials needed on 2.x)
 *   OPENCODE_DIRECTORY      directory sessions bind to (optional; when set,
 *                           it is passed as the session `location`)
 */
import type {
  OpencodeProviderSettings,
  OpencodeSettings,
} from "../dist/index.js";

export interface ExampleConfig {
  /** Provider settings preconfigured for the server endpoint. */
  providerSettings: OpencodeProviderSettings;
  /** Model settings every example starts from (session location). */
  modelSettings: OpencodeSettings;
  /** `providerID/modelID` to generate with. */
  modelId: string;
}

export function exampleConfig(): ExampleConfig {
  const baseUrl = process.env.OPENCODE_URL ?? process.env.OPENCODE_BETA_URL;
  if (!baseUrl) {
    console.error(
      [
        "OPENCODE_URL is not set.",
        "",
        "These examples need an OpenCode v2 server (see the header of",
        "examples/env.ts). Start one with:",
        "",
        "  OPENCODE_PASSWORD=<password> \\",
        "    npx @opencode/cli@2.0.24 serve --port 4096",
        "",
        "then:",
        "",
        "  OPENCODE_URL=http://127.0.0.1:4096 \\",
        "  OPENCODE_PASSWORD=<password> \\",
        "  npx tsx examples/basic-usage.ts",
      ].join("\n"),
    );
    process.exit(1);
  }

  const password =
    process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_BETA_PASSWORD ?? "";
  const authHeader =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

  const directory = process.env.OPENCODE_DIRECTORY;
  return {
    providerSettings: {
      baseUrl,
      clientOptions: { headers: { Authorization: authHeader } },
    },
    modelSettings: {
      sessionTitle: "ai-sdk example",
      ...(directory !== undefined ? { location: { directory } } : {}),
    },
    modelId:
      process.env.OPENCODE_MODEL ?? "opencode/nemotron-3.5-lightning-free",
  };
}
