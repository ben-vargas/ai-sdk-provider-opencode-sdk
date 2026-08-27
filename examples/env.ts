/**
 * Shared connection plumbing for the examples.
 *
 * Server requirement (all examples): a running OpenCode v2 server that
 * speaks the `@opencode-ai/client@0.0.0-beta-18286` contract. That is the
 * published `@opencode-ai/cli` at the SAME build number — binary
 * `opencode2`:
 *
 *   npx @opencode-ai/cli@0.0.0-beta-18286 serve --port 4096
 *
 * `opencode-ai` is the **v1** package and speaks a different protocol; it
 * will not work. The repo's integration harness starts the right binary for
 * you (`npm run test:integration`, isolated from your real config), or see
 * the "Reproduction" section of `docs/v2-spike-findings.md`.
 *
 * Environment variables:
 *   OPENCODE_BETA_URL       server base URL, e.g. http://127.0.0.1:4096 (required)
 *   OPENCODE_BETA_PASSWORD  the serve password; every v2 route requires
 *                           Basic auth `opencode:<password>`. Set it via
 *                           `OPENCODE_PASSWORD` when starting `serve`, or
 *                           copy the `server password <...>` line it prints
 *   OPENCODE_MODEL          providerID/modelID (default:
 *                           opencode/nemotron-3.5-lightning-free — the zen
 *                           free tier; needs zen credentials on the server)
 *   OPENCODE_DIRECTORY      directory sessions bind to (optional; when set,
 *                           it is passed as the session `location`)
 */
import type {
  OpencodeProviderSettings,
  OpencodeSettings,
} from "../dist/index.js";

export interface ExampleConfig {
  /** Provider settings preconfigured for the beta server endpoint. */
  providerSettings: OpencodeProviderSettings;
  /** Model settings every example starts from (session location). */
  modelSettings: OpencodeSettings;
  /** `providerID/modelID` to generate with. */
  modelId: string;
}

export function exampleConfig(): ExampleConfig {
  const baseUrl = process.env.OPENCODE_BETA_URL;
  if (!baseUrl) {
    console.error(
      [
        "OPENCODE_BETA_URL is not set.",
        "",
        "These examples need an OpenCode v2 server (see the header of",
        "examples/env.ts). Start one with:",
        "",
        "  OPENCODE_PASSWORD=<password> \\",
        "    npx @opencode-ai/cli@0.0.0-beta-18286 serve --port 4096",
        "",
        "then:",
        "",
        "  OPENCODE_BETA_URL=http://127.0.0.1:4096 \\",
        "  OPENCODE_BETA_PASSWORD=<password> \\",
        "  npx tsx examples/basic-usage.ts",
      ].join("\n"),
    );
    process.exit(1);
  }

  const password = process.env.OPENCODE_BETA_PASSWORD ?? "";
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
