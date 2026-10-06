// Q8: multi-step turn — are SessionStepEnded.tokens per-step increments or
// cumulative? Does one execution produce multiple assistant messages?
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

const MODEL = { id: "nemotron-3.5-lightning-free", providerID: "opencode" };
const sessionID = (
  await client.session.create({
    title: "spike-07-multistep",
    model: MODEL,
    location: { directory: SANDBOX_WORKDIR },
  })
).id;
const collector = collectEvents(
  (e) => (e.data?.sessionID ?? e.data?.form?.sessionID) === sessionID,
);
await sleep(300);

const receipt = await rawPrompt(sessionID, {
  text: "Create a file named notes.txt containing exactly the word hello, then confirm in chat that you are done.",
});

// Wait for a final text step to complete (up to 4 min — free model can be slow).
let messages;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  const res = await rawCall(`/api/session/${sessionID}/message`);
  messages = res.body?.data ?? [];
  const finalText = messages.find(
    (m) =>
      m.type === "assistant" &&
      m.finish === "stop" &&
      m.content?.some((c) => c.type === "text" && c.text),
  );
  if (finalText) {
    await sleep(2000);
    break;
  }
}
collector.stop();

const results = {
  receipt,
  steps: collector.events
    .filter(
      (e) =>
        e.type === "session.next.step.started" ||
        e.type === "session.next.step.ended",
    )
    .map((e) => ({
      t: e.type,
      assistantMessageID: e.data.assistantMessageID,
      finish: e.data.finish,
      tokens: e.data.tokens,
      cost: e.data.cost,
    })),
  toolEvents: collector.events
    .filter((e) => e.type.startsWith("session.next.tool."))
    .map((e) => ({
      t: e.type,
      id: e.data.id ?? e.data.toolID ?? e.data.callID,
      name: e.data.name ?? e.data.tool,
      executed: e.data.executed,
      keys: Object.keys(e.data),
    })),
  usageEvents: collector.events
    .filter((e) => e.type.includes("usage"))
    .map((e) => ({ t: e.type, data: e.data })),
  allEventTypes: collector.events.map((e) => e.type),
  assistantMessages: (messages ?? [])
    .filter((m) => m.type === "assistant")
    .map((m) => ({
      id: m.id,
      finish: m.finish,
      tokens: m.tokens,
      cost: m.cost,
      contentTypes: m.content?.map((c) => c.type),
    })),
  sessionAfter: await capture("session.get", () =>
    client.session.get({ sessionID }),
  ),
};

saveArtifact("07-multistep-usage", results);
console.log("steps:", JSON.stringify(results.steps, null, 1).slice(0, 1500));
console.log(
  "assistants:",
  JSON.stringify(results.assistantMessages, null, 1).slice(0, 1200),
);
console.log(
  "session tokens:",
  JSON.stringify(results.sessionAfter.value?.tokens),
);
