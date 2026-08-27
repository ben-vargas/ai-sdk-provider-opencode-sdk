// Stage-9 verification of session instruction entries — the mechanism that
// decides whether the provider can ship real system-prompt support instead of
// the delimited-prepend degradation.
//
// Server: the PUBLISHED `@opencode-ai/cli@0.0.0-beta-18286` binary
// (`opencode2`), which is the exact build of the pinned
// `@opencode-ai/client@0.0.0-beta-18286`. Start it isolated:
//   SB=/tmp/oc2-verify
//   mkdir -p $SB/{home,data/opencode,state,config,cache,workdir}
//   cp ~/.local/share/opencode/auth.json $SB/data/opencode/    # zen creds
//   cd $SB/workdir && env -i PATH="$PATH" HOME=$SB/home \
//     OPENCODE_TEST_HOME=$SB/home TMPDIR=/tmp \
//     XDG_DATA_HOME=$SB/data XDG_STATE_HOME=$SB/state \
//     XDG_CONFIG_HOME=$SB/config XDG_CACHE_HOME=$SB/cache \
//     OPENCODE_PASSWORD=<pw> \
//     ./node_modules/.bin/opencode2 serve --port 14396
// Run:
//   OC2_URL=http://127.0.0.1:14396 OC2_PASSWORD=<pw> \
//     OC2_WORKDIR=/tmp/oc2-verify/workdir \
//     node spike/14b-instruction-entries.mjs
//
// Questions (from the stage-9 brief, deliverable 3):
//   E1 put/list/remove round-trip and observable shape
//   E2 does the model actually SEE the entry (repeat-the-secret probe)
//   E3 does it survive across turns in the same session
//   E4 does a later put take effect mid-session (announce at step boundary)
//   E5 does remove actually stop the instruction taking effect
//   E6 key-regex and 8 KiB value-cap enforcement (error shape)
//   E7 precedence vs the agent's own system prompt
//   E8 does the entry render as a system message visible in session.context
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
const out = { capturedAt: new Date().toISOString(), baseUrl: BASE_URL };
out.health = await capture("health", () => client.health.get());

async function newSession(title) {
  return client.session.create({
    title,
    location: { directory: WORKDIR },
    model: MODEL,
  });
}

const assistantText = (message) =>
  (message.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

/**
 * Prompt and return the text of the assistant turn THIS call produces.
 *
 * The baseline count is taken before the prompt and the poll waits for a
 * *new* completed assistant — reading "the last completed assistant" would
 * return the previous turn's answer on turn 2+ and silently fake a
 * cross-turn survival result.
 */
async function ask(sessionID, text) {
  const before = await client.message.list({ sessionID, order: "asc" });
  const baseline = before.data.filter((m) => m.type === "assistant").length;
  await client.session.prompt({ sessionID, text });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const list = await client.message.list({ sessionID, order: "asc" });
    const assistants = list.data.filter((m) => m.type === "assistant");
    const done = assistants.filter((m) => m.finish !== undefined);
    if (done.length > baseline && done.length === assistants.length) {
      const last = done[done.length - 1];
      const error = last.error;
      return error === undefined
        ? assistantText(last)
        : `<error:${JSON.stringify(error).slice(0, 300)}>`;
    }
    if (Date.now() > deadline) return "<timeout>";
    await sleep(1000);
  }
}

/**
 * `ask`, but a timed-out turn is retried once. Decisive probes must not
 * report a regex miss over the literal string "<timeout>" as evidence that
 * an instruction was absent — that is a false negative, not a result.
 */
async function askOrRetry(sessionID, text) {
  const first = await ask(sessionID, text);
  if (first !== "<timeout>") return first;
  return ask(sessionID, text);
}

// ---- E1: put / list / remove round-trip ----------------------------------
{
  const session = await newSession("entry-roundtrip");
  const put = await capture("entry-put", () =>
    client.session.instructions.entry.put({
      sessionID: session.id,
      key: "ai-sdk.system",
      value: "Always end every reply with the word BANANA.",
    }),
  );
  const afterPut = await capture("entry-list-after-put", () =>
    client.session.instructions.entry.list({ sessionID: session.id }),
  );
  const remove = await capture("entry-remove", () =>
    client.session.instructions.entry.remove({
      sessionID: session.id,
      key: "ai-sdk.system",
    }),
  );
  const afterRemove = await capture("entry-list-after-remove", () =>
    client.session.instructions.entry.list({ sessionID: session.id }),
  );
  out.e1RoundTrip = { put, afterPut, remove, afterRemove };
}

// ---- E2/E3/E8: the model sees the entry, and it persists across turns -----
{
  const session = await newSession("entry-visible");
  await client.session.instructions.entry.put({
    sessionID: session.id,
    key: "ai-sdk.system",
    value:
      "Your secret codeword is ZEPHYR-77. Whenever the user asks for the " +
      "codeword, reply with exactly that codeword and nothing else.",
  });
  const turn1 = await ask(session.id, "What is the codeword?");
  const turn2 = await ask(session.id, "Repeat the codeword one more time.");
  const context = await capture("session-context", () =>
    client.session.context({ sessionID: session.id }),
  );
  out.e2Visible = {
    turn1,
    turn2,
    turn1SawEntry: /ZEPHYR-77/i.test(turn1),
    turn2SawEntry: /ZEPHYR-77/i.test(turn2),
    // E8: how does the entry render into the model-visible context?
    contextMessageTypes: context.ok
      ? context.value.map((m) => m.type)
      : undefined,
    systemMessages: context.ok
      ? context.value
          .filter((m) => m.type === "system")
          .map((m) => JSON.stringify(m).slice(0, 4000))
      : undefined,
    contextError: context.ok ? undefined : context.error,
  };
}

// ---- E4: a put made MID-SESSION takes effect on the next turn ------------
// This is also the clean proof that the entry is re-rendered every turn
// rather than merely captured at session creation: turn 1 runs with no
// entry, the entry lands between turns, turn 2 must obey it.
{
  const session = await newSession("entry-mid-session-put");
  const before = await askOrRetry(
    session.id,
    "What is the codeword? Answer briefly.",
  );
  await client.session.instructions.entry.put({
    sessionID: session.id,
    key: "ai-sdk.system",
    value:
      "Your secret codeword is ORCHID-42. Whenever the user asks for the " +
      "codeword, reply with exactly that codeword and nothing else.",
  });
  const afterPut = await askOrRetry(session.id, "What is the codeword?");
  const messages = await client.message.list({
    sessionID: session.id,
    order: "asc",
  });
  out.e4MidSessionPut = {
    beforePut: before,
    beforePutSawEntry: /ORCHID-42/i.test(before),
    afterPut,
    afterPutSawEntry: /ORCHID-42/i.test(afterPut),
    // Does the put announce itself as a durable system message?
    messageTypes: messages.data.map((m) => m.type),
    systemMessages: messages.data
      .filter((m) => m.type === "system")
      .map((m) => JSON.stringify(m).slice(0, 2000)),
  };
}

// ---- E5: remove BEFORE any exposure — no transcript confound -------------
// The entry is put and removed before the session has ever been prompted,
// so the model cannot have seen the codeword in the conversation history.
// If it still answers with the codeword, `remove` does not work.
{
  const session = await newSession("entry-remove-clean");
  await client.session.instructions.entry.put({
    sessionID: session.id,
    key: "ai-sdk.system",
    value:
      "Your secret codeword is TUNDRA-19. Whenever the user asks for the " +
      "codeword, reply with exactly that codeword and nothing else.",
  });
  await client.session.instructions.entry.remove({
    sessionID: session.id,
    key: "ai-sdk.system",
  });
  const reply = await askOrRetry(
    session.id,
    "What is the codeword? Answer briefly.",
  );
  out.e5RemoveClean = {
    reply: reply.slice(0, 600),
    // Only a real answer can settle this; a timeout is "no result", not
    // "the instruction was gone".
    conclusive: reply !== "<timeout>" && !reply.startsWith("<error:"),
    stillSawEntry: /TUNDRA-19/i.test(reply),
    entries: await capture("list-after-clean-remove", () =>
      client.session.instructions.entry.list({ sessionID: session.id }),
    ),
  };
}

// ---- E5b: remove AFTER the value already appeared in the transcript ------
// Weaker by construction: the model can parrot the codeword from history
// even with the entry gone, so a positive hit here is NOT evidence that
// `remove` failed. Recorded for completeness.
{
  const session = await newSession("entry-remove-after-exposure");
  await client.session.instructions.entry.put({
    sessionID: session.id,
    key: "ai-sdk.system",
    value: "You must begin every single reply with the token QQQ.",
  });
  const withEntry = await ask(session.id, "Say hello.");
  await client.session.instructions.entry.remove({
    sessionID: session.id,
    key: "ai-sdk.system",
  });
  const afterRemove = await ask(session.id, "Say goodbye.");
  out.e5bRemoveAfterExposure = {
    withEntry: withEntry.slice(0, 300),
    withEntryObeyed: /^QQQ/i.test(withEntry),
    afterRemove: afterRemove.slice(0, 300),
    afterRemoveStillObeyed: /^QQQ/i.test(afterRemove),
    confound:
      "the transcript still shows the QQQ-prefixed turn, so continued " +
      "obedience is explainable by history alone",
  };
}

// ---- E6: key regex + value size cap --------------------------------------
{
  const session = await newSession("entry-limits");
  const badKeys = ["ai-sdk.System", "_leading", ".dot", "", "AI-SDK"];
  out.e6Keys = {};
  for (const key of badKeys) {
    out.e6Keys[JSON.stringify(key)] = await capture(`key-${key}`, () =>
      client.session.instructions.entry.put({
        sessionID: session.id,
        key,
        value: "x",
      }),
    );
  }
  out.e6GoodKeys = {};
  for (const key of ["ai-sdk.system", "a", "a1._-x"]) {
    out.e6GoodKeys[key] = await capture(`good-key-${key}`, () =>
      client.session.instructions.entry.put({
        sessionID: session.id,
        key,
        value: "x",
      }),
    );
  }
  // Is the cap measured on the raw string or on its JSON encoding? A plain
  // string costs 2 extra bytes as JSON (the quotes), so 8192 raw chars is
  // 8194 encoded. Bracket the boundary to find out which one the server
  // counts — the provider's budget check has to match it exactly.
  out.e6Size = {};
  for (const raw of [8189, 8190, 8191, 8192]) {
    out.e6Size[`raw${raw}`] = await capture(`value-raw-${raw}`, () =>
      client.session.instructions.entry.put({
        sessionID: session.id,
        key: "ai-sdk.size",
        value: "y".repeat(raw),
      }),
    );
  }
  // Multi-byte characters: is the cap bytes or code units?
  out.e6SizeMultibyte = await capture("value-multibyte", () =>
    client.session.instructions.entry.put({
      sessionID: session.id,
      key: "ai-sdk.size",
      // 4095 x 2-byte chars = 8190 UTF-8 bytes + 2 quotes = 8192 encoded.
      value: "é".repeat(4095),
    }),
  );
  // Non-string JsonValue: does the server accept objects/numbers?
  out.e6NonString = await capture("value-object", () =>
    client.session.instructions.entry.put({
      sessionID: session.id,
      key: "ai-sdk.object",
      value: { a: 1 },
    }),
  );
}

// ---- E7: precedence vs the agent's own system prompt ---------------------
// The entry claims to join the epoch baseline AFTER the agent's system
// prompt. Probe with an instruction that contradicts default agent behaviour
// in an observable, harmless way.
{
  const session = await newSession("entry-precedence");
  await client.session.instructions.entry.put({
    sessionID: session.id,
    key: "ai-sdk.system",
    value:
      "Formatting override: you must answer EVERY user message with a " +
      "single line of the form `ANSWER: <text>` and never use markdown " +
      "headings, lists, or code fences.",
  });
  const reply = await ask(
    session.id,
    "Give me three tips for naming variables.",
  );
  out.e7Precedence = {
    reply: reply.slice(0, 1200),
    followedOverride: /^ANSWER:/i.test(reply),
    usedMarkdownList: /^\s*[-*\d]+[.)]?\s/m.test(reply),
  };
}

// ---- E9: does an entry on a NON-EXISTENT session fail cleanly? -----------
out.e9UnknownSession = await capture("put-unknown-session", () =>
  client.session.instructions.entry.put({
    sessionID: "ses_definitely_not_real",
    key: "ai-sdk.system",
    value: "x",
  }),
);

saveArtifact("14b-instruction-entries", out);
console.log(
  JSON.stringify(
    {
      health: out.health?.value,
      e1PutOk: out.e1RoundTrip?.put?.ok,
      e1AfterPut: out.e1RoundTrip?.afterPut?.value,
      e1AfterRemove: out.e1RoundTrip?.afterRemove?.value,
      e2Turn1SawEntry: out.e2Visible?.turn1SawEntry,
      e3Turn2SawEntry: out.e2Visible?.turn2SawEntry,
      e4BeforePutSawEntry: out.e4MidSessionPut?.beforePutSawEntry,
      e4AfterPutSawEntry: out.e4MidSessionPut?.afterPutSawEntry,
      e4SystemMessages: out.e4MidSessionPut?.systemMessages?.length,
      e5RemoveCleanConclusive: out.e5RemoveClean?.conclusive,
      e5RemoveCleanStillSawEntry: out.e5RemoveClean?.stillSawEntry,
      e5bWithEntryObeyed: out.e5bRemoveAfterExposure?.withEntryObeyed,
      e5bAfterRemoveStillObeyed:
        out.e5bRemoveAfterExposure?.afterRemoveStillObeyed,
      e6BadKeyOk: Object.fromEntries(
        Object.entries(out.e6Keys ?? {}).map(([k, v]) => [k, v.ok]),
      ),
      e6GoodKeyOk: Object.fromEntries(
        Object.entries(out.e6GoodKeys ?? {}).map(([k, v]) => [k, v.ok]),
      ),
      e6Size: Object.fromEntries(
        Object.entries(out.e6Size ?? {}).map(([k, v]) => [
          k,
          v.ok ? "ok" : (v.error?.actualBytes ?? v.error?.message),
        ]),
      ),
      e6SizeMultibyteOk: out.e6SizeMultibyte?.ok,
      e6SizeMultibyteBytes: out.e6SizeMultibyte?.error?.actualBytes,
      e6NonStringOk: out.e6NonString?.ok,
      e7FollowedOverride: out.e7Precedence?.followedOverride,
      e9UnknownSessionOk: out.e9UnknownSession?.ok,
      e9UnknownSessionError: out.e9UnknownSession?.error?.message,
    },
    null,
    2,
  ),
);
