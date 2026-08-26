// Q9 rerun on a demonstrably fresh store (review finding: the original 02 run
// reused spike/sandbox, which had already hosted CLI checks, so "fresh,
// never-migrated database" was unsupported). This script wipes and recreates
// dedicated XDG homes under spike/sandbox/fresh-migration/ before creating the
// embedded host, then calls migration.v1.status.
// Run with bun (beta sdk ESM does not resolve under Node — see finding 0.3).
import { rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, saveArtifact } from "./lib.mjs";

const fresh = join(
  dirname(fileURLToPath(import.meta.url)),
  "sandbox",
  "fresh-migration",
);
rmSync(fresh, { recursive: true, force: true });
for (const [key, sub] of [
  ["XDG_DATA_HOME", "data"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_CACHE_HOME", "cache"],
]) {
  const dir = join(fresh, sub);
  mkdirSync(dir, { recursive: true });
  process.env[key] = dir; // force-set: do NOT inherit the reused sandbox homes
}

const results = { xdgHomes: fresh, preexistingEntries: readdirSync(fresh) };
const { OpenCode } = await import("opencode-sdk-v2-beta");
const host = await OpenCode.create();
results.migration = await capture("migration.v1.status", () =>
  host.migration.v1.status(),
);
results.dataDirAfter = readdirSync(join(fresh, "data"), { recursive: true });

saveArtifact("11-migration-fresh", results);
console.log("migration.v1.status:", JSON.stringify(results.migration));
await host.close();
