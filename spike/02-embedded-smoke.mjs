// Smoke test of the embedded v2 host (@opencode-ai/sdk@beta-18286) — the only
// server implementation that matches @opencode-ai/client@beta-18286.
// Also re-answers Q9 (migration.v1.status) against a real v2 backend.
import {
  capture,
  saveArtifact,
  collectEventsFrom,
  sleep,
  SANDBOX_WORKDIR,
} from "./lib.mjs";

const results = {};
let host;
results.create = await capture("OpenCode.create", async () => {
  const { createEmbeddedHost } = await import("./lib.mjs");
  host = await createEmbeddedHost();
  return Object.keys(host);
});
if (!host) {
  saveArtifact("02-embedded-smoke", results);
  throw results.create.error;
}

results.health = await capture("health.get", () => host.health.get());
results.server = await capture("server.get", () => host.server.get());
results.migration = await capture("migration.v1.status", () =>
  host.migration.v1.status(),
);
results.modelDefault = await capture("model.default", () =>
  host.model.default(),
);
results.modelList = await capture("model.list", async () => {
  const out = await host.model.list();
  const data = Array.isArray(out) ? out : out.data;
  return {
    shape: Array.isArray(out) ? "array" : Object.keys(out),
    free: (data ?? [])
      .filter(
        (m) =>
          (m.cost?.[0]?.input ?? 1) === 0 && (m.cost?.[0]?.output ?? 1) === 0,
      )
      .map((m) => ({
        id: m.id,
        providerID: m.providerID,
        status: m.status,
        input: m.capabilities?.input,
      })),
  };
});

// Baseline prompt cycle on the embedded host.
const collector = collectEventsFrom(host);
results.firstEvent = await Promise.race([
  collector.ready,
  sleep(5000).then(() => "TIMEOUT"),
]);

results.session = await capture("session.create", () =>
  host.session.create({
    title: "spike-02-embedded",
    model: { id: "nemotron-3.5-lightning-free", providerID: "opencode" },
    location: { directory: SANDBOX_WORKDIR },
  }),
);
const sessionID = results.session.ok ? results.session.value.id : undefined;
if (sessionID) {
  results.receipt = await capture("session.prompt", () =>
    host.session.prompt({
      sessionID,
      text: "Reply with exactly one word: hello",
    }),
  );
  results.wait = await capture("session.wait", () =>
    host.session.wait({ sessionID }),
  );
  await sleep(1000);
  results.messages = await capture("message.list", () =>
    host.message.list({ sessionID }),
  );
  results.sessionAfter = await capture("session.get", () =>
    host.session.get({ sessionID }),
  );
}
collector.stop();
results.events = collector.events;

saveArtifact("02-embedded-smoke", results);
for (const [k, v] of Object.entries(results)) {
  if (v && typeof v === "object" && "ok" in v)
    console.log(
      k,
      v.ok
        ? `ok (${v.ms}ms)`
        : `ERROR ${v.error?._tag ?? v.error?.name ?? v.error}`,
    );
}
console.log(
  "event types:",
  [...new Set((results.events ?? []).map((e) => e.type))].join(", "),
);
await host.close();
