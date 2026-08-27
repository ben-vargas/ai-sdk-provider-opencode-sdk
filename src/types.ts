import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import type {
  FormAnswer,
  FormField,
  FormInfo,
  FormValue,
  LocationRef,
  OpenCodeClient,
  SessionInboxDelivery,
  SessionMessageAssistant,
  SessionMessageAssistantRetry,
  SessionStructuredError,
  TokenUsageInfo,
} from "@opencode-ai/client";
import type { EnsureOptions } from "@opencode-ai/client/service";
import type { OpencodeClientPort } from "./client-port.js";

/**
 * Model ID format for OpenCode provider.
 * Can be:
 * - "providerID/modelID" (e.g., "anthropic/claude-opus-4-5-20251101")
 * - "modelID" (e.g., "claude-opus-4-5-20251101" - uses the session/server default provider)
 */
export type OpencodeModelId = string;

/**
 * OpenCode v2 client instance (`OpenCode.make(...)` from `@opencode-ai/client`,
 * or the structurally compatible embedded host).
 */
export type OpencodeClient = OpenCodeClient;

/**
 * Client construction passthrough options.
 * v2 client config is just `{baseUrl, fetch?, headers?}`; `baseUrl` is managed
 * by the provider's backend selection, leaving `fetch` and `headers`.
 */
export type OpencodeClientOptions = Omit<
  Parameters<typeof import("@opencode-ai/client").OpenCode.make>[0],
  "baseUrl"
>;

/**
 * Options for the local-service backend (`Service.discover`/`Service.ensure`
 * from `@opencode-ai/client/service`).
 */
export type OpencodeServiceOptions = Pick<
  EnsureOptions,
  "file" | "version" | "command" | "env" | "onStart"
>;

/**
 * Backend abstraction that produces the client-port the language model runs
 * against. `createOpencode` builds one from provider settings (or accepts a
 * caller-supplied instance via `clientManager`); a future `./embedded`
 * entrypoint injects a port through the same seam
 * (`createClientManagerFromPort`).
 */
export interface OpencodeClientManager {
  /**
   * Resolve the client-port for a generation. The first call performs backend
   * acquisition (client construction / service discovery) plus a preflight
   * (`health.get` + `migration.v1.status`); the result is cached, and a
   * failed acquisition is retried on the next call.
   */
  getPort(): Promise<OpencodeClientPort>;

  /**
   * Server base URL, when the backend exposes one: the configured `baseUrl`,
   * or the discovered service endpoint URL after the first successful
   * acquisition. Undefined for caller-supplied clients and injected ports
   * (no endpoint is knowable).
   */
  getServerUrl(): string | undefined;

  /**
   * Whether this manager started the server process itself (`Service.ensure`
   * spawned it). Always false for discover-only, baseUrl, and caller-supplied
   * backends.
   */
  isServerManaged(): boolean;

  /**
   * Explicitly stop the registered local service (`Service.stop`). This is a
   * user-invoked action and is allowed even on the shared default
   * registration; it throws on non-service backends. `dispose()` never does
   * this unless the manager runs in owned mode (dedicated registration
   * `file` + `autoStart`).
   */
  stopService(): Promise<void>;

  /**
   * Release provider-owned resources. Never closes caller-supplied clients
   * and never stops a shared registered service; stops the service only in
   * owned mode (dedicated registration `file` + `autoStart`).
   */
  dispose(): Promise<void>;
}

/**
 * Logger interface for the OpenCode provider.
 */
export interface Logger {
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Session location: the directory (and optional workspace) a session binds to
 * at creation. Replaces v1's client-level `directory`.
 */
export type OpencodeSessionLocation = LocationRef;

/**
 * Inbox delivery mode for prompts sent to a busy session:
 * "steer" injects the prompt into the in-flight turn as mid-turn context —
 * verified on the beta-source server to neither interrupt nor supersede the
 * running turn, and to produce no dedicated answer of its own (whether the
 * model honors the injected text is model behavior);
 * "queue" waits for the current turn to finish, then runs normally.
 */
export type OpencodeDelivery = SessionInboxDelivery;

/**
 * How the model instance binds to an OpenCode session.
 *
 * Session state is model-instance-local: a model instance creates or pins
 * one session on first use and reuses it for every later call on that same
 * instance (unless `createNewSession` forces a fresh one per call). Nothing
 * outlives the instance — `createOpencode(...)` builds a new model on every
 * factory call, and no session ID is persisted anywhere.
 *
 * - "ephemeral": the provider creates a session on first use and owns it
 *   exclusively (default). It survives tool-approval round-trips.
 * - "persistent": **currently identical to "ephemeral" in behavior** —
 *   both take the same provider-created, instance-pinned path. It does not
 *   share a session across model instances or process restarts; there is no
 *   session persistence to key that on. To reattach to a session you stored
 *   yourself, pass its `sessionId` (mode "existing").
 * - "existing": pin the session given by `sessionId` (shared-session caveat:
 *   other clients on the same session can be misattributed — there is no
 *   inbox-to-execution correlation key in the v2 beta).
 */
export type OpencodeSessionMode = "ephemeral" | "persistent" | "existing";

/**
 * An interactive form request emitted by OpenCode (replaces v1 questions).
 * Fields are typed and keyed; answers are keyed records, not positional
 * arrays.
 */
export type OpencodeFormRequest = FormInfo;

/**
 * A single form field definition.
 */
export type OpencodeFormField = FormField;

/**
 * A single form answer value.
 */
export type OpencodeFormValue = FormValue;

/**
 * Keyed answers for a form reply: `{ [fieldKey]: value }`.
 */
export type OpencodeFormAnswer = FormAnswer;

/**
 * Response to an interactive OpenCode form request.
 */
export type OpencodeFormResponse =
  | { type: "answer"; answer: OpencodeFormAnswer }
  | { type: "cancel" };

/**
 * What to do when a form request has **no handler**: cancelling unblocks
 * the session, waiting leaves the form pending so an external client can
 * answer it. The policy does not cover a configured handler that throws —
 * that form is always cancelled (see {@link OpencodeSettings.formPolicy}).
 */
export type OpencodeFormPolicy = "cancel" | "wait";

/**
 * A `data:` URI usable as a `files[].uri` prompt value — the one scheme that
 * works across every known v2 server build. Beta-contract servers also read
 * server-local `file:` URIs and reject `https:`/relative paths at prompt
 * time, while dev-channel builds store any non-`data:` URI raw and fail the
 * turn at the model provider (spike Q1 + stage-6 re-verification). The
 * stored MIME comes from the URI's declared mediatype, so encode the correct
 * media type into the URI itself.
 */
export type OpencodeDataUri = `data:${string}`;

/**
 * A file the provider needs a v2 prompt URI for. Only `data:` URIs work
 * across all builds; other schemes are either rejected at prompt time (beta
 * contract, except readable server-local `file:`) or stored verbatim and
 * failed at the model provider (dev builds).
 */
export interface OpencodeFileToResolve {
  /** IANA media type of the file content. */
  mediaType: string;
  /** File name, when known. */
  filename?: string;
  /** Raw bytes (or base64 string) when the AI SDK supplied binary data. */
  data?: Uint8Array | string;
  /** Original URL when the file part referenced one. */
  url?: string;
}

/**
 * Hook to turn a file part into a `files[].uri` value for `session.prompt`.
 * Return a `data:` URI to attach the file, or undefined to skip it (the
 * provider emits a warning for skipped files). The provider rejects any
 * other scheme before prompting (warning + skip): non-`data:` URIs fail
 * downstream on dev builds and (except readable server-local `file:`) are
 * rejected at prompt time on the beta contract, so `data:` is the only
 * build-independent scheme.
 */
export type OpencodeResolveFileToUri = (
  file: OpencodeFileToResolve,
) => Promise<OpencodeDataUri | undefined> | OpencodeDataUri | undefined;

/**
 * Settings for individual model instances.
 */
export interface OpencodeSettings {
  /**
   * Pin an existing session by ID (implies shared-session caveats; see
   * {@link OpencodeSessionMode}). Validated against `session.get` before use.
   */
  sessionId?: string;

  /**
   * How this model instance binds to an OpenCode session.
   * @default "ephemeral"
   */
  sessionMode?: OpencodeSessionMode;

  /**
   * Force creation of a fresh session for each ordinary generation call.
   * Approval-only continuation calls always reattach to the blocked session
   * regardless (v2 tool approvals resume a pinned session; this is a
   * documented deviation from v4 semantics).
   * @default false
   */
  createNewSession?: boolean;

  /**
   * Title for newly created sessions.
   * @default "AI SDK Session"
   */
  sessionTitle?: string;

  /**
   * Agent to use for sessions created by this instance.
   * Agent is session state in v2 (set at create / switchAgent), not a
   * per-prompt field.
   */
  agent?: string;

  /**
   * Custom system prompt.
   *
   * DEGRADED in v2: there is no per-prompt or per-session system field on the
   * network API. The provider prepends a delimited system block to the first
   * user turn and emits an unsupported-degraded warning (system-role priority
   * is lost). True system semantics require the embedded host's plugin hooks.
   */
  systemPrompt?: string;

  /**
   * OpenCode model variant identifier (rides the session's `ModelRef`).
   * Requires a resolvable providerID: a bare model ID plus `variant` cannot
   * omit the model ref at session create.
   */
  variant?: string;

  /**
   * Session location (directory and optional workspace), bound at
   * `session.create`. Replaces v1's `directory`/`cwd` settings.
   */
  location?: OpencodeSessionLocation;

  /**
   * Directory the session binds to.
   * @deprecated v4 migration alias: maps to `location.directory`. Ignored
   * when `location` is provided. Use `location` instead.
   */
  directory?: string;

  /**
   * Inbox delivery mode when prompting a busy session.
   *
   * Divergence note: the design doc recommends `"queue"` as the provider
   * default (avoids `SessionBusyError` and mid-turn context injection), while the
   * live spike observed the *server* default to be `"steer"` when the field
   * is omitted. The provider therefore always sends its own default
   * explicitly rather than inheriting the server's.
   * @default "queue"
   */
  delivery?: OpencodeDelivery;

  /**
   * Ask the server to resume the previous execution when prompting
   * (v2 `SessionPromptInput.resume`; semantics are provisional — live builds
   * treated it as a normal prompt).
   */
  resume?: boolean;

  /**
   * Called when OpenCode asks an interactive form (v2's replacement for
   * questions). Return keyed answers or a cancellation.
   */
  onForm?: (
    form: OpencodeFormRequest,
  ) => Promise<OpencodeFormResponse> | OpencodeFormResponse;

  /**
   * What to do when a form request has no handler. If a configured handler
   * throws, the form is always cancelled regardless of this policy.
   * @default "cancel"
   */
  formPolicy?: OpencodeFormPolicy;

  /**
   * Hook to resolve file parts to prompt URIs. When omitted, the provider
   * converts bytes to `data:` URIs (the only scheme verified to work) and
   * warns on anything it cannot convert.
   */
  resolveFileToUri?: OpencodeResolveFileToUri;

  /**
   * Opt-in client-side JSON validate/repair loop for
   * `responseFormat: { type: "json" }` (off by default). OpenCode v2 has no
   * server-side structured-output enforcement, so when enabled the provider
   * validates the final text client-side (`JSON.parse` plus recursive
   * structural validation — type/properties/required/items/enum/const/
   * additionalProperties — against the AI SDK-supplied schema when present)
   * and, on failure, asks the server's `generate.text` route — documented
   * upstream as session-less/tool-less/history-less, so it can never replay
   * the original turn's side effects — to repair the invalid output.
   * Bounded by `maxAttempts` (default 1); a warning records the attempts
   * used. Applies to `doGenerate` only: streamed output has already been
   * delivered and cannot be recalled.
   */
  jsonRepair?: {
    /** Maximum repair calls per generation. @default 1 */
    maxAttempts?: number;
  };

  /**
   * Logger instance or false to disable logging.
   */
  logger?: Logger | false;

  /**
   * Enable verbose logging.
   * @default false
   */
  verbose?: boolean;
}

/**
 * Provider-level settings applied to all model instances.
 *
 * Backend selection (mutually exclusive; precedence in this order):
 * 1. `client` — caller-supplied v2 client, used as-is (never disposed by the
 *    provider).
 * 2. `clientManager` — caller-supplied manager, used as-is (never disposed
 *    by the provider).
 * 3. `baseUrl` — `OpenCode.make({baseUrl, ...clientOptions})`.
 * 4. service discovery — `Service.discover()` (or `Service.ensure()` when
 *    `autoStart` is true) using `service` options; endpoint auth headers are
 *    merged under user headers automatically.
 *
 * v4's `hostname`/`port`/`serverTimeout` probing has no v2 equivalent and
 * was removed (v5 break).
 */
export interface OpencodeProviderSettings {
  /**
   * Preconfigured OpenCode v2 client. When provided, backend management is
   * bypassed and `clientManager`/`baseUrl`/`service`/`autoStart`/
   * `clientOptions` are ignored.
   */
  client?: OpencodeClient;

  /**
   * Caller-supplied client manager (retyped v4 injection seam). Used as-is:
   * the provider never disposes it — `provider.dispose()` is a no-op for
   * injected managers.
   */
  clientManager?: OpencodeClientManager;

  /**
   * Base URL of an OpenCode v2 server. Takes precedence over service
   * discovery.
   */
  baseUrl?: string;

  /**
   * Local-service discovery options (registration file, version predicate,
   * spawn command) for the service backend.
   */
  service?: OpencodeServiceOptions;

  /**
   * Start the local service via `Service.ensure` when discovery finds none.
   * Provisional default: false (discovery only) — `opencode serve --service`
   * does not work on current dev/beta CLIs, so auto-start would fail today.
   * @default false
   */
  autoStart?: boolean;

  /**
   * Client construction passthrough (`fetch`, `headers`) for the `baseUrl`
   * and service backends. Ignored when `client` is provided.
   */
  clientOptions?: OpencodeClientOptions;

  /**
   * Default settings applied to all model instances.
   * Can be overridden per-model.
   */
  defaultSettings?: OpencodeSettings;
}

/**
 * Provider interface for OpenCode.
 */
export interface OpencodeProvider extends ProviderV4 {
  /**
   * Create a language model instance.
   * @param modelId - Model ID in format "providerID/modelID" or "modelID"
   * @param settings - Optional settings for this model instance
   */
  (modelId: OpencodeModelId, settings?: OpencodeSettings): LanguageModelV4;

  /**
   * Create a language model instance.
   * @param modelId - Model ID in format "providerID/modelID" or "modelID"
   * @param settings - Optional settings for this model instance
   */
  languageModel(
    modelId: OpencodeModelId,
    settings?: OpencodeSettings,
  ): LanguageModelV4;

  /**
   * Alias for languageModel().
   * @param modelId - Model ID in format "providerID/modelID" or "modelID"
   * @param settings - Optional settings for this model instance
   */
  chat(modelId: OpencodeModelId, settings?: OpencodeSettings): LanguageModelV4;

  /**
   * The client manager backing this provider (advanced usage: server URL,
   * explicit `stopService()`).
   */
  getClientManager(): OpencodeClientManager;

  /**
   * Dispose provider-owned resources (embedded host, event subscriptions).
   * Never stops a shared registered service, never closes caller-supplied
   * clients, and never disposes an injected `clientManager`.
   */
  dispose(): Promise<void>;
}

/**
 * Parsed model ID containing provider and model components.
 */
export interface ParsedModelId {
  providerID: string;
  modelID: string;
}

/**
 * Per-request provider options for `providerOptions.opencode`.
 */
export interface OpencodeProviderOptions {
  /**
   * User message ID to send as `SessionPromptInput.id` for this request.
   * No format is asserted; current dev builds still constrain caller-supplied
   * IDs to a `msg_` prefix server-side.
   */
  id?: string;

  /**
   * Escape hatch: target this existing session for this call instead of the
   * model instance's pinned session (caller manages session lifecycle and
   * exclusivity).
   */
  sessionId?: string;
}

/**
 * Native OpenCode assistant finish value.
 */
export type OpencodeFinish = NonNullable<SessionMessageAssistant["finish"]>;

/**
 * Metadata returned in provider responses under `providerMetadata.opencode`.
 */
export interface OpencodeProviderMetadata {
  opencode: {
    /** Session the generation ran on. */
    sessionId: string;
    /** Assistant message ID (last message of the turn on multi-step turns). */
    messageId?: string;
    /** Inbox receipt ID returned by `session.prompt`. */
    inboxId?: string;
    /** First pending tool-approval request ID, when the turn is blocked. */
    approvalRequestId?: string;
    /** Every pending tool-approval request ID, when the turn is blocked. */
    approvalRequestIds?: string[];
    /** Approval request IDs replied during this turn (phase-2 calls). */
    repliedApprovalIds?: string[];
    /** Form IDs surfaced (and answered/cancelled) during this turn. */
    formIds?: string[];
    /** Native finish value before AI SDK normalization. */
    finish?: OpencodeFinish;
    /** Provider-raw finish string, when the server reports one. */
    rawFinish?: string;
    /** Execution outcome for the turn. */
    outcome?: "succeeded" | "failed" | "interrupted";
    /** Interrupt reason when the turn was interrupted. */
    interruptReason?: "user" | "shutdown" | "superseded";
    /** Cost in USD, summed across the turn's steps when available. */
    cost?: number;
    /** Native token usage, summed across the turn's steps. */
    tokens?: TokenUsageInfo;
    /** Structured error reported for a failed turn/step. */
    error?: SessionStructuredError;
    /** Retry record when the server retried the turn. */
    retry?: SessionMessageAssistantRetry;
  };
}
