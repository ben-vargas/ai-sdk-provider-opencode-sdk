// Q1: which files[].uri schemes does the prompt accept, and what does the
// model actually see? One session per scheme, image-capable free model.
// Dev-server raw contract (files live inside prompt: {text, files}).
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

const B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const CASES = [
  {
    key: "data-uri",
    uri: `data:image/png;base64,${B64}`,
    name: "red-square.png",
  },
  {
    key: "file-uri",
    uri: `file://${SANDBOX_WORKDIR}/red-square.png`,
    name: "red-square.png",
  },
  { key: "relative-path", uri: "red-square.png", name: "red-square.png" },
  {
    key: "absolute-path",
    uri: `${SANDBOX_WORKDIR}/red-square.png`,
    name: "red-square.png",
  },
  {
    key: "https-uri",
    uri: "https://opencode.ai/favicon-96x96-v3.png",
    name: "favicon.png",
  },
];

const results = {};
for (const testCase of CASES) {
  const out = {};
  out.session = await capture("session.create", () =>
    client.session.create({
      title: `spike-05-${testCase.key}`,
      model: { id: "muse-spark-1.2-contributor-free", providerID: "opencode" },
      location: { directory: SANDBOX_WORKDIR },
    }),
  );
  const sessionID = out.session.value?.id;
  out.receipt = await capture("prompt", () =>
    rawPrompt(sessionID, {
      text: "What is the dominant color of the attached image? Answer with one word.",
      files: [{ uri: testCase.uri, name: testCase.name }],
    }),
  );
  if (out.receipt.ok) {
    // Poll for completion.
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const res = await rawCall(`/api/session/${sessionID}/message`);
      const msgs = res.body?.data ?? [];
      const assistant = msgs.find(
        (m) => m.type === "assistant" && (m.finish || m.error),
      );
      if (assistant) {
        out.assistant = assistant;
        out.userMessage = msgs.find((m) => m.type === "user");
        break;
      }
      const failed = msgs.find((m) => m.type === "assistant" && m.error);
      if (failed) {
        out.assistant = failed;
        break;
      }
    }
    if (!out.assistant) out.timeout = true;
  }
  results[testCase.key] = { uri: testCase.uri, ...out };
  console.log(
    testCase.key,
    out.receipt?.ok
      ? "prompt-accepted"
      : `prompt-REJECTED ${JSON.stringify(out.receipt?.error?.body ?? "").slice(0, 150)}`,
    out.assistant
      ? `assistant: ${JSON.stringify(out.assistant.content?.filter((c) => c.type === "text").map((c) => c.text) ?? out.assistant.error).slice(0, 120)}`
      : out.timeout
        ? "TIMEOUT"
        : "",
  );
}

saveArtifact("05-file-uris", results);
