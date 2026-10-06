// Q1 follow-up controls (review findings): the original 05 run left three gaps.
//  a) The data: "success" answered "White" for a red PNG — request completion
//     was proven, correct model-side ingestion was not. Controls here: a larger
//     unambiguous 64x64 red PNG, plus a no-attachment baseline on the same
//     model/prompt to separate "sees the image" from hallucination.
//  b) All non-data failures came from one model (muse-spark, whose zen route is
//     an OpenAI-Responses adapter). Re-run data:/file: against a second active
//     image-capable free model (mimo-v2.5-free) to scope adapter-specificity.
//  c) Every uri AND name ended in .png, so "MIME is inferred from the file
//     name" was untested. Conflict cases below separate name- vs uri-derived
//     MIME on the stored message.
import {
  capture,
  saveArtifact,
  sleep,
  rawPrompt,
  rawCall,
  client,
  SANDBOX_WORKDIR,
} from "./lib.mjs";

// 8x8 red PNG (same as 05) and a 64x64 solid red PNG.
const B64_SMALL =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const B64_BIG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

const MUSE = { id: "muse-spark-1.2-contributor-free", providerID: "opencode" };
const MIMO = { id: "mimo-v2.5-free", providerID: "opencode" };

const CASES = [
  // (a) ingestion controls, muse
  {
    key: "muse-no-attachment-baseline",
    model: MUSE,
    files: undefined,
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
  {
    key: "muse-data-uri-64px",
    model: MUSE,
    files: [
      { uri: `data:image/png;base64,${B64_BIG}`, name: "red-square-64.png" },
    ],
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
  // (b) second adapter
  {
    key: "mimo-data-uri-64px",
    model: MIMO,
    files: [
      { uri: `data:image/png;base64,${B64_BIG}`, name: "red-square-64.png" },
    ],
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
  {
    key: "mimo-file-uri",
    model: MIMO,
    files: [
      {
        uri: `file://${SANDBOX_WORKDIR}/red-square.png`,
        name: "red-square.png",
      },
    ],
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
  // (c) MIME provenance: name says .png, uri declares octet-stream — whichever
  // wins in the stored message is the inference source.
  {
    key: "mime-uri-octet-name-png",
    model: MUSE,
    files: [
      {
        uri: `data:application/octet-stream;base64,${B64_SMALL}`,
        name: "red-square.png",
      },
    ],
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
  {
    key: "mime-uri-png-name-jpg",
    model: MUSE,
    files: [
      { uri: `data:image/png;base64,${B64_SMALL}`, name: "red-square.jpg" },
    ],
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
  {
    key: "mime-uri-png-name-noext",
    model: MUSE,
    files: [
      { uri: `data:image/png;base64,${B64_SMALL}`, name: "attachment" },
    ],
    text: "What is the dominant color of the attached image? Answer with one word.",
  },
];

const results = {};
for (const testCase of CASES) {
  const out = {};
  out.session = await capture("session.create", () =>
    client.session.create({
      title: `spike-05b-${testCase.key}`,
      model: testCase.model,
      location: { directory: SANDBOX_WORKDIR },
    }),
  );
  const sessionID = out.session.value?.id;
  out.receipt = await capture("prompt", () =>
    rawPrompt(sessionID, {
      text: testCase.text,
      ...(testCase.files ? { files: testCase.files } : {}),
    }),
  );
  if (out.receipt.ok) {
    for (let i = 0; i < 60; i++) {
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
    }
    if (!out.assistant) out.timeout = true;
  }
  results[testCase.key] = { model: testCase.model, files: testCase.files, ...out };
  const text = out.assistant?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ");
  console.log(
    testCase.key,
    out.receipt?.ok ? "accepted" : "REJECTED",
    out.assistant
      ? (out.assistant.error
          ? `ERROR ${JSON.stringify(out.assistant.error).slice(0, 120)}`
          : `-> ${JSON.stringify(text).slice(0, 80)}`) +
          ` storedMime=${out.userMessage?.files?.[0]?.mime}`
      : out.timeout
        ? "TIMEOUT"
        : "",
  );
}

saveArtifact("05b-file-uris-controls", results);
