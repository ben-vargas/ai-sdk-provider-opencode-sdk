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
 *      the **server's** env (spawned mode forwards it from the host; attach
 *      mode depends on the external server's own env),
 *   3. the server default, with a loud warning that the pin was unavailable.
 *
 * The order is identical in spawned and attach modes: every candidate —
 * including the pin — is offered in both, and the live catalog check decides
 * whether it is actually available on THIS server (the pin's provider is
 * env-gated, so a server without `OLLAMA_API_KEY` simply does not list it).
 *
 * Every candidate is verified before being handed to tests: it must exist in
 * the live catalog and produce a successful assistant message (non-error
 * finish with text output — see {@link isSuccessfulAssistantMessage}) in a
 * bounded probe (max {@link PROBE_ATTEMPTS} attempts). A candidate that fails falls
 * through to the next; when nothing survives — including when the catalog
 * itself is unreachable (fail-closed) — generation tests skip.
 *
 * Every API request the resolver makes carries an `AbortSignal`, so a hung
 * server call aborts at its deadline instead of extending it, and each probe
 * attempt is additionally raced against a hard deadline — the bounded window
 * holds even if a transport ignores the signal.
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

/**
 * Deadlines for the resolver's API traffic. Every value bounds real network
 * requests via `AbortSignal`; tests override them (tiny values against fake
 * servers) to prove the bounds hold without waiting out production windows.
 */
export interface ResolverTimeouts {
  /** Per-attempt bound on the whole probe turn (create+prompt+polls). */
  probeTimeoutMs: number;
  /** Delay between message-store polls inside a probe attempt. */
  probePollMs: number;
  /** Per-attempt bound on the `model.list` catalog request. */
  catalogTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: ResolverTimeouts = {
  probeTimeoutMs: 90_000,
  probePollMs: 2_000,
  catalogTimeoutMs: 15_000,
};

/**
 * Extra slack the hard-deadline race grants beyond `probeTimeoutMs`, so the
 * signal-driven abort (with its more specific error) normally wins and the
 * race only fires when a transport ignored the signal entirely.
 */
const HARD_DEADLINE_GRACE_MS = 5_000;

/** Reject if `promise` is still pending after `ms` — the last-resort bound. */
async function withHardDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded the hard deadline of ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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
 * appears. A single `AbortSignal.timeout` covers the whole attempt and is
 * threaded into every API request, so a hung server call cannot outlive the
 * window. Throws (with the reason) on timeout, on any API error, or as soon
 * as an assistant message terminally fails (error finish / structured error).
 */
async function probeOnce(
  client: ReturnType<typeof OpenCode.make>,
  ref: TestModelRef,
  workdir: string,
  timeouts: ResolverTimeouts,
): Promise<void> {
  const signal = AbortSignal.timeout(timeouts.probeTimeoutMs);
  const deadline = Date.now() + timeouts.probeTimeoutMs;
  const session = await client.session.create(
    {
      title: `harness-model-probe ${refString(ref)}`,
      model: { providerID: ref.providerID, id: ref.modelID },
      location: { directory: workdir },
    },
    { signal },
  );
  await client.session.prompt(
    {
      sessionID: session.id,
      text: "Reply with exactly: OK",
    },
    { signal },
  );
  while (Date.now() < deadline && !signal.aborted) {
    const messages = await client.message.list(
      { sessionID: session.id },
      { signal },
    );
    if (messages.data.some(isSuccessfulAssistantMessage)) {
      return;
    }
    for (const message of messages.data) {
      const failure = assistantFailureReason(message);
      if (failure !== undefined) {
        throw new Error(failure);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, timeouts.probePollMs));
  }
  throw new Error(
    `no successful assistant message within ${timeouts.probeTimeoutMs}ms`,
  );
}

async function probe(
  client: ReturnType<typeof OpenCode.make>,
  ref: TestModelRef,
  workdir: string,
  timeouts: ResolverTimeouts,
): Promise<boolean> {
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      await withHardDeadline(
        probeOnce(client, ref, workdir, timeouts),
        timeouts.probeTimeoutMs + HARD_DEADLINE_GRACE_MS,
        `test-model probe ${refString(ref)}`,
      );
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
  /**
   * How the harness got its server: `"spawned"` (sandbox child process) or
   * `"attach"` (`OPENCODE_BETA_URL`). The resolution order is identical in
   * both — the mode only sharpens the diagnostic when the pin is missing
   * from the catalog, because WHO must hold `OLLAMA_API_KEY` differs.
   */
  mode: "spawned" | "attach";
  /** Test-only override of the request deadlines (defaults are production). */
  timeouts?: Partial<ResolverTimeouts>;
}): Promise<ResolvedTestModel | null> {
  const timeouts: ResolverTimeouts = {
    ...DEFAULT_TIMEOUTS,
    ...options.timeouts,
  };
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
      const listed = await client.model.list(
        {},
        { signal: AbortSignal.timeout(timeouts.catalogTimeoutMs) },
      );
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
  // The pin is ALWAYS a candidate — in both spawned and attach modes. Its
  // provider is env-gated server-side, so the live catalog check below is
  // the authority on whether THIS server offers it; gating on the host's
  // own env here would wrongly skip a probeable pin on an attached server
  // whose env (not the host's) holds the key.
  candidates.push({ ...PINNED_TEST_MODEL, source: "pin" });
  if (options.defaultModel !== null) {
    candidates.push({ ...options.defaultModel, source: "default" });
  }

  for (const candidate of candidates) {
    if (!catalog.has(refString(candidate))) {
      if (candidate.source === "pin") {
        warn(
          `pinned test model ${refString(candidate)} is not in the live catalog — ` +
            (options.mode === "spawned"
              ? `the sandboxed server has no ollama-cloud provider (set OLLAMA_API_KEY on the host; the harness forwards it)`
              : `the attached server (OPENCODE_BETA_URL) has no ollama-cloud provider (its own env must hold OLLAMA_API_KEY)`) +
            ` — falling back`,
        );
      } else {
        warn(
          `test-model candidate ${refString(candidate)} (${candidate.source}) is not in the live catalog — skipping`,
        );
      }
      continue;
    }
    if (await probe(client, candidate, options.workdir, timeouts)) {
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
