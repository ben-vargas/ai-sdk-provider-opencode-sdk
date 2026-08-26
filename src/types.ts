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
  "file" | "version" | "command"
>;

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
 * "steer" supersedes the remaining turn at the next step boundary,
 * "queue" waits for the current turn to finish.
 */
export type OpencodeDelivery = SessionInboxDelivery;

/**
 * How the model instance binds to an OpenCode session:
 * - "ephemeral": provider-owned session per conversation (default). The
 *   session still survives across tool-approval round-trips within the
 *   conversation.
 * - "persistent": provider creates one session and reuses it across
 *   conversations (v4's implicit default, now opt-in).
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
 * What to do when a form request has no handler (or the handler fails).
 * Cancelling unblocks the session; waiting leaves the form pending so an
 * external client can answer it.
 */
export type OpencodeFormPolicy = "cancel" | "wait";

/**
 * A `data:` URI usable as a `files[].uri` prompt value. The only scheme
 * verified to reach the model end-to-end on current OpenCode v2 builds:
 * the server admits and stores any scheme without validation, but hands
 * `file:`/path/`https:` URIs verbatim to the model provider where they fail
 * the whole turn. The stored MIME comes from the URI's declared mediatype,
 * so encode the correct media type into the URI itself.
 */
export type OpencodeDataUri = `data:${string}`;

/**
 * A file the provider needs a v2 prompt URI for. Only `data:` URIs are known
 * to reach the model end-to-end on current builds; other schemes are stored
 * verbatim and fail at the model provider.
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
 * provider emits a warning for skipped files). Non-`data:` URIs are known
 * to fail the whole turn downstream, so the provider rejects any other
 * scheme before prompting (warning + skip) rather than attaching it.
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
   * default (avoids `SessionBusyError` and mid-turn supersession), while the
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
 * 2. `baseUrl` — `OpenCode.make({baseUrl, ...clientOptions})`.
 * 3. service discovery — `Service.discover()` (or `Service.ensure()` when
 *    `autoStart` is true) using `service` options; endpoint auth headers are
 *    merged automatically.
 *
 * v4's `hostname`/`port`/`serverTimeout` probing and the injectable
 * `clientManager` have no v2 equivalent and were removed (v5 break).
 */
export interface OpencodeProviderSettings {
  /**
   * Preconfigured OpenCode v2 client. When provided, backend management is
   * bypassed and `baseUrl`/`service`/`autoStart`/`clientOptions` are ignored.
   */
  client?: OpencodeClient;

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
   * Dispose provider-owned resources (embedded host, event subscriptions).
   * Never stops a shared registered service or closes caller-supplied
   * clients.
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
    /** Pending tool-approval request ID, when the turn is blocked on one. */
    approvalRequestId?: string;
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
