// Full prompt->completion cycle against the DEV server (14096) using its raw
// contract. Answers: Q4 (correlation IDs on events), Q7 (event stream during
// generation), Q8 partial (usage on message), plus what "receipt" contains.
import {
  client,
  capture,
  saveArtifact,
  collectEvents,
  sleep,
  rawPrompt,
  rawCall,
  SANDBOX_WORKDIR,
} from "./lib.mjs";

const results = {};
const collector = collectEvents();
results.firstEvent = await Promise.race([
  collector.ready,
  sleep(5000).then(() => "TIMEOUT"),
]);

results.session = await capture("session.create", () =>
  client.session.create({
    title: "spike-04-full-cycle",
    model: { id: "nemotron-3.5-lightning-free", providerID: "opencode" },
    location: { directory: SANDBOX_WORKDIR },
  }),
);
const sessionID = results.session.value?.id;

results.receipt = await capture("rawPrompt", () =>
  rawPrompt(sessionID, { text: "Reply with exactly one word: hello" }),
);

// Wait route (declared but reported unavailable earlier — confirm via raw call).
results.waitRaw = await capture("wait-raw", () =>
  Promise.race([
    rawCall(`/api/session/${sessionID}/wait`, { method: "POST", body: {} }),
    sleep(8000).then(() => "PENDING-AFTER-8S"),
  ]),
);

// Completion detection: poll messages until an assistant message finishes.
let finalMessages;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const res = await rawCall(`/api/session/${sessionID}/message`);
  const msgs = res.body?.data ?? res.body;
  finalMessages = res;
  const assistant = (Array.isArray(msgs) ? msgs : []).filter(
    (m) =>
      m?.type === "assistant" ||
      m?.role === "assistant" ||
      m?.info?.role === "assistant",
  );
  const done = assistant.some(
    (m) =>
      m?.finish ||
      m?.info?.finish ||
      m?.time?.completed ||
      m?.info?.time?.completed,
  );
  if (done) break;
}
results.messages = finalMessages;

await sleep(2000);
collector.stop();
results.events = collector.events;
results.sessionAfter = await capture("session.get", () =>
  client.session.get({ sessionID }),
);

saveArtifact("04-dev-full-cycle", results);
console.log(
  "receipt:",
  JSON.stringify(results.receipt.value ?? results.receipt.error?.message).slice(
    0,
    300,
  ),
);
console.log("waitRaw:", JSON.stringify(results.waitRaw.value).slice(0, 200));
console.log(
  "event types:",
  [...new Set(results.events.map((e) => e.type))].join(", "),
);
console.log("event count:", results.events.length);
