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
 * the live catalog and produce a finished assistant message in a bounded
 * probe (max {@link PROBE_ATTEMPTS} attempts). A candidate that fails falls
 * through to the next; when nothing survives, generation tests skip.
 *
 * Scope guard: the pin is machine-local test infrastructure ONLY. It must
 * not reintroduce `ollama-cloud/*` ids into `OpencodeModels` or any shipped
 * code — the stage-8 decontamination stands.
 */
import { OpenCode } from "@opencode-ai/client";

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
 * prompt it, and poll the message store until a finished assistant message
 * appears. Throws (with the reason) on timeout or any API error.
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
    const finished = messages.data.some(
      (message) =>
        message.type === "assistant" &&
        typeof message.finish === "string" &&
        message.finish.length > 0,
    );
    if (finished) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS));
  }
  throw new Error(`no finished assistant message within ${PROBE_TIMEOUT_MS}ms`);
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
 * Returns null when no candidate produced an assistant message — generation
 * tests then skip rather than time out one by one.
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
  // pinned to a session. When the catalog itself is unreachable the probe
  // below is still the real gate, so membership is treated as unknown-pass.
  let catalog: Set<string> | undefined;
  try {
    const listed = await client.model.list({});
    catalog = new Set(
      listed.data.map((model) =>
        refString({ providerID: model.providerID, modelID: model.modelID }),
      ),
    );
  } catch (error) {
    warn(
      `model.list failed (${error instanceof Error ? error.message : String(error)}) — skipping catalog membership checks`,
    );
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
    if (catalog !== undefined && !catalog.has(refString(candidate))) {
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
          `test model resolved: ${refString(candidate)} (${candidate.source}, probe produced an assistant message)`,
        );
      }
      return candidate;
    }
  }
  warn(
    "no test-model candidate produced an assistant message — generation tests will skip",
  );
  return null;
}
