/**
 * Test-model resolution for the integration suite (stage-10 decision C).
 *
 * The server's own default model (`opencode/nemotron-3.5-lightning-free` at
 * the time of writing) accepts prompts and never answers, so a suite run on
 * it times out for an upstream reason (see `docs/v2-spike-findings.md`).
 * The suite therefore resolves the model tests generate with in this order:
 *
 *   1. `OPENCODE_TEST_MODEL` env override (`providerID/modelID`),
 *   2. the pinned {@link PINNED_TEST_MODEL} — requires `OLLAMA_API_KEY` in
 *      the **server's** env (the harness forwards it from the host; the pin
 *      is skipped with a message when the host has none),
 *   3. the server default, with a loud warning that the pin was unavailable.
 *
 * Every candidate is verified before being handed to tests: it must exist in
 * the live catalog and produce a successful assistant message (non-error
 * finish with text output — see {@link isSuccessfulAssistantMessage}) in a
 * bounded probe (max {@link PROBE_ATTEMPTS} attempts). A candidate that fails falls
 * through to the next; when nothing survives — including when the catalog
 * itself is unreachable (fail-closed) — generation tests skip.
 *
 * Scope guard: the pin is machine-local test infrastructure ONLY. It must
 * not reintroduce `ollama-cloud/*` ids into `OpencodeModels` or any shipped
 * code — the stage-8 decontamination stands.
 */
import { OpenCode } from "@opencode-ai/client";
import type { SessionMessageInfo } from "@opencode-ai/client";

export interface TestModelRef {
  providerID: string;
  modelID: string;
}

export interface ResolvedTestModel extends TestModelRef {
  /** Which rung of the resolution order produced the model. */
  source: "env" | "pin" | "default";
}

/**
 * The pinned test model. `ollama-cloud` models are env-gated on
 * `OLLAMA_API_KEY` (models.dev), so the harness forwards that key into the
 * sandboxed server env.
 */
// TODO: swap to `ollama-cloud/glm-5.3-flash` once it appears on models.dev
// (user request; cheaper than minimax-m3).
export const PINNED_TEST_MODEL: TestModelRef = {
  providerID: "ollama-cloud",
  modelID: "minimax-m3",
};

const CATALOG_ATTEMPTS = 2;
const PROBE_ATTEMPTS = 2;
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_POLL_MS = 2_000;

function log(message: string): void {
  console.log(`[integration] ${message}`);
}

function warn(message: string): void {
  console.warn(`[integration] ${message}`);
}

function refString(ref: TestModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}

/**
 * Finishes that mean the model actually completed a turn. `"error"` (e.g.
 * ModelUnavailable, auth failures), `"content-filter"`, and `"unknown"` also
 * arrive as nonempty `finish` strings, so a bare nonempty check would count
 * upstream failures as probe success.
 */
const SUCCESS_FINISHES = new Set(["stop", "length", "tool-calls"]);

/**
 * True only for an assistant message that completed successfully AND carries
 * visible text output — the standard for "this model works" shared by the
 * probe here and the default-model canary.
 */
export function isSuccessfulAssistantMessage(
  message: SessionMessageInfo,
): boolean {
  return (
    message.type === "assistant" &&
    message.error === undefined &&
    typeof message.finish === "string" &&
    SUCCESS_FINISHES.has(message.finish) &&
    message.content.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )
  );
}

/**
 * The failure reason when an assistant message terminally failed (structured
 * error or non-success finish), else undefined. Lets pollers fail fast with
 * the upstream reason instead of waiting out the timeout.
 */
export function assistantFailureReason(
  message: SessionMessageInfo,
): string | undefined {
  if (message.type !== "assistant") {
    return undefined;
  }
  if (message.error !== undefined) {
    return `assistant message carries error ${message.error.type}: ${message.error.message}`;
  }
  if (
    typeof message.finish === "string" &&
    message.finish.length > 0 &&
    !SUCCESS_FINISHES.has(message.finish)
  ) {
    return `assistant message finished with "${message.finish}"`;
  }
  return undefined;
}

function parseEnvOverride(raw: string): TestModelRef | undefined {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    warn(
      `OPENCODE_TEST_MODEL "${raw}" is not "providerID/modelID" — ignoring the override`,
    );
    return undefined;
  }
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

/**
 * One bounded probe turn: create a session pinned to the candidate model,
 * prompt it, and poll the message store until a successful assistant message
 * appears. Throws (with the reason) on timeout, on any API error, or as soon
 * as an assistant message terminally fails (error finish / structured error).
 */
async function probeOnce(
  client: ReturnType<typeof OpenCode.make>,
  ref: TestModelRef,
  workdir: string,
): Promise<void> {
  const session = await client.session.create({
    title: `harness-model-probe ${refString(ref)}`,
    model: { providerID: ref.providerID, id: ref.modelID },
    location: { directory: workdir },
  });
  await client.session.prompt({
    sessionID: session.id,
    text: "Reply with exactly: OK",
  });
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const messages = await client.message.list({ sessionID: session.id });
    if (messages.data.some(isSuccessfulAssistantMessage)) {
      return;
    }
    for (const message of messages.data) {
      const failure = assistantFailureReason(message);
      if (failure !== undefined) {
        throw new Error(failure);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS));
  }
  throw new Error(
    `no successful assistant message within ${PROBE_TIMEOUT_MS}ms`,
  );
}

async function probe(
  client: ReturnType<typeof OpenCode.make>,
  ref: TestModelRef,
  workdir: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      await probeOnce(client, ref, workdir);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(
        `test-model probe ${refString(ref)} attempt ${attempt}/${PROBE_ATTEMPTS} failed: ${reason}`,
      );
    }
  }
  return false;
}

/**
 * Resolve and verify the model integration tests should generate with.
 * Returns null when no candidate produced a successful assistant message —
 * generation tests then skip rather than time out one by one.
 */
export async function resolveTestModel(options: {
  baseUrl: string;
  authHeader: string;
  workdir: string;
  defaultModel: TestModelRef | null;
}): Promise<ResolvedTestModel | null> {
  const client = OpenCode.make({
    baseUrl: options.baseUrl,
    headers: { Authorization: options.authHeader },
  });

  // Catalog membership check: a model the server does not list cannot be
  // pinned to a session, and the brief requires BOTH catalog membership and
  // a successful probe before a model is handed to tests. The check is
  // fail-closed: when `model.list` is unreachable after a bounded retry, no
  // candidate can be verified and generation tests skip.
  let catalog: Set<string> | undefined;
  for (let attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt++) {
    try {
      const listed = await client.model.list({});
      catalog = new Set(
        listed.data.map((model) =>
          refString({ providerID: model.providerID, modelID: model.modelID }),
        ),
      );
      break;
    } catch (error) {
      warn(
        `model.list attempt ${attempt}/${CATALOG_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (catalog === undefined) {
    warn(
      "live catalog is unreachable — no test-model candidate can be verified, so generation tests will skip",
    );
    return null;
  }

  const candidates: ResolvedTestModel[] = [];
  const envOverride = process.env.OPENCODE_TEST_MODEL;
  if (envOverride !== undefined) {
    const parsed = parseEnvOverride(envOverride);
    if (parsed !== undefined) {
      candidates.push({ ...parsed, source: "env" });
    }
  }
  if (process.env.OLLAMA_API_KEY !== undefined) {
    candidates.push({ ...PINNED_TEST_MODEL, source: "pin" });
  } else {
    warn(
      `pinned test model ${refString(PINNED_TEST_MODEL)} skipped: OLLAMA_API_KEY is not set on the host, ` +
        `so the sandboxed server has no ollama-cloud provider — falling back to the server default model`,
    );
  }
  if (options.defaultModel !== null) {
    candidates.push({ ...options.defaultModel, source: "default" });
  }

  for (const candidate of candidates) {
    if (!catalog.has(refString(candidate))) {
      warn(
        `test-model candidate ${refString(candidate)} (${candidate.source}) is not in the live catalog — skipping`,
      );
      continue;
    }
    if (await probe(client, candidate, options.workdir)) {
      if (candidate.source === "default") {
        warn(
          `pinned test model ${refString(PINNED_TEST_MODEL)} was UNAVAILABLE — the suite is ` +
            `running on the server default ${refString(candidate)} (probe-verified this run, ` +
            `but the default has been broken upstream before; see default-model.test.ts)`,
        );
      } else {
        log(
          `test model resolved: ${refString(candidate)} (${candidate.source}, probe produced a successful assistant message)`,
        );
      }
      return candidate;
    }
  }
  warn(
    "no test-model candidate produced a successful assistant message — generation tests will skip",
  );
  return null;
}
