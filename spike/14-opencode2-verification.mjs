// Stage-9 re-verification against the PUBLISHED `opencode2` binary.
//
// Every behavioural default this provider ships was previously established
// against either the mismatched dev CLI (`opencode-ai`, a different wire
// contract) or a from-source build of the beta branch. `@opencode-ai/cli@
// 0.0.0-beta-18286` is the published build of the pinned
// `@opencode-ai/client@0.0.0-beta-18286`, so it is the artifact real users
// will run. This script re-runs the load-bearing checks against it:
//
//   V1 health/version pairing (binary == pinned client build)
//   V2 prompt round-trip + correlation ids (receipt.id == stored user id)
//   V3 delivery default in the receipt (provider sends "queue" explicitly)
//   V4 session.wait on an idle and on a busy session
//   V5 busy semantics: omitted delivery (steer) vs explicit queue
//   V6 file ingestion: data: and file: URIs
//   V7 migration.v1.status
//   V8 session.log catch-up
//
// Server: see spike/14b-instruction-entries.mjs for the isolated-launch
// recipe. Run:
//   OC2_URL=http://127.0.0.1:14396 OC2_PASSWORD=<pw> \
//     OC2_WORKDIR=/tmp/oc2-verify/workdir \
//     node spike/14-opencode2-verification.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode-ai/client";
import { saveArtifact, capture, sleep } from "./lib.mjs";

const BASE_URL = process.env.OC2_URL;
const PASSWORD = process.env.OC2_PASSWORD;
const WORKDIR = process.env.OC2_WORKDIR;
if (!BASE_URL || !PASSWORD || !WORKDIR) {
  console.error("OC2_URL, OC2_PASSWORD, OC2_WORKDIR required");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");
const client = OpenCode.make({
  baseUrl: BASE_URL,
  headers: { Authorization: AUTH },
});

const MODEL = { providerID: "opencode", id: "nemotron-3.5-lightning-free" };
// V6 needs a model that actually accepts image input. The default model is
// text-only (`capabilities.input: ["text"]`), and a text-only model answers
// "I cannot view images" for EVERY scheme — which looks like a uniform
// failure and tells you nothing about ingestion.
const FILE_MODEL = {
  providerID: "opencode",
  id: "muse-spark-1.2-contributor-free",
};
const out = { capturedAt: new Date().toISOString(), baseUrl: BASE_URL };

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

async function waitFor(events, predicate, timeoutMs = 90_000) {
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

// ---- V1: provenance — the binary IS the pinned client's build ------------
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const read = (path) =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"),
    ).version;
  const health = await capture("health", () => client.health.get());
  const server = await capture("server-get", () => client.server.get());
  const clientVersion = read(
    "../node_modules/@opencode-ai/client/package.json",
  );
  const cliVersion = read("../node_modules/@opencode-ai/cli/package.json");
  out.v1Provenance = {
    health,
    server,
    pinnedClientVersion: clientVersion,
    installedCliVersion: cliVersion,
    serverVersion: health.value?.version,
    // The whole point: one build number across binary, client and server.
    allThreeMatch:
      clientVersion === cliVersion && cliVersion === health.value?.version,
  };
}

// ---- V2/V3: prompt round-trip, correlation ids, delivery default --------
{
  const session = await newSession("v2-simple-turn");
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
  out.v2SimpleTurn = {
    deliveryDefaultInReceipt: receipt.delivery,
    receipt,
    terminalSeen: succeeded?.type,
    eventSequence: mine.events.map((e) => e.type),
    events: mine.events.map(strip),
    storedMessages: messages.data,
    userMessageIdEqualsReceiptId: messages.data.some(
      (m) => m.type === "user" && m.id === receipt.id,
    ),
    executionEventsCarryInboxID: mine.events
      .filter((e) => e.type.startsWith("session.execution."))
      .map((e) => ({ type: e.type, inboxID: e.data?.inboxID })),
  };
}

// ---- V4: session.wait on idle, then on busy ------------------------------
{
  const session = await newSession("v4-wait");
  out.v4WaitIdle = await capture("wait-on-idle-session", () =>
    Promise.race([
      client.session.wait({ sessionID: session.id }).then(() => "resolved"),
      sleep(8000).then(() => "timeout-8s"),
    ]),
  );
  const mine = collect((e) => e?.data?.sessionID === session.id);
  await sleep(300);
  await client.session.prompt({
    sessionID: session.id,
    text: "Write a story about a lighthouse in about 150 words.",
  });
  const started = await waitFor(
    mine.events,
    (e) => e.type === "session.execution.started",
    45_000,
  );
  const startedAt = Date.now();
  out.v4WaitBusy = await capture("wait-on-busy-session", () =>
    Promise.race([
      client.session
        .wait({ sessionID: session.id })
        .then(() => `resolved after ${Date.now() - startedAt}ms`),
      sleep(120_000).then(() => "timeout-120s"),
    ]),
  );
  const waitResolvedAt = Date.now();
  const succeeded = await waitFor(
    mine.events,
    (e) => e.type === "session.execution.succeeded",
    120_000,
  );
  mine.stop();
  await mine.done;
  out.v4WaitBusy.executionStartedBeforeWaitCall = started !== undefined;
  out.v4WaitBusy.waitResolvedDeltaMs = waitResolvedAt - startedAt;
  out.v4WaitBusy.executionSucceededDeltaMs =
    succeeded === undefined ? undefined : succeeded.receivedAt - startedAt;
  out.v4WaitBusy.waitResolvedBeforeExecutionSucceeded =
    succeeded === undefined ? undefined : waitResolvedAt < succeeded.receivedAt;
  out.v4WaitBusy.eventSequence = mine.events.map((e) => e.type);
}

// ---- V5: busy semantics — omitted delivery (steer) vs explicit queue -----
{
  const session = await newSession("v5-busy");
  const mine = collect((e) => e?.data?.sessionID === session.id);
  await sleep(300);
  const first = await client.session.prompt({
    sessionID: session.id,
    text: "Write a story about a lighthouse in about 150 words.",
  });
  await waitFor(mine.events, (e) => e.type === "session.step.started");
  await waitFor(mine.events, (e) => e.type === "session.text.delta", 45_000);
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
  const deadline = Date.now() + 150_000;
  for (;;) {
    const list = await client.message.list({
      sessionID: session.id,
      order: "asc",
    });
    const assistants = list.data.filter((m) => m.type === "assistant");
    const users = list.data.filter((m) => m.type === "user");
    const settled =
      users.length >= 3 &&
      assistants.length >= 2 &&
      assistants.every((m) => m.finish !== undefined);
    if (settled || Date.now() > deadline) {
      out.v5Busy = {
        firstReceipt: first,
        whileBusyOmitted,
        queued,
        timedOut: !settled,
        eventSequence: mine.events.map((e) => e.type),
        executionEvents: mine.events
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
    await sleep(1000);
  }
  mine.stop();
  await mine.done;
}

// ---- V6: file ingestion — data: and file: URIs ---------------------------
// 64x64 solid-red PNG (stage-0 Q1: 8x8 gets misread; 64x64 is reliable).
{
  const RED_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
  const redPngPath = join(WORKDIR, "red-square.png");
  writeFileSync(redPngPath, Buffer.from(RED_PNG_BASE64, "base64"));

  // Record the probe model's declared input capabilities alongside the
  // results, so the artifact carries its own validity evidence.
  // model.list returns {location, data}, not a bare array.
  const catalog = await capture("model-list", () => client.model.list());
  const fileModelEntry = (catalog.value?.data ?? []).find(
    (entry) => entry.id === FILE_MODEL.id,
  );

  const tryUri = async (label, uri) => {
    const session = await client.session.create({
      title: `v6-uri-${label}`,
      location: { directory: WORKDIR },
      model: FILE_MODEL,
    });
    let receipt;
    try {
      receipt = await client.session.prompt({
        sessionID: session.id,
        text: "What single color dominates this image? One word.",
        files: [{ uri, name: "red-square.png" }],
      });
    } catch (error) {
      return {
        label,
        uri: uri.slice(0, 80),
        promptRejected: true,
        error: { reason: error.reason, message: error.message },
      };
    }
    const deadline = Date.now() + 90_000;
    for (;;) {
      const list = await client.message.list({
        sessionID: session.id,
        order: "asc",
      });
      const assistants = list.data.filter((m) => m.type === "assistant");
      if (
        assistants.length > 0 &&
        assistants.every((m) => m.finish !== undefined)
      ) {
        const user = list.data.find((m) => m.type === "user");
        return {
          label,
          uri: uri.slice(0, 80),
          promptRejected: false,
          receiptFiles: receipt.payload?.files,
          storedUserParts: user?.parts?.map((p) => p.type) ?? undefined,
          answers: assistants.map((m) => ({
            finish: m.finish,
            error: m.error,
            text: m.content
              ?.filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("")
              .slice(0, 200),
          })),
        };
      }
      if (Date.now() > deadline) {
        return { label, uri: uri.slice(0, 80), timedOut: true };
      }
      await sleep(1000);
    }
  };

  out.v6Files = {
    probeModel: FILE_MODEL,
    probeModelInputs: fileModelEntry?.capabilities?.input,
    probeModelAcceptsImages:
      fileModelEntry?.capabilities?.input?.includes("image") === true,
    dataUri: await tryUri("data", `data:image/png;base64,${RED_PNG_BASE64}`),
    fileUri: await tryUri("file", `file://${redPngPath}`),
    bareAbsolutePath: await tryUri("bare-path", redPngPath),
  };
}

// ---- V7: migration status ------------------------------------------------
out.v7Migration = await capture("migration-v1-status", () =>
  client.migration.v1.status(),
);

// ---- V8: session.log catch-up -------------------------------------------
{
  const session = await newSession("v8-log");
  await client.session.prompt({
    sessionID: session.id,
    text: "Reply with exactly: LOGGED",
  });
  await sleep(20_000);
  out.v8SessionLog = await capture("session-log-catchup", async () => {
    const items = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      for await (const item of client.session.log(
        { sessionID: session.id, after: 0 },
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

saveArtifact("14-opencode2-verification", out);
console.log(
  JSON.stringify(
    {
      serverVersion: out.v1Provenance?.serverVersion,
      allThreeMatch: out.v1Provenance?.allThreeMatch,
      deliveryDefault: out.v2SimpleTurn?.deliveryDefaultInReceipt,
      userMessageIdEqualsReceiptId:
        out.v2SimpleTurn?.userMessageIdEqualsReceiptId,
      waitIdle: out.v4WaitIdle?.value ?? out.v4WaitIdle?.error?.message,
      waitBusy: out.v4WaitBusy?.value ?? out.v4WaitBusy?.error?.message,
      waitBeforeSucceeded: out.v4WaitBusy?.waitResolvedBeforeExecutionSucceeded,
      busyOmittedOk: out.v5Busy?.whileBusyOmitted?.ok,
      busyOmittedDelivery: out.v5Busy?.whileBusyOmitted?.value?.delivery,
      busyQueueOk: out.v5Busy?.queued?.ok,
      busyTimedOut: out.v5Busy?.timedOut,
      fileProbeModelAcceptsImages: out.v6Files?.probeModelAcceptsImages,
      fileDataUri: out.v6Files?.dataUri?.answers?.[0]?.text,
      fileFileUri: out.v6Files?.fileUri?.answers?.[0]?.text,
      fileFileUriRejected: out.v6Files?.fileUri?.promptRejected,
      fileBarePathRejected: out.v6Files?.bareAbsolutePath?.promptRejected,
      migration: out.v7Migration?.value,
      sessionLogCount: out.v8SessionLog?.value?.count,
    },
    null,
    2,
  ),
);
