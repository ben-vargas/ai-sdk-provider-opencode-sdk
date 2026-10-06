/**
 * Packed-artifact realism without publishing: build with tsup, then import
 * the built `dist/index.js` in a fresh Node subprocess and construct a
 * provider + model against a fake client. Catches ESM/exports/bundling
 * breakage that in-process source tests cannot.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("built ESM artifact", () => {
  it("dist/index.js loads in a subprocess and constructs a provider", () => {
    execFileSync("npm", ["run", "build"], {
      cwd: packageRoot,
      stdio: "pipe",
    });

    const distEntry = join(packageRoot, "dist", "index.js");
    expect(existsSync(distEntry)).toBe(true);

    const script = `
        import { createOpencode, OpencodeModels, createClientManagerFromPort } from ${JSON.stringify(
          pathToFileURL(distEntry).href,
        )};

        const fakeClient = {
          server: { info: async () => ({ version: "2.0.0", pid: 1, urls: [], paths: { tmp: "/tmp" } }) },
          migration: { v1: { status: async () => ({ status: "completed" }) } },
        };

        const provider = createOpencode({ client: fakeClient });
        const model = provider(OpencodeModels["big-pickle"]);
        if (model.specificationVersion !== "v4") {
          throw new Error("unexpected specificationVersion: " + model.specificationVersion);
        }
        if (model.provider !== "opencode") {
          throw new Error("unexpected provider: " + model.provider);
        }
        const port = await provider.getClientManager().getPort();
        if (port !== fakeClient) {
          throw new Error("manager did not hand back the supplied client");
        }
        if (typeof createClientManagerFromPort !== "function") {
          throw new Error("embedded seam missing from built artifact");
        }
        await provider.dispose();
        console.log("SMOKE_OK " + model.modelId);
      `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SMOKE_OK opencode/big-pickle");
  }, 180_000);
});
