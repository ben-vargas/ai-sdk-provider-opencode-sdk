import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Integration-suite config (`npm run test:integration`). Separate from the
 * unit config on purpose: NOT part of `npm run ci`, long timeouts (real
 * model turns against free zen models), and serialized files (the shared
 * server's event stream is global; parallel files would cross-talk and
 * hammer the free zen models).
 *
 * The suite runs against the published `opencode2` binary from the
 * `@opencode/cli` devDependency — see `harness/beta-server.ts`.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    globals: true,
    environment: "node",
    include: ["integration/**/*.test.ts"],
    globalSetup: ["integration/harness/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
