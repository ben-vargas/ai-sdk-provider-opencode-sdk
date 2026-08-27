// Stage-6 re-verification, part 2: file-URI schemes against the beta-source
// server (revisits stage-0 Q1, which ran on the dev CLI). Same env contract
// as 12-beta-src-verification.mjs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode-ai/client";
import { saveArtifact, sleep } from "./lib.mjs";

const BASE_URL = process.env.BETA_SRC_URL;
const PASSWORD = process.env.BETA_SRC_PASSWORD;
const WORKDIR = process.env.BETA_SRC_WORKDIR;
if (!BASE_URL || !PASSWORD || !WORKDIR) {
  console.error("BETA_SRC_URL, BETA_SRC_PASSWORD, BETA_SRC_WORKDIR required");
  process.exit(1);
}

const client = OpenCode.make({
  baseUrl: BASE_URL,
  headers: {
    Authorization:
      "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64"),
  },
});
const MODEL = { providerID: "opencode", id: "muse-spark-1.2-contributor-free" };

// 64x64 solid-red PNG (stage-0 Q1: 8x8 gets misread; 64x64 is reliable).
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
const redPngPath = join(WORKDIR, "red-square.png");
writeFileSync(redPngPath, Buffer.from(RED_PNG_BASE64, "base64"));

async function tryUri(label, uri, { expectAnswer = false } = {}) {
  const session = await client.session.create({
    title: `verify-uri-${label}`,
    location: { directory: WORKDIR },
    model: MODEL,
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
      uri,
      promptRejected: true,
      error: { reason: error.reason, message: error.message },
    };
  }
  if (!expectAnswer) {
    return {
      label,
      uri,
      promptRejected: false,
      receiptFiles: receipt.payload?.files,
    };
  }
  await sleep(25_000);
  const messages = await client.message.list({
    sessionID: session.id,
    order: "asc",
  });
  const user = messages.data.find((m) => m.type === "user");
  const answers = messages.data
    .filter((m) => m.type === "assistant")
    .map((m) => ({
      finish: m.finish,
      text: m.content
        ?.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
      error: m.error,
    }));
  return {
    label,
    uri,
    promptRejected: false,
    storedAttachment: user?.files?.map((f) => ({
      mime: f.mime,
      name: f.name,
      source: f.source,
      dataBytes: f.data?.length,
    })),
    answers,
  };
}

const out = {};
out.dataUri = await tryUri("data", `data:image/png;base64,${RED_PNG_BASE64}`, {
  expectAnswer: true,
});
out.fileUriReadable = await tryUri("file-readable", `file://${redPngPath}`, {
  expectAnswer: true,
});
out.fileUriMissing = await tryUri(
  "file-missing",
  "file:///tmp/does-not-exist-for-verify.png",
);
out.httpsUri = await tryUri(
  "https",
  "https://raw.githubusercontent.com/github/explore/main/topics/git/git.png",
);
out.relativePath = await tryUri("relative", "red-square.png");

saveArtifact("12b-beta-src-file-uris", out);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(out).map(([key, value]) => [
        key,
        {
          promptRejected: value.promptRejected,
          error: value.error?.message,
          answer: value.answers?.at(-1)?.text,
          storedMime: value.storedAttachment?.[0]?.mime,
          storedSource: value.storedAttachment?.[0]?.source,
        },
      ]),
    ),
    null,
    2,
  ),
);
