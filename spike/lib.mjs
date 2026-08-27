// Shared helpers for the stage-0 spike scripts.
// Server: local isolated beta server started via
//   env XDG_*=$PWD/spike/sandbox/... ./node_modules/.bin/opencode serve --port 14096
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode-ai/client";

export const BASE_URL = process.env.SPIKE_BASE_URL ?? "http://127.0.0.1:14096";
export const ARTIFACTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "artifacts",
);
export const SANDBOX_WORKDIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "sandbox",
  "workdir",
);

export const client = OpenCode.make({ baseUrl: BASE_URL });

/**
 * Create an embedded v2 host (matches @opencode-ai/client@beta-18286 exactly).
 * Requires XDG_* env vars to point at spike/sandbox for isolation — enforced here.
 */
export async function createEmbeddedHost() {
  const sandbox = join(dirname(fileURLToPath(import.meta.url)), "sandbox");
  for (const [key, sub] of [
    ["XDG_DATA_HOME", "data"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_CACHE_HOME", "cache"],
  ]) {
    if (!process.env[key]) process.env[key] = join(sandbox, sub);
  }
  const { OpenCode: EmbeddedOpenCode } = await import("opencode-sdk-v2-beta");
  return EmbeddedOpenCode.create();
}

/** collectEvents against an arbitrary client (embedded or network). */
export function collectEventsFrom(target, filter) {
  const events = [];
  const controller = new AbortController();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  (async () => {
    try {
      for await (const event of target.event.subscribe({
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

export function saveArtifact(name, data) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, replacer, 2) + "\n");
  console.log(`[artifact] ${file}`);
}

function replacer(_key, value) {
  if (value instanceof Error) {
    return {
      __error: true,
      name: value.name,
      _tag: value._tag,
      message: value.message,
      reason: value.reason,
      ...Object.fromEntries(
        Object.entries(value).filter(([k]) => !["stack"].includes(k)),
      ),
      cause:
        value.cause instanceof Error
          ? { name: value.cause.name, message: value.cause.message }
          : value.cause,
    };
  }
  return value;
}

/** Run a thunk, capture either the resolved value or the thrown error. */
export async function capture(label, thunk) {
  const startedAt = Date.now();
  try {
    const value = await thunk();
    return { label, ok: true, ms: Date.now() - startedAt, value };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - startedAt, error };
  }
}

/**
 * Start collecting events from client.event.subscribe into an array.
 * Returns { events, stop, ready } — `ready` resolves once the first event
 * (expected: server.connected) has been received.
 */
export function collectEvents(filter) {
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
  return {
    events,
    ready,
    done,
    stop: () => controller.abort(),
  };
}

/**
 * Prompt against the DEV server's actual contract (differs from beta-18286
 * client): POST /api/session/:id/prompt with {prompt: {text, files, agents},
 * delivery?, resume?, id?}. Returns the parsed receipt (unwrapped from data).
 */
export async function rawPrompt(
  sessionID,
  { text, files, agents, delivery, resume, id } = {},
) {
  const res = await fetch(
    `${BASE_URL}/api/session/${encodeURIComponent(sessionID)}/prompt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: {
          text,
          ...(files ? { files } : {}),
          ...(agents ? { agents } : {}),
        },
        ...(delivery !== undefined ? { delivery } : {}),
        ...(resume !== undefined ? { resume } : {}),
        ...(id !== undefined ? { id } : {}),
      }),
    },
  );
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = new Error(`rawPrompt ${res.status}: ${JSON.stringify(body)}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body?.data ?? body;
}

/** Raw GET/POST against the dev server, returning {status, body}. */
export async function rawCall(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") ?? "";
  const parsed = contentType.includes("json")
    ? await res.json().catch(() => undefined)
    : await res.text();
  return { status: res.status, contentType, body: parsed };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Provenance block for beta-source verification artifacts: binds a capture
 * to the exact server it ran against (health carries the serve version+pid),
 * the source checkout's Git SHA, and the pinned client version — so the
 * artifact itself, not just surrounding docs, attributes the evidence.
 */
export async function captureProvenance({
  betaClient,
  baseUrl,
  workdir,
  srcDir,
}) {
  const { execSync } = await import("node:child_process");
  const { readFileSync, existsSync } = await import("node:fs");
  let srcGitHead;
  if (srcDir && existsSync(join(srcDir, ".git"))) {
    try {
      srcGitHead = execSync(`git -C "${srcDir}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim();
    } catch {
      srcGitHead = undefined;
    }
  }
  let pinnedClientVersion;
  try {
    pinnedClientVersion = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../node_modules/@opencode-ai/client/package.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ).version;
  } catch {
    pinnedClientVersion = undefined;
  }
  return {
    capturedAt: new Date().toISOString(),
    betaSrcUrl: baseUrl,
    workdir,
    srcDir,
    srcGitHead,
    pinnedClientVersion,
    serverHealth: await capture("provenance-health", () =>
      betaClient.health.get(),
    ),
    serverInfo: await capture("provenance-server-get", () =>
      betaClient.server.get(),
    ),
  };
}

/** Extract sessionID from an event, handling the form.created nesting. */
export function eventSessionID(event) {
  return event?.data?.sessionID ?? event?.data?.form?.sessionID;
}
