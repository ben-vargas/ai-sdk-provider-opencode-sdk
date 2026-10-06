// Q3 remainder: interrupt {continue:false} mid-stream, then prompt resume:true;
// also interrupt {continue:true} semantics.
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

async function newFlowingSession(title, text) {
  const sessionID = (
    await client.session.create({
      title,
      model: MODEL,
      location: { directory: SANDBOX_WORKDIR },
    })
  ).id;
  const collector = collectEvents(
    (e) => (e.data?.sessionID ?? e.data?.form?.sessionID) === sessionID,
  );
  await sleep(300);
  const receipt = await rawPrompt(sessionID, { text });
  let flowing = false;
  for (let i = 0; i < 240 && !flowing; i++) {
    await sleep(500);
    flowing =
      collector.events.filter((e) => e.type === "session.next.text.delta")
        .length >= 3;
  }
  return { sessionID, collector, receipt, flowing };
}

const PROMPT =
  "Explain the water cycle in about 400 words. Output plain chat text only; do NOT use any tools.";

// --- Case A: interrupt {continue: false} mid-stream, then resume: true.
{
  const { sessionID, collector, flowing } = await newFlowingSession(
    "spike-08-interrupt",
    PROMPT,
  );
  results.interruptFlowing = flowing;
  results.interrupt = await capture("interrupt", () =>
    rawCall(`/api/session/${sessionID}/interrupt`, {
      method: "POST",
      body: { continue: false },
    }),
  );
  await sleep(3000);
  results.messagesAfterInterrupt = (
    await rawCall(`/api/session/${sessionID}/message`)
  ).body?.data?.map((m) => ({
    type: m.type,
    finish: m.finish,
    error: m.error,
    text: (
      m.text ??
      m.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
    )?.slice(0, 80),
  }));
  results.sessionAfterInterrupt = await capture("session.get", () =>
    client.session.get({ sessionID }),
  );

  // resume: true with empty-ish text (text is required).
  results.resumeReceipt = await capture("prompt-resume", () =>
    rawPrompt(sessionID, { text: "continue", resume: true }),
  );
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const msgs =
      (await rawCall(`/api/session/${sessionID}/message`)).body?.data ?? [];
    if (
      msgs.filter((m) => m.type === "assistant" && m.finish === "stop")
        .length >= 1
    )
      break;
  }
  await sleep(2000);
  collector.stop();
  results.messagesAfterResume = (
    await rawCall(`/api/session/${sessionID}/message`)
  ).body?.data?.map((m) => ({
    type: m.type,
    finish: m.finish,
    text: (
      m.text ??
      m.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
    )?.slice(0, 80),
  }));
  results.interruptEvents = collector.events
    .filter((e) => e.type !== "session.next.text.delta")
    .map((e) => ({
      t: e.type,
      finish: e.data?.finish,
      reason: e.data?.reason,
      keys: Object.keys(e.data ?? {}),
    }));
}

// --- Case B: interrupt {continue: true} mid-stream.
{
  const { sessionID, collector, flowing } = await newFlowingSession(
    "spike-08-interrupt-continue",
    PROMPT,
  );
  results.continueFlowing = flowing;
  results.interruptContinue = await capture("interrupt-continue", () =>
    rawCall(`/api/session/${sessionID}/interrupt`, {
      method: "POST",
      body: { continue: true },
    }),
  );
  await sleep(8000);
  collector.stop();
  results.continueEvents = collector.events
    .filter((e) => e.type !== "session.next.text.delta")
    .map((e) => ({
      t: e.type,
      finish: e.data?.finish,
      reason: e.data?.reason,
    }));
  results.messagesAfterContinue = (
    await rawCall(`/api/session/${sessionID}/message`)
  ).body?.data?.map((m) => ({
    type: m.type,
    finish: m.finish,
    text: (
      m.text ??
      m.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
    )?.slice(0, 80),
  }));
}

saveArtifact("08-interrupt-resume", results);
console.log(
  "interrupt response:",
  JSON.stringify(results.interrupt.value ?? results.interrupt.error?.message),
);
console.log("after interrupt:", JSON.stringify(results.messagesAfterInterrupt));
console.log(
  "resume receipt:",
  JSON.stringify(
    results.resumeReceipt.value ?? results.resumeReceipt.error?.body,
  ),
);
console.log(
  "interrupt-continue:",
  JSON.stringify(results.interruptContinue.value),
);
