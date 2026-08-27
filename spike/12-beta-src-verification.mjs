// Stage-6 re-verification against the beta-branch server BUILT FROM SOURCE
// (the only server that speaks the pinned client's contract). Re-runs the
// spike experiments whose stage-0 answers came from the mismatched dev CLI.
//
// Server: start via the integration harness (or manually):
//   SBOX=~/.cache/opencode-beta-sandbox
//   cd $SBOX/workdir && env XDG_DATA_HOME=$SBOX/data XDG_STATE_HOME=$SBOX/state \
//     XDG_CONFIG_HOME=$SBOX/config XDG_CACHE_HOME=$SBOX/cache \
//     OPENCODE_PASSWORD=<pw> OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}' \
//     bun run --cwd ~/.cache/opencode-beta-src/packages/cli --conditions=browser \
//       src/index.ts serve --port 14196
// Run:
//   BETA_SRC_URL=http://127.0.0.1:14196 BETA_SRC_PASSWORD=<pw> \
//     BETA_SRC_WORKDIR=$HOME/.cache/opencode-beta-sandbox/workdir \
//     node spike/12-beta-src-verification.mjs
import { OpenCode } from "@opencode-ai/client";
import { saveArtifact, capture, sleep } from "./lib.mjs";

const BASE_URL = process.env.BETA_SRC_URL;
const PASSWORD = process.env.BETA_SRC_PASSWORD;
const WORKDIR = process.env.BETA_SRC_WORKDIR;
if (!BASE_URL || !PASSWORD || !WORKDIR) {
  console.error("BETA_SRC_URL, BETA_SRC_PASSWORD, BETA_SRC_WORKDIR required");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");
const client = OpenCode.make({
  baseUrl: BASE_URL,
  headers: { Authorization: AUTH },
});

const MODEL = { providerID: "opencode", id: "nemotron-3.5-lightning-free" };
const out = {};

function collect(filter) {
  const events = [];
  const controller = new AbortController();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  (async () => {
    try {
      for await (const event of client.event.subscribe({
        signal: controller.signal,
      })) {
        if (events.length === 0) resolveReady(event);
        if (!filter || filter(event))
          events.push({ receivedAt: Date.now(), ...event });
      }
      resolveDone("iterator-completed");
    } catch (error) {
      resolveReady(undefined);
      resolveDone(error);
    }
  })();
  return { events, ready, done, stop: () => controller.abort() };
}

async function newSession(title) {
  return client.session.create({
    title,
    location: { directory: WORKDIR },
    model: MODEL,
  });
}

async function waitFor(events, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await sleep(200);
  }
}

const strip = (event) => {
  const { receivedAt, ...rest } = event;
  void receivedAt;
  return rest;
};

// ---- exp0: server.connected handshake + replay check ---------------------
{
  const first = collect(() => true);
  const firstEvent = await Promise.race([first.ready, sleep(5000)]);
  out.serverConnected = {
    firstEventType: firstEvent?.type,
    note: "first event on a fresh subscription",
  };
  first.stop();
  await first.done;
}

// ---- exp1+exp2: delivery default + correlation on a simple turn ----------
{
  const session = await newSession("verify-simple-turn");
  const mine = collect((e) => e?.data?.sessionID === session.id);
  await sleep(300);
  const receipt = await client.session.prompt({
    sessionID: session.id,
    text: "Reply with exactly: OK",
  });
  const succeeded = await waitFor(
    mine.events,
    (e) => e.type === "session.execution.succeeded",
  );
  mine.stop();
  await mine.done;
  const messages = await client.message.list({
    sessionID: session.id,
    order: "asc",
  });
  out.simpleTurn = {
    deliveryDefaultInReceipt: receipt.delivery,
    receipt,
    terminalSeen: succeeded?.type,
    eventSequence: mine.events.map((e) => e.type),
    // correlation evidence: every event payload for the cycle, verbatim
    events: mine.events.map(strip),
    storedMessages: messages.data,
    userMessageIdEqualsReceiptId: messages.data.some(
      (m) => m.type === "user" && m.id === receipt.id,
    ),
  };
}

// ---- exp3: session.wait (idle, then busy) --------------------------------
{
  const session = await newSession("verify-wait");
  out.waitIdle = await capture("wait-on-idle-session", () =>
    Promise.race([
      client.session.wait({ sessionID: session.id }).then(() => "resolved"),
      sleep(8000).then(() => "timeout-8s"),
    ]),
  );
  const mine = collect((e) => e?.data?.sessionID === session.id);
  await sleep(300);
  await client.session.prompt({
    sessionID: session.id,
    text: "Reply with exactly: WAITED",
  });
  const startedAt = Date.now();
  out.waitBusy = await capture("wait-on-busy-session", () =>
    Promise.race([
      client.session
        .wait({ sessionID: session.id })
        .then(() => `resolved after ${Date.now() - startedAt}ms`),
      sleep(60_000).then(() => "timeout-60s"),
    ]),
  );
  const succeededAt = mine.events.find(
    (e) => e.type === "session.execution.succeeded",
  )?.receivedAt;
  out.waitBusy.executionSucceededDeltaMs =
    succeededAt === undefined ? undefined : succeededAt - startedAt;
  mine.stop();
  await mine.done;
}

// ---- exp4: busy semantics — omitted delivery + steer + queue -------------
{
  const session = await newSession("verify-busy");
  const mine = collect((e) => e?.data?.sessionID === session.id);
  await sleep(300);
  const first = await client.session.prompt({
    sessionID: session.id,
    text: "Write a story about a lighthouse in about 150 words.",
  });
  // Do not steer before the step starts (stage-0 stall caution).
  await waitFor(mine.events, (e) => e.type === "session.step.started");
  await waitFor(mine.events, (e) => e.type === "session.text.delta", 30_000);
  const whileBusyOmitted = await capture("prompt-busy-delivery-omitted", () =>
    client.session.prompt({
      sessionID: session.id,
      text: "Reply with exactly: STEERED",
    }),
  );
  const queued = await capture("prompt-busy-delivery-queue", () =>
    client.session.prompt({
      sessionID: session.id,
      text: "Reply with exactly: QUEUED",
      delivery: "queue",
    }),
  );
  // Let everything drain: story turn (or its steer-supersession), the
  // steered prompt, the queued prompt.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const list = await client.message.list({
      sessionID: session.id,
      order: "asc",
    });
    const assistants = list.data.filter((m) => m.type === "assistant");
    const users = list.data.filter((m) => m.type === "user");
    if (
      users.length >= 3 &&
      assistants.length >= 2 &&
      assistants.every((m) => m.finish !== undefined)
    ) {
      out.busy = {
        firstReceipt: first,
        whileBusyOmitted,
        queued,
        eventSequence: mine.events.map((e) => e.type),
        interruptedEvents: mine.events
          .filter((e) => e.type.startsWith("session.execution."))
          .map(strip),
        storedMessages: list.data.map((m) => ({
          id: m.id,
          type: m.type,
          finish: m.type === "assistant" ? m.finish : undefined,
          text:
            m.type === "user"
              ? m.text
              : m.content
                  ?.filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("")
                  .slice(0, 120),
        })),
      };
      break;
    }
    if (Date.now() > deadline) {
      out.busy = {
        firstReceipt: first,
        whileBusyOmitted,
        queued,
        timedOut: true,
        eventSequence: mine.events.map((e) => e.type),
        storedMessages: list.data,
      };
      break;
    }
    await sleep(1000);
  }
  mine.stop();
  await mine.done;
}

// ---- exp5: interrupt response body + terminal events ---------------------
{
  const session = await newSession("verify-interrupt");
  const mine = collect((e) => e?.data?.sessionID === session.id);
  await sleep(300);
  await client.session.prompt({
    sessionID: session.id,
    text: "Write a story about a lighthouse in about 150 words.",
  });
  await waitFor(mine.events, (e) => e.type === "session.text.delta", 45_000);
  out.interrupt = await capture("interrupt-continue-false", () =>
    client.session.interrupt({ sessionID: session.id, continue: false }),
  );
  const terminal = await waitFor(
    mine.events,
    (e) =>
      e.type === "session.execution.interrupted" ||
      e.type === "session.execution.failed" ||
      e.type === "session.execution.succeeded",
    20_000,
  );
  await sleep(1000);
  mine.stop();
  await mine.done;
  const messages = await client.message.list({
    sessionID: session.id,
    order: "asc",
  });
  out.interrupt.terminalEvent = terminal ? strip(terminal) : undefined;
  out.interrupt.eventSequence = mine.events.map((e) => e.type);
  out.interrupt.finalAssistant = messages.data
    .filter((m) => m.type === "assistant")
    .map((m) => ({ id: m.id, finish: m.finish, error: m.error }));
}

// ---- exp6: multi-step turn — approvals, message granularity, usage -------
{
  const session = await newSession("verify-multistep");
  const mine = collect(
    (e) =>
      e?.data?.sessionID === session.id || e.type?.startsWith("permission."),
  );
  await sleep(300);
  const replies = [];
  const replier = (async () => {
    const seen = new Set();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const asked = mine.events.find(
        (e) =>
          e.type === "permission.asked" &&
          e.data?.sessionID === session.id &&
          !seen.has(e.data?.id),
      );
      if (asked) {
        seen.add(asked.data.id);
        replies.push(
          await capture(`permission-reply-${asked.data.id}`, () =>
            client.permission.reply({
              sessionID: session.id,
              requestID: asked.data.id,
              reply: "once",
            }),
          ),
        );
      }
      if (
        mine.events.some(
          (e) =>
            e.type.startsWith("session.execution.") &&
            e.type !== "session.execution.started",
        )
      )
        break;
      await sleep(300);
    }
  })();
  await client.session.prompt({
    sessionID: session.id,
    text:
      "Use the bash tool to run exactly `printf beta-verify` and then tell " +
      "me its stdout. Do not answer without running the command.",
  });
  await replier;
  await sleep(1500);
  mine.stop();
  await mine.done;
  const messages = await client.message.list({
    sessionID: session.id,
    order: "asc",
  });
  const info = await client.session.get({ sessionID: session.id });
  out.multiStep = {
    permissionAsked: mine.events
      .filter((e) => e.type === "permission.asked")
      .map(strip),
    permissionReplies: replies,
    stepEnded: mine.events
      .filter((e) => e.type === "session.step.ended")
      .map(strip),
    usageEvents: mine.events
      .filter((e) => e.type.startsWith("session.usage."))
      .map(strip),
    eventSequence: mine.events.map((e) => e.type),
    assistantMessages: messages.data
      .filter((m) => m.type === "assistant")
      .map((m) => ({
        id: m.id,
        finish: m.finish,
        tokens: m.tokens,
        cost: m.cost,
        contentTypes: m.content?.map((p) => p.type),
      })),
    sessionInfoTokens: info.tokens,
    sessionInfoCost: info.cost,
  };
}

// ---- exp7: session.log catch-up ------------------------------------------
{
  const session = await newSession("verify-log");
  await client.session.prompt({
    sessionID: session.id,
    text: "Reply with exactly: LOGGED",
  });
  await sleep(15_000);
  out.sessionLog = await capture("session-log-catchup", async () => {
    const items = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      for await (const item of client.session.log(
        { sessionID: session.id },
        { signal: controller.signal },
      )) {
        items.push(item);
        if (items.length > 200) break;
      }
    } catch (error) {
      if (items.length === 0) throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      count: items.length,
      types: [...new Set(items.map((i) => i?.type))],
      first: items[0],
      last: items[items.length - 1],
    };
  });
}

// ---- exp8: migration status on this (non-fresh) sandbox ------------------
out.migration = await capture("migration-v1-status", () =>
  client.migration.v1.status(),
);

saveArtifact("12-beta-src-verification", out);
console.log(
  JSON.stringify(
    {
      serverConnected: out.serverConnected,
      deliveryDefault: out.simpleTurn?.deliveryDefaultInReceipt,
      userMessageIdEqualsReceiptId:
        out.simpleTurn?.userMessageIdEqualsReceiptId,
      waitIdle: out.waitIdle?.value ?? out.waitIdle?.error?.message,
      waitBusy: out.waitBusy?.value ?? out.waitBusy?.error?.message,
      busyOmittedOk: out.busy?.whileBusyOmitted?.ok,
      busyOmittedDelivery: out.busy?.whileBusyOmitted?.value?.delivery,
      busyQueueOk: out.busy?.queued?.ok,
      interrupt: out.interrupt?.value,
      interruptTerminal: out.interrupt?.terminalEvent?.type,
      multiStepAssistants: out.multiStep?.assistantMessages?.length,
      migration: out.migration?.value,
    },
    null,
    2,
  ),
);
