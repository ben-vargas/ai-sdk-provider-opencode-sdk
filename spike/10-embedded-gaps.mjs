// Review-gap captures for findings 0.2/0.3 claims that had no artifact:
//  - provider.list on the embedded host (previously asserted as a 500,
//    unwitnessed — only the dev server had a provider.list capture).
//  - the host's own log hook at level "trace": is anything emitted around the
//    failing calls (model.list / session.prompt 500s)?
// Run with bun (beta sdk ESM does not resolve under Node — see finding 0.3).
import { capture, saveArtifact, sleep, SANDBOX_WORKDIR } from "./lib.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = join(dirname(fileURLToPath(import.meta.url)), "sandbox");
for (const [key, sub] of [
  ["XDG_DATA_HOME", "data"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_CACHE_HOME", "cache"],
]) {
  if (!process.env[key]) process.env[key] = join(sandbox, sub);
}

const logEntries = [];
const { OpenCode } = await import("opencode-sdk-v2-beta");
const host = await OpenCode.create({
  log: {
    level: "trace",
    emit: (entry) =>
      logEntries.push({
        level: entry.level,
        message: entry.message,
        attributes: entry.attributes,
        cause: entry.cause ? String(entry.cause) : undefined,
      }),
  },
});

const results = {};
results.providerList = await capture("provider.list", () =>
  host.provider.list(),
);
results.logAfterProviderList = logEntries.length;

results.modelList = await capture("model.list", () => host.model.list());
results.session = await capture("session.create", () =>
  host.session.create({
    title: "spike-10-gaps",
    location: { directory: SANDBOX_WORKDIR },
  }),
);
if (results.session.ok) {
  results.prompt = await capture("session.prompt", () =>
    host.session.prompt({ sessionID: results.session.value.id, text: "hi" }),
  );
}
await sleep(500);
results.logEntryCount = logEntries.length;
results.logEntries = logEntries.slice(0, 200);

saveArtifact("10-embedded-gaps", results);
for (const [k, v] of Object.entries(results)) {
  if (v && typeof v === "object" && "ok" in v)
    console.log(
      k,
      v.ok
        ? "ok"
        : `ERROR ${v.error?._tag ?? v.error?.reason ?? v.error?.name}: ${String(v.error?.message).slice(0, 100)}`,
    );
}
console.log("log entries captured at trace level:", logEntries.length);
await host.close();
