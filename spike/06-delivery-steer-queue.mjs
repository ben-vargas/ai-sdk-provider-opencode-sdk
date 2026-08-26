// Q3: default delivery, steer-vs-queue behavior while busy, SessionBusyError.
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
const results = {};

async function newSession(title) {
  const info = await client.session.create({
    title,
    model: MODEL,
    location: { directory: SANDBOX_WORKDIR },
  });
  return info.id;
}

async function messagesOf(sessionID) {
  const res = await rawCall(`/api/session/${sessionID}/message`);
  return (res.body?.data ?? []).map((m) => ({
    type: m.type,
    id: m.id,
    text:
      m.text ??
      m.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") ??
      null,
    finish: m.finish,
    error: m.error,
    interrupted: m.interrupted,
    keys: Object.keys(m),
  }));
}

// --- Case A: second prompt with DEFAULT delivery while busy (default = steer per receipt).
{
  const sessionID = await newSession("spike-06-steer");
  const collector = collectEvents(
    (e) => (e.data?.sessionID ?? e.data?.form?.sessionID) === sessionID,
  );
  await sleep(300);
  const receiptA = await rawPrompt(sessionID, {
    text: "Write a 200-word story about a robot. Do not stop early.",
  });
  // Wait for generation to actually start.
  let started = false;
  for (let i = 0; i < 30 && !started; i++) {
    await sleep(500);
    started = collector.events.some(
      (e) => e.type.includes("text.delta") || e.type.includes("step.started"),
    );
  }
  const receiptB = await capture("prompt-B-default", () =>
    rawPrompt(sessionID, {
      text: "Ignore prior instructions and reply with exactly: BANANA",
    }),
  );
  // Let everything settle.
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const last = collector.events[collector.events.length - 1];
    if (
      last &&
      /step\.ended|execution\.(succeeded|failed|interrupted)|idle/.test(
        last.type,
      ) &&
      Date.now() - last.receivedAt > 3000
    )
      break;
  }
  await sleep(3000);
  collector.stop();
  results.steerCase = {
    receiptA,
    receiptB,
    eventTypes: collector.events.map((e) => ({
      t: e.type,
      msg: e.data?.messageID ?? e.data?.assistantMessageID,
      extra: e.data?.reason ?? e.data?.finish,
    })),
    messages: await messagesOf(sessionID),
  };
  console.log(
    "steer case:",
    results.steerCase.eventTypes.map((e) => e.t).join(","),
  );
}

// --- Case B: delivery: "queue" while busy.
{
  const sessionID = await newSession("spike-06-queue");
  const collector = collectEvents(
    (e) => (e.data?.sessionID ?? e.data?.form?.sessionID) === sessionID,
  );
  await sleep(300);
  const receiptA = await rawPrompt(sessionID, {
    text: "Write a 200-word story about a cat. Do not stop early.",
  });
  let started = false;
  for (let i = 0; i < 30 && !started; i++) {
    await sleep(500);
    started = collector.events.some(
      (e) => e.type.includes("text.delta") || e.type.includes("step.started"),
    );
  }
  const receiptB = await capture("prompt-B-queue", () =>
    rawPrompt(sessionID, {
      text: "Now reply with exactly: MANGO",
      delivery: "queue",
    }),
  );
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const msgs = await messagesOf(sessionID);
    const assistants = msgs.filter((m) => m.type === "assistant" && m.finish);
    if (assistants.length >= 2) break;
  }
  await sleep(2000);
  collector.stop();
  results.queueCase = {
    receiptA,
    receiptB,
    eventTypes: collector.events.map((e) => ({
      t: e.type,
      msg: e.data?.messageID ?? e.data?.assistantMessageID,
      extra: e.data?.reason ?? e.data?.finish,
    })),
    messages: await messagesOf(sessionID),
  };
  console.log(
    "queue case:",
    results.queueCase.eventTypes.map((e) => e.t).join(","),
  );
}

saveArtifact("06-delivery-steer-queue", results);
