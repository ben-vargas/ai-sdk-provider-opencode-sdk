// Q4 (correlation) + Q7 (event mechanics) + generation sanity check.
// Full event capture for one prompt -> completion cycle on a free model.
import {
  client,
  capture,
  saveArtifact,
  collectEvents,
  sleep,
  SANDBOX_WORKDIR,
} from "./lib.mjs";

const MODEL = { id: "nemotron-3.5-lightning-free", providerID: "opencode" };
const results = {};

// Q7: is server.connected emitted on subscribe?
const collector = collectEvents(); // capture everything
const firstEvent = await Promise.race([
  collector.ready,
  sleep(5000).then(() => "TIMEOUT"),
]);
results.firstEventOnSubscribe = firstEvent;

results.session = await capture("session.create", () =>
  client.session.create({
    title: "spike-01-baseline",
    model: MODEL,
    location: { directory: SANDBOX_WORKDIR },
  }),
);
if (!results.session.ok) {
  saveArtifact("01-baseline-cycle", results);
  throw results.session.error;
}
const sessionID = results.session.value.id;

results.receipt = await capture("session.prompt", () =>
  client.session.prompt({
    sessionID,
    text: "Reply with exactly one word: hello",
  }),
);

results.wait = await capture("session.wait", () =>
  client.session.wait({ sessionID }),
);
await sleep(1500); // allow trailing events (title generation etc.)

results.messages = await capture("message.list", () =>
  client.message.list({ sessionID }),
);
results.sessionAfter = await capture("session.get", () =>
  client.session.get({ sessionID }),
);
results.inboxAfter = await capture("session.inbox.list", () =>
  client.session.inbox.list({ sessionID }),
);

// Q7 abort path: stop() aborts the subscribe signal (NOT a plain loop break —
// that path is exercised in 09-service-and-stream.mjs); observe how done settles.
collector.stop();
results.collectorDone = await Promise.race([
  collector.done,
  sleep(3000).then(() => "DONE-TIMEOUT"),
]);
results.events = collector.events;

// Q7 replay check: a second fresh subscription — does it replay old events?
const replay = collectEvents();
const replayFirst = await Promise.race([
  replay.ready,
  sleep(4000).then(() => "TIMEOUT"),
]);
await sleep(2000);
replay.stop();
results.replayCheck = {
  firstEvent: replayFirst,
  eventsReceived: replay.events.map((e) => e.type),
};

saveArtifact("01-baseline-cycle", results);
console.log("events captured:", results.events.length);
console.log(
  "event types:",
  [...new Set(results.events.map((e) => e.type))].join(", "),
);
console.log("wait ok:", results.wait.ok, "ms:", results.wait.ms);
