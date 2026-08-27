/**
 * Shared connection plumbing for the examples.
 *
 * Server requirement (all examples): a running OpenCode v2 server that
 * speaks the `@opencode-ai/client@0.0.0-beta-18286` contract. No published
 * OpenCode binary does today — the only known compatible server is the
 * upstream `anomalyco/opencode` beta branch built from source (commit
 * `f4a9b930…`). The repo's integration harness starts one for you
 * (`npm run test:integration` clones/installs/serves it, isolated from your
 * real config), or see the "Reproduction" section of
 * `docs/v2-spike-findings.md` to run it manually.
 *
 * Environment variables:
 *   OPENCODE_BETA_URL       server base URL, e.g. http://127.0.0.1:14196 (required)
 *   OPENCODE_BETA_PASSWORD  the serve password; every beta route requires
 *                           Basic auth `opencode:<password>`
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
        "These examples need an OpenCode v2 beta server (see the header of",
        "examples/env.ts). Start one with the integration harness or the",
        "manual steps in docs/v2-spike-findings.md, then:",
        "",
        "  OPENCODE_BETA_URL=http://127.0.0.1:14196 \\",
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
