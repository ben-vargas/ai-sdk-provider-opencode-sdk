// Structural (non-generation) checks against the embedded beta-18286 host:
// - prompt failure detail (catalog 500 investigation)
// - Q2: session.wait on an idle session (resolve vs hang)
// - Q5: instructions.entry.put/list round-trip
// - Q6/Q13: form.create/state/reply/cancel lifecycle + events
// - Q4: inbox list, session.log contents
// Run with bun (beta sdk ships extensionless ESM that Node cannot resolve).
import {
  createEmbeddedHost,
  capture,
  saveArtifact,
  collectEventsFrom,
  sleep,
  SANDBOX_WORKDIR,
} from "./lib.mjs";

const host = await createEmbeddedHost();
const results = {};
const collector = collectEventsFrom(host);
await Promise.race([collector.ready, sleep(3000)]);

results.session = await capture("session.create", () =>
  host.session.create({
    title: "spike-03-structural",
    location: { directory: SANDBOX_WORKDIR },
  }),
);
const sessionID = results.session.value?.id;

// Prompt with no model set on the session (model catalog suspect).
results.promptNoModel = await capture("prompt-no-model", () =>
  host.session.prompt({ sessionID, text: "hi" }),
);

// Q2: wait on an idle session with nothing running.
results.waitIdle = await capture("wait-idle", () =>
  Promise.race([
    host.session.wait({ sessionID }).then(() => "RESOLVED"),
    sleep(4000).then(() => "STILL-PENDING-AFTER-4S"),
  ]),
);

// Q5: instructions round-trip.
results.instructionsPut = await capture("instructions.put", () =>
  host.session.instructions.entry.put({
    sessionID,
    key: "spike-sys",
    value: "Always answer in French.",
  }),
);
results.instructionsList = await capture("instructions.list", () =>
  host.session.instructions.entry.list({ sessionID }),
);

// Q6/Q13: form lifecycle (created by us, not by a tool — still shows event + reply shapes).
results.formCreate = await capture("form.create", () =>
  host.form.create({
    sessionID,
    title: "spike form",
    fields: [{ key: "color", type: "string", title: "Favorite color" }],
  }),
);
const formID = results.formCreate.value?.id;
if (formID) {
  results.formState = await capture("form.state", () =>
    host.form.state({ sessionID, formID }),
  );
  results.formReply = await capture("form.reply", () =>
    host.form.reply({ sessionID, formID, answer: { color: "blue" } }),
  );
  results.formStateAfter = await capture("form.state-after", () =>
    host.form.state({ sessionID, formID }),
  );
  results.formReplyAgain = await capture("form.reply-again (settled)", () =>
    host.form.reply({ sessionID, formID, answer: { color: "red" } }),
  );
}
results.formList = await capture("form.list", () =>
  host.form.list({ sessionID }),
);

// Q4: inbox + durable log.
results.inbox = await capture("inbox.list", () =>
  host.session.inbox.list({ sessionID }),
);
results.log = await capture("session.log", async () => {
  const items = [];
  for await (const item of host.session.log({ sessionID })) {
    items.push(item);
    if (items.length > 50) break;
  }
  return items;
});

await sleep(500);
collector.stop();
results.events = collector.events;

saveArtifact("03-embedded-structural", results);
for (const [k, v] of Object.entries(results)) {
  if (v && typeof v === "object" && "ok" in v)
    console.log(
      k,
      v.ok
        ? `ok (${v.ms}ms)`
        : `ERROR ${v.error?._tag ?? v.error?.reason ?? v.error?.name}: ${String(v.error?.message).slice(0, 120)}`,
    );
}
console.log("events:", (results.events ?? []).map((e) => e.type).join(", "));
await host.close();
