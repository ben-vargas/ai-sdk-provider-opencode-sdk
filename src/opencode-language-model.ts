/**
 * OpencodeLanguageModel: the `LanguageModelV4` orchestration core over the
 * stage-1 client-port, stage-2 event reducer, and stage-3 converter/error
 * boundary.
 *
 * The v2 prompt contract is fire-and-forget: `session.prompt` returns an
 * inbox receipt, and the turn is observed through the event stream. Both
 * generation modes therefore share one skeleton:
 *
 *   1. establish/reattach the session (one model instance = one conversation
 *      = one pinned session; `providerOptions.opencode.sessionId` is the
 *      per-call escape hatch),
 *   2. subscribe to events BEFORE dispatching, with a readiness handshake
 *      (`server.connected`, else a bounded race),
 *   3. dispatch — `session.prompt` for ordinary calls, `permission.reply`
 *      for approval-only continuation calls (which never issue a prompt),
 *   4. drive the stage-2 reducer until a terminal execution event (or the
 *      idle/iterator-end/approval-quiescence backstops), and
 *   5. never surface a retryable error post-dispatch: transient failures are
 *      reconciled internally against the pinned session's message state.
 */
import { APICallError, NoSuchModelError } from "@ai-sdk/provider";
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { isConflictError, isSessionBusyError } from "@opencode-ai/client";
import type {
  FormCreated,
  FormInfo,
  PermissionRequest,
  SessionInboxUser,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionPromptInput,
  SessionToolSuccess,
  V2Event,
} from "@opencode-ai/client";
import type {
  OpencodeClientPort,
  OpencodeRequestOptions,
} from "./client-port.js";
import {
  convertV2EventToStreamParts,
  createV2StreamState,
  extractV2EventSessionId,
  finalizeV2Stream,
  type OpencodeReducerInput,
  type V2StreamState,
} from "./convert-from-opencode-events.js";
import {
  convertToOpencodePrompt,
  prependSystemBlock,
} from "./convert-to-opencode-messages.js";
import {
  extractErrorMessage,
  isAbortError,
  isMissingRouteError,
  isTaggedError,
  needsSessionReconciliation,
  wrapError,
  type OpencodeErrorData,
} from "./errors.js";
import { getLogger, logUnsupportedCallOptions } from "./logger.js";
import {
  fitsInstructionValue,
  instructionValueBytes,
  INSTRUCTION_VALUE_MAX_BYTES,
  SYSTEM_INSTRUCTION_KEY,
} from "./system-instruction.js";
import { mapOpencodeFinishReason } from "./map-opencode-finish-reason.js";
import type {
  Logger,
  OpencodeFormRequest,
  OpencodeProviderOptions,
  OpencodeSettings,
} from "./types.js";
import {
  resolveSessionLocation,
  resolveSessionMode,
  validateFormAnswer,
  validateModelId,
  validateSettings,
} from "./validation.js";

/**
 * Construction config for the language model. Stage 5 (provider factory /
 * client-manager backends) supplies `getPort`; tests inject a scripted fake
 * port through the same seam.
 */
export interface OpencodeLanguageModelConfig {
  /** Provider name reported to the AI SDK. @default "opencode" */
  provider?: string;
  /**
   * Resolve the client-port for a generation. Called once per call; errors
   * thrown here surface as pre-dispatch errors (retryable when transient).
   */
  getPort: () => OpencodeClientPort | PromiseLike<OpencodeClientPort>;
  /**
   * Readiness-handshake bound: how long to wait for `server.connected`
   * after subscribing before proceeding anyway. @default 3000
   */
  readinessTimeoutMs?: number;
  /**
   * Approval quiescence bound: with an unanswered tool-approval outstanding,
   * how long the event stream may stay silent before the turn is finalized
   * and returned to the caller (phase 1 of the approval round-trip).
   * @default 1500
   */
  approvalIdleTimeoutMs?: number;
  /**
   * Silence watchdog: with no approval outstanding, how long the event
   * stream may stay silent before the turn is probed for a lost signal —
   * pending permissions/forms the stream never delivered, or a settled
   * execution whose terminal event was lost. The probe is non-destructive:
   * it finalizes only when the session is provably blocked or settled, so a
   * genuinely long-running turn just keeps being probed. @default 30000
   */
  silenceWatchdogMs?: number;
  /**
   * `session.wait` watchdog grace: when the watchdog resolves while the
   * event stream shows no terminal, how long to keep draining events before
   * reconciling from the message store (stage-6 measured wait trailing the
   * terminal event by only milliseconds on healthy turns). @default 2000
   */
  waitWatchdogGraceMs?: number;
  /**
   * Delivery-uncertainty evidence window: after a failed prompt dispatch
   * whose inbox check finds no pending item, how long to drain the live
   * subscription for same-session activity (the inbox table is pending-only
   * — a delivered item leaves it, so absence alone does not prove
   * non-delivery). @default 3000
   */
  deliveryEvidenceWindowMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 3000;
const DEFAULT_APPROVAL_IDLE_TIMEOUT_MS = 1500;
const DEFAULT_SILENCE_WATCHDOG_MS = 30_000;
const DEFAULT_WAIT_WATCHDOG_GRACE_MS = 2000;
/** Delivery-uncertainty inbox check: one attempt, bounded. */
const INBOX_CHECK_TIMEOUT_MS = 3000;
const DEFAULT_DELIVERY_EVIDENCE_WINDOW_MS = 3000;

/**
 * Event types that prove this session's prompt was delivered and its turn is
 * (or was) executing. `session.idle` is deliberately excluded — an idle
 * transition alone does not prove the prompt reached the session, and the
 * message-store fallback handles the delivered-and-already-finished case
 * from stored proof.
 */
const DELIVERY_EVIDENCE_TYPE_PREFIXES = [
  "session.inbox.",
  "session.execution.",
  "session.step.",
  "session.text.",
  "session.reasoning.",
  "session.tool.",
  "session.usage.",
  "permission.",
  "form.",
];

/** Same-session activity that proves prompt delivery (exclusive session). */
function isDeliveryEvidence(event: V2Event, sessionId: string): boolean {
  if (extractV2EventSessionId(event) !== sessionId) {
    return false;
  }
  return DELIVERY_EVIDENCE_TYPE_PREFIXES.some((prefix) =>
    event.type.startsWith(prefix),
  );
}
const DEFAULT_SESSION_TITLE = "AI SDK Session";
/** Bounded in-model form retry: nothing redelivers a form within a turn. */
const MAX_FORM_ATTEMPTS = 3;
const FORM_RETRY_BASE_DELAY_MS = 200;

/** An approval decision carried in the prompt (phase-2 input). */
interface PromptApprovalResponse {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/** A model ref accepted by `session.create`. */
interface SessionModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/**
 * Buffered async-iterator reader. `nextWithTimeout` never loses an in-flight
 * `next()`: on timeout (or an external interrupt resolving) the pending
 * promise is stashed and handed to the next caller.
 */
interface EventReader {
  next(): Promise<IteratorResult<V2Event>>;
  nextWithTimeout(
    ms: number,
    interrupt?: Promise<unknown>,
  ): Promise<IteratorResult<V2Event> | "timeout">;
}

function createEventReader(iterable: AsyncIterable<V2Event>): EventReader {
  const iterator = iterable[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<V2Event>> | undefined;

  return {
    next() {
      const promise = pending ?? iterator.next();
      pending = undefined;
      return promise;
    },
    nextWithTimeout(ms: number, interrupt?: Promise<unknown>) {
      const promise = pending ?? iterator.next();
      pending = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      });
      // The read promise is listed first so a ready event always beats a
      // simultaneously-resolved interrupt.
      const racers: Promise<IteratorResult<V2Event> | "timeout">[] = [
        promise,
        timeout,
      ];
      if (interrupt) {
        racers.push(interrupt.then(() => "timeout" as const));
      }
      return Promise.race(racers).then(
        (result) => {
          clearTimeout(timer);
          if (result === "timeout") {
            pending = promise;
            // The stashed promise may never be re-read (the turn finalizes
            // and the subscription is aborted, rejecting it): subscribe a
            // no-op handler so teardown never fires an unhandled rejection.
            promise.catch(() => undefined);
          }
          return result;
        },
        (error: unknown) => {
          clearTimeout(timer);
          throw error;
        },
      );
    },
  };
}

/** Per-generation orchestration state threaded through the pump. */
interface TurnContext {
  port: OpencodeClientPort;
  sessionId: string;
  state: V2StreamState;
  reader: EventReader;
  /** Aborts the event subscription (and only that). */
  subscription: AbortController;
  headers: Record<string, string> | undefined;
  callSignal: AbortSignal | undefined;
  warnings: SharedV4Warning[];
  /** Events consumed during the readiness handshake, replayed by the pump. */
  preBuffer: V2Event[];
  /** Inbox receipt of this call's prompt (absent on approval-only calls). */
  receipt: SessionInboxUser | undefined;
  /** The call requested `responseFormat: { type: "json" }`. */
  jsonMode: boolean;
  /** AI SDK-supplied JSON schema for json mode, when present. */
  jsonSchema: unknown;
  /** Wall-clock lower bound for messages belonging to this turn. */
  turnStartedAt: number;
  /** The prompt (or first permission reply) has been delivered/observed. */
  delivered: boolean;
  /** Approval requests surfaced to the caller and not yet replied. */
  outstandingApprovals: Set<string>;
  /** Assistant messages whose `step.started` was observed. */
  assistantMessageIds: Set<string>;
  /** Assistant messages whose `step.ended`/`step.failed` was observed. */
  stepClosedMessageIds: Set<string>;
  /** Request body reported in `request.body` for telemetry. */
  requestBody: unknown;
  /** Set once server-side abort cleanup has been initiated. */
  abortHandled: boolean;
  /**
   * Reconcile-marked dispatch failure (uncertain prompt/reply delivery):
   * the pump recovers through the session instead of losing the observer.
   */
  dispatchError: Error | undefined;
  /** The doStream consumer canceled the stream (nobody is listening). */
  consumerCanceled: boolean;
  /** Approval request IDs replied during this turn (phase-2 metadata). */
  repliedApprovalIds: string[];
  approvalIdleTimeoutMs: number;
  silenceWatchdogMs: number;
  waitWatchdogGraceMs: number;
  deliveryEvidenceWindowMs: number;
  /**
   * `session.wait` watchdog racing the event-driven completion. Armed once
   * the execution is confirmed started (wait's semantics are pinned only for
   * that case — see the stage-6 `waitBusy` capture). "settled" means wait
   * resolved while the pump was still listening; "disarmed" means the wait
   * call failed (always internal per the phase rule) or its resolution was
   * consumed without a terminal — either way the watchdog is inert and the
   * silence watchdog remains the backstop.
   */
  waitWatchdog: Promise<void> | undefined;
  waitWatchdogState: "unarmed" | "pending" | "settled" | "disarmed";
}

/**
 * OpenCode v2 language model (AI SDK `LanguageModelV4`).
 */
export class OpencodeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  /**
   * Empty: the AI SDK downloads remote URLs to bytes before the provider
   * sees them, and the provider re-encodes as `data:` URIs — the only scheme
   * verified to reach the model end-to-end (spike Q1).
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly settings: OpencodeSettings;
  private readonly config: OpencodeLanguageModelConfig;
  private readonly logger: Logger;
  private readonly parsedProviderID: string;
  private readonly parsedModelID: string;

  private pinnedSessionId: string | undefined;
  private pinnedSessionValidated = false;
  /** Catalog-resolved model ref, cached after the first lookup. */
  private resolvedModelRef: SessionModelRef | null | undefined;
  /** approvalId → sessionId for approvals surfaced and not yet replied. */
  private readonly pendingApprovalSessions = new Map<string, string>();
  /** Approval request IDs this instance has replied to (per-session dedupe). */
  private readonly repliedApprovals = new Set<string>();
  /** Terminally handled form IDs (ported v1 dedup machinery). */
  private readonly handledFormRequests = new Set<string>();
  /** In-flight form response attempts, keyed by form ID. */
  private readonly inFlightFormRequests = new Map<string, Promise<boolean>>();
  /**
   * sessionId → the system-prompt value currently written to that session's
   * `ai-sdk.system` instruction entry. Lets a turn skip a redundant `put`
   * (which would announce another durable system message) and, when a later
   * call carries no system content, remove the entry the previous call left
   * behind instead of leaking a stale system prompt into the conversation.
   *
   * Bounded FIFO: under `createNewSession` every call binds a *new* session,
   * so an unbounded map would grow for the life of the model instance.
   * Eviction is harmless — a forgotten session just costs one redundant
   * `put` if it is ever revisited — and insertion order evicts exactly the
   * sessions `createNewSession` will never touch again.
   */
  private readonly systemEntryValues = new Map<string, string>();
  private static readonly SYSTEM_ENTRY_CACHE_LIMIT = 32;
  /**
   * Sticky feature-detection for the instruction-entry route: set to false
   * only when the server answers a `put` with "this route does not exist",
   * so one absent route does not cost a failed request on every later turn.
   */
  private instructionEntriesSupported: boolean | undefined;
  /**
   * Per-instance turn serialization: one model instance = one conversation =
   * one pinned session, and the session admits one active generation.
   * Concurrent calls queue behind the in-flight turn instead of racing
   * session creation and reading each other's events.
   */
  private turnQueue: Promise<void> = Promise.resolve();

  constructor(
    modelId: string,
    settings: OpencodeSettings | undefined,
    config: OpencodeLanguageModelConfig,
  ) {
    this.provider = config.provider ?? "opencode";
    this.modelId = modelId;
    this.config = config;

    const validated = validateSettings(
      settings,
      getLogger(settings?.logger, settings?.verbose),
    );
    this.settings = validated.value;
    this.logger = getLogger(this.settings.logger, this.settings.verbose);

    const parsed = validateModelId(modelId, this.logger);
    if (!parsed) {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    }
    this.parsedProviderID = parsed.providerID;
    this.parsedModelID = parsed.modelID;

    if (this.settings.sessionMode === "existing" || this.settings.sessionId) {
      // resolveSessionMode ignores sessionId under an explicit non-existing
      // mode (validateSettings warned about the conflict).
      if (resolveSessionMode(this.settings) === "existing") {
        this.pinnedSessionId = this.settings.sessionId;
      }
    }
  }

  /** The session this instance is pinned to, once one exists (v4 parity). */
  getSessionId(): string | undefined {
    return this.pinnedSessionId;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const release = await this.acquireTurnSlot(options.abortSignal);
    try {
      return await this.doGenerateSerialized(options);
    } finally {
      release();
    }
  }

  private async doGenerateSerialized(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const turn = await this.startTurn(options);
    const parts: LanguageModelV4StreamPart[] = [];
    try {
      await this.runPump(turn, (part) => parts.push(part));
    } finally {
      turn.subscription.abort();
    }

    const aggregated = aggregateParts(parts);
    if (aggregated.error !== undefined) {
      throw aggregated.error;
    }

    await this.reconcileGenerateResult(turn, aggregated);
    await this.repairJsonOutput(turn, aggregated);

    return {
      content: aggregated.content,
      finishReason: aggregated.finishReason,
      usage: aggregated.usage,
      ...(aggregated.providerMetadata
        ? { providerMetadata: aggregated.providerMetadata }
        : {}),
      request: { body: turn.requestBody },
      response: {
        ...(turn.receipt ? { id: turn.receipt.id } : {}),
        modelId: this.modelId,
      },
      warnings: aggregated.warnings,
    };
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const release = await this.acquireTurnSlot(options.abortSignal);
    let turn: TurnContext;
    try {
      turn = await this.startTurn(options);
    } catch (error) {
      release();
      throw error;
    }

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (controller) => {
        // close/error can themselves throw once the consumer canceled the
        // stream — swallow, the consumer is gone either way.
        void this.runPump(turn, (part) => controller.enqueue(part))
          .then(() => {
            try {
              controller.close();
            } catch {
              /* stream already canceled */
            }
          })
          .catch((error: unknown) => {
            try {
              controller.error(error);
            } catch {
              /* stream already canceled */
            }
          })
          .finally(() => {
            turn.subscription.abort();
            release();
          });
      },
      cancel: () => {
        // Consumer cancellation mid-turn: same server-side cleanup as a
        // caller abort — the execution is still running server-side.
        turn.consumerCanceled = true;
        void this.abortServerSide(turn);
        turn.subscription.abort();
      },
    });

    return { stream, request: { body: turn.requestBody } };
  }

  /**
   * Acquire the instance's single generation slot. Resolves to the release
   * function once every previously queued turn has finished. An abort while
   * queued releases this caller's slot (later callers still wait for the
   * turns queued ahead of it) and rethrows the abort reason.
   */
  private async acquireTurnSlot(
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    const previous = this.turnQueue;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turnQueue = previous.then(() => current);

    if (!signal) {
      await previous;
      return release;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(abortReason(signal) ?? new Error("Request aborted"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        previous.then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  // --- turn setup -------------------------------------------------------

  /**
   * Pre-dispatch phase plus the dispatch itself: session, subscribe +
   * readiness, then prompt or permission replies. Everything before the
   * dispatch throws pre-dispatch-wrapped errors (retryable when transient).
   */
  private async startTurn(
    options: LanguageModelV4CallOptions,
  ): Promise<TurnContext> {
    throwIfAborted(options.abortSignal);

    const warnings: SharedV4Warning[] = [];
    for (const message of logUnsupportedCallOptions(this.logger, {
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      stopSequences: options.stopSequences,
      seed: options.seed,
      maxTokens: options.maxOutputTokens,
      ...(options.reasoning !== undefined &&
      options.reasoning !== "provider-default"
        ? { reasoning: options.reasoning }
        : {}),
    })) {
      warnings.push({ type: "other", message });
    }

    if (
      (options.tools !== undefined && options.tools.length > 0) ||
      options.toolChoice !== undefined
    ) {
      const message =
        "Custom tool definitions and toolChoice are ignored: OpenCode " +
        "executes its own tools server-side, and the v2 prompt contract has " +
        "no field for caller-defined tools.";
      this.logger.warn(message);
      warnings.push({ type: "other", message });
    }

    const jsonMode = options.responseFormat?.type === "json";
    if (jsonMode) {
      warnings.push({
        type: "unsupported",
        feature: 'responseFormat: { type: "json" }',
        details:
          "OpenCode v2 has no server-side structured-output enforcement. " +
          "A JSON instruction (with the schema, when provided) is appended " +
          "to the prompt; validate the output client-side.",
      });
    }

    const providerOptions = extractProviderOptions(options);
    const headers = filterHeaders(options.headers);

    let port: OpencodeClientPort;
    try {
      port = await this.config.getPort();
    } catch (error) {
      throw wrapError(error, {
        phase: "pre-dispatch",
        operation: "getPort",
        modelId: this.modelId,
      });
    }

    const { approvals, approvalOnly } = collectPromptApprovals(options.prompt);
    const unrepliedApprovals = approvals.filter(
      (approval) => !this.repliedApprovals.has(approval.approvalId),
    );

    if (approvals.length > 0 && !approvalOnly) {
      const message =
        "Prompt mixes tool-approval responses with new user content; " +
        "approvals are replied first, then the new content is prompted " +
        '(delivery "queue" runs it after the resumed execution).';
      this.logger.warn(message);
      warnings.push({ type: "other", message });
    }

    if (approvalOnly && unrepliedApprovals.length === 0) {
      // Nothing left to reply: observing the session would hang (no reply
      // will resume it). A duplicate continuation call is a caller-side
      // retry bug — fail it clearly and non-retryably.
      throw nonRetryableError(
        "Approval-only continuation call, but every approval response in " +
          "the prompt was already replied on this session; there is nothing " +
          "to continue.",
        "permission.reply",
      );
    }

    // Session resolution. Approval-only continuation always reattaches to
    // the blocked session — createNewSession never applies to it.
    let sessionId: string;
    let freshSession = false;
    if (approvalOnly) {
      const fromPending = unrepliedApprovals
        .map((approval) =>
          this.pendingApprovalSessions.get(approval.approvalId),
        )
        .find((id) => id !== undefined);
      const resolved =
        providerOptions?.sessionId ?? fromPending ?? this.pinnedSessionId;
      if (!resolved) {
        throw nonRetryableError(
          "Approval-only continuation call without a pinned session: the " +
            "approval responses do not correspond to a session this model " +
            "instance is tracking.",
          "permission.reply",
        );
      }
      sessionId = resolved;
    } else if (providerOptions?.sessionId) {
      sessionId = providerOptions.sessionId;
    } else {
      const established = await this.establishSession(
        port,
        headers,
        options.abortSignal,
      );
      sessionId = established.sessionId;
      freshSession = established.fresh;
    }

    // Subscribe BEFORE dispatching, then complete the readiness handshake.
    const subscription = new AbortController();
    const subscribeSignal = options.abortSignal
      ? AbortSignal.any([subscription.signal, options.abortSignal])
      : subscription.signal;

    const state = createV2StreamState({
      sessionId,
      includeRawChunks: options.includeRawChunks ?? false,
      logger: this.logger,
    });
    // Approvals this instance already replied to must never resurface as
    // stale requests when the original execution's events are re-observed.
    for (const approvalId of this.repliedApprovals) {
      state.emittedApprovals.add(approvalId);
    }

    const turn: TurnContext = {
      port,
      sessionId,
      state,
      reader: undefined as unknown as EventReader,
      subscription,
      headers,
      callSignal: options.abortSignal,
      warnings,
      preBuffer: [],
      receipt: undefined,
      jsonMode,
      jsonSchema:
        options.responseFormat?.type === "json"
          ? options.responseFormat.schema
          : undefined,
      turnStartedAt: Date.now(),
      delivered: approvalOnly,
      outstandingApprovals: new Set(),
      assistantMessageIds: new Set(),
      stepClosedMessageIds: new Set(),
      requestBody: undefined,
      abortHandled: false,
      dispatchError: undefined,
      consumerCanceled: false,
      repliedApprovalIds: [],
      approvalIdleTimeoutMs:
        this.config.approvalIdleTimeoutMs ?? DEFAULT_APPROVAL_IDLE_TIMEOUT_MS,
      silenceWatchdogMs:
        this.config.silenceWatchdogMs ?? DEFAULT_SILENCE_WATCHDOG_MS,
      waitWatchdogGraceMs:
        this.config.waitWatchdogGraceMs ?? DEFAULT_WAIT_WATCHDOG_GRACE_MS,
      deliveryEvidenceWindowMs:
        this.config.deliveryEvidenceWindowMs ??
        DEFAULT_DELIVERY_EVIDENCE_WINDOW_MS,
      waitWatchdog: undefined,
      waitWatchdogState: "unarmed",
    };
    state.onForm = (form) => {
      void this.handleFormRequest(turn, form).catch((error: unknown) => {
        this.logger.warn(
          `Form handling failed unexpectedly: ${extractErrorMessage(error)}`,
        );
      });
    };

    try {
      const iterable = turn.port.event.subscribe(
        this.requestOptions(headers, subscribeSignal),
      );
      turn.reader = createEventReader(iterable);
      await this.awaitReadiness(turn);
    } catch (error) {
      subscription.abort();
      throw wrapError(error, {
        phase: "pre-dispatch",
        operation: "event.subscribe",
        sessionId,
        modelId: this.modelId,
      });
    }

    throwIfAborted(options.abortSignal);

    // Dispatch. From the first attempted send onward, nothing may surface
    // as retryable (the universal phase rule).
    try {
      if (unrepliedApprovals.length > 0) {
        await this.dispatchApprovalReplies(turn, unrepliedApprovals);
      }
      if (!approvalOnly) {
        await this.dispatchPrompt(turn, options, providerOptions, {
          freshSession,
          jsonMode,
          schema:
            options.responseFormat?.type === "json"
              ? options.responseFormat.schema
              : undefined,
        });
      }
    } catch (error) {
      if (options.abortSignal?.aborted) {
        // The signal fired mid-dispatch: the request may still have reached
        // the server, and a listener registered now would never fire.
        void this.abortServerSide(turn);
        subscription.abort();
        throw abortReason(options.abortSignal) ?? asError(error);
      }
      if (error instanceof Error && needsSessionReconciliation(error)) {
        // Uncertain delivery (post-dispatch, reconcile-marked): keep the
        // subscription alive and let the pump reconcile through the pinned
        // session's state instead of losing the observer.
        turn.dispatchError = error;
      } else {
        subscription.abort();
        throw error;
      }
    }

    this.registerAbortCleanup(turn);
    return turn;
  }

  /** Resolve (and pin) the session for an ordinary generation call. */
  private async establishSession(
    port: OpencodeClientPort,
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ sessionId: string; fresh: boolean }> {
    const mode = resolveSessionMode(this.settings);
    const requestOptions = this.requestOptions(headers, signal);

    if (mode === "existing") {
      const sessionId = this.settings.sessionId!;
      if (!this.pinnedSessionValidated) {
        try {
          await port.session.get({ sessionID: sessionId }, requestOptions);
        } catch (error) {
          throw wrapError(error, {
            phase: "pre-dispatch",
            operation: "session.get",
            sessionId,
            modelId: this.modelId,
          });
        }
        this.pinnedSessionValidated = true;
      }
      this.pinnedSessionId = sessionId;
      return { sessionId, fresh: false };
    }

    if (!this.settings.createNewSession && this.pinnedSessionId) {
      return { sessionId: this.pinnedSessionId, fresh: false };
    }

    const model = await this.resolveModelRef(port, requestOptions);
    const location = resolveSessionLocation(this.settings);
    try {
      const session = await port.session.create(
        {
          title: this.settings.sessionTitle ?? DEFAULT_SESSION_TITLE,
          ...(this.settings.agent ? { agent: this.settings.agent } : {}),
          ...(model ? { model } : {}),
          ...(location ? { location } : {}),
        },
        requestOptions,
      );
      // Always pin the newly created session: approval continuation must be
      // able to reattach even under createNewSession per-call isolation.
      this.pinnedSessionId = session.id;
      return { sessionId: session.id, fresh: true };
    } catch (error) {
      throw wrapError(error, {
        phase: "pre-dispatch",
        operation: "session.create",
        modelId: this.modelId,
      });
    }
  }

  /**
   * Resolve the `session.create` model ref.
   * - "providerID/modelID" → full ref (plus settings.variant).
   * - bare "modelID" without variant → omit the ref (server/session default).
   * - bare "modelID" WITH variant → the ref cannot be omitted (variant rides
   *   `ModelRef`), so the providerID is resolved via the catalog; ambiguity
   *   or absence rejects.
   */
  private async resolveModelRef(
    port: OpencodeClientPort,
    requestOptions: OpencodeRequestOptions,
  ): Promise<SessionModelRef | undefined> {
    if (this.resolvedModelRef !== undefined) {
      return this.resolvedModelRef ?? undefined;
    }

    const variant = this.settings.variant;
    if (this.parsedProviderID) {
      this.resolvedModelRef = {
        id: this.parsedModelID,
        providerID: this.parsedProviderID,
        ...(variant ? { variant } : {}),
      };
      return this.resolvedModelRef;
    }
    if (!variant) {
      this.resolvedModelRef = null;
      return undefined;
    }

    const location = resolveSessionLocation(this.settings);
    let catalog;
    try {
      catalog = await port.model.list(
        location
          ? {
              location: {
                directory: location.directory,
                ...(location.workspaceID !== undefined
                  ? { workspace: location.workspaceID }
                  : {}),
              },
            }
          : undefined,
        requestOptions,
      );
    } catch (error) {
      throw wrapError(error, {
        phase: "pre-dispatch",
        operation: "model.list",
        modelId: this.modelId,
      });
    }

    const matches = catalog.data.filter(
      (model) =>
        model.modelID === this.parsedModelID || model.id === this.parsedModelID,
    );
    const providerIds = [...new Set(matches.map((model) => model.providerID))];
    if (providerIds.length !== 1) {
      throw nonRetryableError(
        providerIds.length === 0
          ? `Model "${this.parsedModelID}" with variant "${variant}" was not ` +
              "found in the catalog; a bare model ID with a variant needs a " +
              'resolvable provider. Use "providerID/modelID".'
          : `Model "${this.parsedModelID}" with variant "${variant}" is ` +
              `offered by multiple providers (${providerIds.join(", ")}); ` +
              'disambiguate with "providerID/modelID".',
        "model.list",
      );
    }
    this.resolvedModelRef = {
      id: matches[0]!.modelID,
      providerID: providerIds[0]!,
      variant,
    };
    return this.resolvedModelRef;
  }

  /** Readiness handshake: wait (bounded) for `server.connected`. */
  private async awaitReadiness(turn: TurnContext): Promise<void> {
    const timeoutMs =
      this.config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.logger.warn(
          "Event-stream readiness handshake timed out waiting for " +
            "server.connected; proceeding (the subscription may lag the prompt).",
        );
        return;
      }
      const result = await turn.reader.nextWithTimeout(remaining);
      if (result === "timeout") {
        this.logger.warn(
          "Event-stream readiness handshake timed out waiting for " +
            "server.connected; proceeding (the subscription may lag the prompt).",
        );
        return;
      }
      if (result.done) {
        // A stream that closes before server.connected is a broken
        // subscription — surfaced pre-dispatch by the caller's wrap.
        throw new Error(
          "OpenCode event stream closed before the readiness handshake completed",
        );
      }
      if (result.value.type === "server.connected") {
        return;
      }
      // Pre-dispatch noise (other sessions, catalog events): keep it for the
      // pump so nothing observed is dropped.
      turn.preBuffer.push(result.value);
    }
  }

  /** Phase-2 dispatch: reply the prompt-carried approval decisions. */
  private async dispatchApprovalReplies(
    turn: TurnContext,
    approvals: PromptApprovalResponse[],
  ): Promise<void> {
    let dispatched = false;
    for (const approval of approvals) {
      // Each reply targets the session its approval actually belongs to —
      // NOT necessarily the turn's session: a mixed prompt (approvals + new
      // user content) under createNewSession or an escape-hatch sessionId
      // runs the prompt on a different session than the blocked one.
      const approvalSessionId =
        this.pendingApprovalSessions.get(approval.approvalId) ??
        this.pinnedSessionId ??
        turn.sessionId;
      try {
        await turn.port.permission.reply(
          {
            sessionID: approvalSessionId,
            requestID: approval.approvalId,
            reply: approval.approved ? "once" : "reject",
            ...(approval.reason !== undefined
              ? { message: approval.reason }
              : {}),
          },
          this.requestOptions(turn.headers, turn.callSignal),
        );
      } catch (error) {
        if (isTaggedError(error) && error._tag === "PermissionNotFoundError") {
          // Already settled (saved rule, another client, an earlier retry):
          // not an error for the continuation.
          this.logger.warn(
            `Approval ${approval.approvalId} no longer exists on session ` +
              `${approvalSessionId}; assuming it was already replied.`,
          );
        } else {
          // First-reply tagged errors are definitive server verdicts
          // (pre-dispatch); anything after a successful reply — or with
          // uncertain delivery — is post-dispatch by the universal rule.
          throw wrapError(error, {
            phase:
              dispatched || !isTaggedError(error)
                ? "post-dispatch"
                : "pre-dispatch",
            operation: "permission.reply",
            sessionId: turn.sessionId,
            modelId: this.modelId,
          });
        }
      }
      dispatched = true;
      turn.delivered = true;
      turn.repliedApprovalIds.push(approval.approvalId);
      this.repliedApprovals.add(approval.approvalId);
      // Also mark it in THIS turn's reducer state: a redelivered
      // permission.asked for a just-replied approval must not resurface.
      turn.state.emittedApprovals.add(approval.approvalId);
      this.pendingApprovalSessions.delete(approval.approvalId);
    }
  }

  /**
   * Reconcile this turn's system content with the session's `ai-sdk.system`
   * instruction entry.
   *
   * The entry is the real system-prompt channel: it renders as a
   * `<context key="ai-sdk.system">…</context>` block into the instruction
   * baseline after the agent's own system prompt, and is re-rendered on
   * every turn — so unlike the v4-era prepend it works on reused sessions
   * too (verified live; see `src/system-instruction.ts`).
   *
   * Reconciliation, not blind writing:
   *   - value unchanged since the last turn → no request, because a
   *     redundant `put` announces another durable system message,
   *   - system content dropped by this call → `remove`, so a previous
   *     call's system prompt cannot leak into later turns,
   *   - route or client missing, value over the cap, or the write fails →
   *     report why, and the caller degrades to the delimited prepend.
   *
   * Returns `{viaEntry: true}` when the session's entry state now matches
   * this turn (including the "nothing to do" cases).
   */
  private async applySystemInstruction(
    turn: TurnContext,
    systemText: string | undefined,
  ): Promise<{ viaEntry: boolean; reason: string }> {
    const previous = this.systemEntryValues.get(turn.sessionId);
    if (systemText === previous) {
      return { viaEntry: true, reason: "unchanged" };
    }

    const entries = turn.port.session.instructions?.entry;
    if (entries === undefined || this.instructionEntriesSupported === false) {
      return {
        viaEntry: false,
        reason: "the server does not expose session instruction entries",
      };
    }

    const requestOptions = this.requestOptions(turn.headers, turn.callSignal);

    // System content withdrawn: clear what a previous call left behind.
    if (systemText === undefined) {
      try {
        await entries.remove(
          { sessionID: turn.sessionId, key: SYSTEM_INSTRUCTION_KEY },
          requestOptions,
        );
        this.systemEntryValues.delete(turn.sessionId);
      } catch (error) {
        // Non-fatal: the stale entry stays, but this call carries no system
        // content of its own, so there is nothing to degrade to a prepend.
        this.logger.warn(
          `Failed to clear the system instruction entry on session ` +
            `${turn.sessionId}: ${extractErrorMessage(error)}`,
        );
      }
      return { viaEntry: true, reason: "cleared" };
    }

    if (!fitsInstructionValue(systemText)) {
      return {
        viaEntry: false,
        reason:
          `the system prompt is ${instructionValueBytes(systemText)} bytes ` +
          `and the server caps an instruction entry at ` +
          `${INSTRUCTION_VALUE_MAX_BYTES}`,
      };
    }

    try {
      await entries.put(
        {
          sessionID: turn.sessionId,
          key: SYSTEM_INSTRUCTION_KEY,
          value: systemText,
        },
        requestOptions,
      );
      this.instructionEntriesSupported = true;
      this.rememberSystemEntry(turn.sessionId, systemText);
      return { viaEntry: true, reason: "written" };
    } catch (error) {
      // Only an explicitly absent route earns the sticky disable. Any other
      // failure (transport blip, busy session, unknown status) gets retried
      // on the next turn rather than silently downgrading the whole
      // conversation to prepends.
      if (isMissingRouteError(error)) {
        this.instructionEntriesSupported = false;
      }
      return {
        viaEntry: false,
        reason: `the write failed: ${extractErrorMessage(error)}`,
      };
    }
  }

  /** Record a written entry value, evicting the oldest session when full. */
  private rememberSystemEntry(sessionId: string, value: string): void {
    this.systemEntryValues.delete(sessionId);
    this.systemEntryValues.set(sessionId, value);
    while (
      this.systemEntryValues.size >
      OpencodeLanguageModel.SYSTEM_ENTRY_CACHE_LIMIT
    ) {
      const oldest = this.systemEntryValues.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.systemEntryValues.delete(oldest.value);
    }
  }

  /** Ordinary dispatch: convert the prompt and send it (busy → queue retry). */
  private async dispatchPrompt(
    turn: TurnContext,
    options: LanguageModelV4CallOptions,
    providerOptions: OpencodeProviderOptions | undefined,
    flags: { freshSession: boolean; jsonMode: boolean; schema?: unknown },
  ): Promise<void> {
    const conversion = await convertToOpencodePrompt(options.prompt, {
      sessionMode: flags.freshSession ? "ephemeral" : "persistent",
      ...(this.settings.resolveFileToUri
        ? { resolveFileToUri: this.settings.resolveFileToUri }
        : {}),
      ...(flags.jsonMode ? { jsonMode: { schema: flags.schema } } : {}),
      logger: this.logger,
    });
    for (const warning of conversion.warnings) {
      turn.warnings.push({ type: "other", message: warning });
    }

    let text = conversion.text;
    const systemParts = [
      ...(this.settings.systemPrompt ? [this.settings.systemPrompt] : []),
      ...(conversion.systemBlock !== undefined ? [conversion.systemBlock] : []),
    ];
    const systemText =
      systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
    const applied = await this.applySystemInstruction(turn, systemText);
    if (!applied.viaEntry && systemText !== undefined) {
      // Fallback: no instruction-entry channel, so degrade to the delimited
      // prepend. On a reused session the prepend still reaches the model as
      // ordinary user text — worse than a system entry, but not nothing.
      text = prependSystemBlock(text, systemText);
      turn.warnings.push({
        type: "unsupported",
        feature: "system prompt",
        details:
          `System content could not be written as a session instruction ` +
          `entry (${applied.reason}); it was prepended to this turn's text ` +
          `as a delimited block instead (system-role priority is lost).`,
      });
    }

    const promptInput: SessionPromptInput = {
      sessionID: turn.sessionId,
      text,
      ...(conversion.files.length > 0 ? { files: conversion.files } : {}),
      ...(providerOptions?.id !== undefined ? { id: providerOptions.id } : {}),
      // Always sent explicitly: the provider default is "queue" while the
      // observed server default is "steer" (documented divergence).
      delivery: this.settings.delivery ?? "queue",
      ...(this.settings.resume !== undefined
        ? { resume: this.settings.resume }
        : {}),
    };
    turn.requestBody = promptInput;

    const requestOptions = this.requestOptions(turn.headers, turn.callSignal);
    try {
      turn.receipt = await turn.port.session.prompt(
        promptInput,
        requestOptions,
      );
    } catch (error) {
      // Busy-session detection: the prompt route's declared thrown union
      // carries `ConflictError` (409) for a busy session — `SessionBusyError`
      // is declared only on other routes but kept here defensively (spike
      // Q3: the dev OpenAPI declares 409 ConflictError on v2.session.prompt).
      // The retry runs even when the original delivery was already "queue":
      // a busy rejection under queue is a transient race worth one more try.
      if (isPromptBusyError(error)) {
        this.logger.warn(
          `Session ${turn.sessionId} is busy; retrying the prompt once with ` +
            'delivery "queue".',
        );
        try {
          turn.receipt = await turn.port.session.prompt(
            { ...promptInput, delivery: "queue" },
            requestOptions,
          );
        } catch (retryError) {
          throw this.wrapPromptError(retryError, turn);
        }
      } else {
        throw this.wrapPromptError(error, turn);
      }
    }
  }

  /**
   * Prompt-failure classification. A busy rejection (`ConflictError` /
   * `SessionBusyError`) that survives the queue retry is surfaced
   * non-retryable (an AI SDK retry would just race the same busy session).
   * Other tagged errors are definitive pre-dispatch rejections;
   * transport-class failures have uncertain delivery and follow the
   * post-dispatch rule.
   */
  private wrapPromptError(error: unknown, turn: TurnContext): Error {
    if (isPromptBusyError(error)) {
      return new APICallError({
        message:
          `OpenCode session ${turn.sessionId} is busy and the "queue" ` +
          "delivery retry was rejected; the session has a conflicting " +
          "in-flight turn.",
        url: "opencode://session.prompt",
        requestBodyValues: {},
        isRetryable: false,
        data: {
          phase: "pre-dispatch",
          reconcile: false,
          errorTag: (error as { _tag: string })._tag,
          operation: "session.prompt",
          sessionId: turn.sessionId,
          modelId: this.modelId,
        } satisfies OpencodeErrorData,
        cause: error,
      });
    }
    return wrapError(error, {
      phase: isTaggedError(error) ? "pre-dispatch" : "post-dispatch",
      operation: "session.prompt",
      sessionId: turn.sessionId,
      modelId: this.modelId,
    });
  }

  // --- event pump -------------------------------------------------------

  /**
   * Drive the reducer to completion. Emits `stream-start` and
   * `response-metadata` first, then reduced parts. Resolves when the finish
   * part has been emitted. Rejects only for caller aborts; internal failures
   * degrade to an `error` part + finalize.
   */
  private async runPump(
    turn: TurnContext,
    emit: (part: LanguageModelV4StreamPart) => void,
  ): Promise<void> {
    emit({ type: "stream-start", warnings: turn.warnings });
    emit({
      type: "response-metadata",
      ...(turn.receipt ? { id: turn.receipt.id } : {}),
      modelId: this.modelId,
    });

    const push = (parts: LanguageModelV4StreamPart[]): void => {
      for (const part of parts) {
        emit(this.postProcessPart(turn, part));
      }
    };

    try {
      if (turn.dispatchError) {
        // Dispatch-time failure with uncertain delivery: first check the
        // inbox — the prompt may have been enqueued despite the failed
        // response, in which case the turn is running and the pump just
        // keeps observing it. Otherwise reconcile through the session
        // instead of surfacing (or losing the observer).
        if (await this.recoverUncertainDelivery(turn)) {
          turn.dispatchError = undefined;
        } else {
          await this.recoverPumpFailure(turn, turn.dispatchError, push);
          return;
        }
      }

      for (const buffered of turn.preBuffer) {
        this.observeEvent(turn, buffered, push);
        if (turn.state.finishEmitted) {
          return;
        }
      }
      turn.preBuffer = [];

      // Approval quiescence uses a deadline that only THIS session's events
      // reset — the subscription is server-global, and unrelated sessions'
      // activity must not starve the phase-1 finish.
      let quiescenceDeadline: number | undefined;
      while (!turn.state.finishEmitted) {
        let result: IteratorResult<V2Event> | "timeout";
        if (turn.outstandingApprovals.size > 0) {
          quiescenceDeadline ??= Date.now() + turn.approvalIdleTimeoutMs;
          const remaining = quiescenceDeadline - Date.now();
          result =
            remaining > 0
              ? await turn.reader.nextWithTimeout(remaining)
              : "timeout";
          if (result === "timeout") {
            // Approval quiescence: the execution is blocked awaiting the
            // reply. Surface the blocked turn to the caller (phase 1).
            push(finalizeV2Stream(turn.state));
            return;
          }
        } else {
          quiescenceDeadline = undefined;
          // session.wait watchdog resolved while events show no terminal:
          // drain a grace window, then reconcile from the message store.
          if (turn.waitWatchdogState === "settled") {
            const settled = await this.reconcileAfterWaitSettled(turn, push);
            if (settled || turn.state.finishEmitted) {
              return;
            }
            continue;
          }
          // Never wait unboundedly: an SSE connection that silently lost
          // the terminal/idle events would hang the call forever. On
          // silence, probe the session for a lost signal. A pending
          // session.wait watchdog interrupts the read early (handled at the
          // top of the loop).
          result = await turn.reader.nextWithTimeout(
            turn.silenceWatchdogMs,
            turn.waitWatchdogState === "pending"
              ? turn.waitWatchdog
              : undefined,
          );
          if (result === "timeout") {
            // Cast: the watchdog may have flipped to "settled" during the
            // await, which TS's narrowing from the pre-read check misses.
            const watchdogState =
              turn.waitWatchdogState as TurnContext["waitWatchdogState"];
            if (watchdogState === "settled") {
              continue;
            }
            const settled = await this.probeSilentTurn(turn, push);
            if (settled || turn.state.finishEmitted) {
              return;
            }
            continue;
          }
        }
        if (result.done) {
          push(finalizeV2Stream(turn.state));
          return;
        }
        if (this.observeEvent(turn, result.value, push)) {
          quiescenceDeadline = undefined;
        }
      }
    } catch (error) {
      if (turn.consumerCanceled) {
        // The doStream consumer canceled: nobody is listening, server-side
        // cleanup already ran from cancel(). End quietly.
        return;
      }
      if (isAbortError(error) || turn.callSignal?.aborted) {
        throw abortReason(turn.callSignal) ?? error;
      }
      await this.recoverPumpFailure(turn, error, push);
    }
  }

  /**
   * Feed one event through orchestration tracking and the reducer.
   * Returns true when the event belongs to this turn's session.
   */
  private observeEvent(
    turn: TurnContext,
    event: V2Event,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): boolean {
    const sessionMatches = extractV2EventSessionId(event) === turn.sessionId;
    if (sessionMatches) {
      switch (event.type) {
        case "session.inbox.delivered":
          if (turn.receipt && event.data.inboxID === turn.receipt.id) {
            turn.delivered = true;
          }
          break;
        case "session.execution.started":
          turn.delivered = true;
          this.armWaitWatchdog(turn);
          break;
        case "session.step.started":
          turn.delivered = true;
          turn.assistantMessageIds.add(event.data.assistantMessageID);
          break;
        case "session.step.ended":
        case "session.step.failed":
          turn.stepClosedMessageIds.add(event.data.assistantMessageID);
          break;
        case "permission.replied":
          turn.outstandingApprovals.delete(event.data.requestID);
          this.pendingApprovalSessions.delete(event.data.requestID);
          break;
        default:
          break;
      }
    }

    push(convertV2EventToStreamParts(event, turn.state));

    if (
      sessionMatches &&
      event.type === "session.idle" &&
      !turn.state.finishEmitted
    ) {
      // Hang-prevention backstop: idle without a terminal execution event.
      push(finalizeV2Stream(turn.state));
    }
    return sessionMatches;
  }

  /**
   * Approval bookkeeping and finish-metadata enrichment on emitted parts.
   */
  private postProcessPart(
    turn: TurnContext,
    part: LanguageModelV4StreamPart,
  ): LanguageModelV4StreamPart {
    if (part.type === "tool-approval-request") {
      turn.outstandingApprovals.add(part.approvalId);
      this.pendingApprovalSessions.set(part.approvalId, turn.sessionId);
      return part;
    }
    if (part.type === "finish") {
      const opencode: Record<string, JSONValue> = {
        ...((part.providerMetadata?.["opencode"] ?? {}) as Record<
          string,
          JSONValue
        >),
        ...(turn.receipt ? { inboxId: turn.receipt.id } : {}),
      };
      const outstanding = [...turn.outstandingApprovals];
      if (outstanding.length > 0) {
        opencode["approvalRequestId"] = outstanding[0]!;
        opencode["approvalRequestIds"] = outstanding;
      }
      if (turn.repliedApprovalIds.length > 0) {
        opencode["repliedApprovalIds"] = [...turn.repliedApprovalIds];
      }
      if (turn.state.handledForms.size > 0) {
        opencode["formIds"] = [...turn.state.handledForms];
      }
      return { ...part, providerMetadata: { opencode } };
    }
    return part;
  }

  /**
   * Delivery-uncertainty check after a reconcile-marked `session.prompt`
   * failure: one bounded `session.inbox.list` attempt to learn whether the
   * prompt was enqueued despite the failed response. A matching pending
   * user item (by caller-supplied id when one was sent, else by exact text)
   * is adopted as this turn's receipt and the pump keeps observing the
   * running turn.
   *
   * The inbox table is pending-only on the pinned beta (`projectDelivered`
   * deletes the row in the same transaction that promotes it), so an empty
   * list does NOT prove non-delivery: an idle session picks the prompt up
   * immediately, and the row can be gone before this check runs. A miss —
   * or the check itself failing/timing out — therefore falls through to
   * {@link awaitDeliveryEvidence} before the reconciliation/error path.
   */
  private async recoverUncertainDelivery(turn: TurnContext): Promise<boolean> {
    const error = turn.dispatchError;
    const data =
      error !== undefined && APICallError.isInstance(error)
        ? (error.data as OpencodeErrorData | undefined)
        : undefined;
    if (data?.operation !== "session.prompt" || turn.receipt !== undefined) {
      return false;
    }
    const body = turn.requestBody as SessionPromptInput | undefined;
    if (!body) {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const listPromise = turn.port.session.inbox.list(
        { sessionID: turn.sessionId },
        this.requestOptions(turn.headers, undefined),
      );
      // A rejection after the timeout won the race must not surface as an
      // unhandled rejection.
      listPromise.catch(() => undefined);
      const items = await Promise.race([
        listPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("inbox delivery check timed out")),
            INBOX_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      // Text-match caveat (documented): with no caller-supplied prompt id
      // there is no delivery key, so an identical-text pending item from
      // another client on a shared session could be misattributed. The
      // provider's exclusive-session contract makes that the same caveat
      // the rest of the turn correlation already carries.
      const match = items.find(
        (item): item is SessionInboxUser =>
          item.type === "user" &&
          (body.id !== undefined
            ? item.id === body.id
            : item.payload.text === body.text),
      );
      if (match) {
        this.logger.warn(
          `session.prompt failed but the prompt is enqueued on session ` +
            `${turn.sessionId} (inbox ${match.id}); continuing to observe the turn.`,
        );
        turn.receipt = match;
        return true;
      }
    } catch (checkError) {
      this.logger.debug?.(
        `inbox delivery check unavailable: ${extractErrorMessage(checkError)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return this.awaitDeliveryEvidence(turn);
  }

  /**
   * Delivered-before-check recovery: no pending inbox row was found, but the
   * prompt may already have been delivered (the pending row is deleted at
   * promotion). Delivery proof is available on the live subscription — the
   * pump subscribed before dispatching, so `session.inbox.delivered` /
   * `session.execution.started` / step and content events for this turn land
   * in the pre-buffer or the reader. Scan the pre-buffer, then drain the
   * reader for a bounded window; every drained event is appended to the
   * pre-buffer so the pump replays it normally. Evidence found → the turn is
   * enqueued-and-running and stays observed. No evidence — or a broken
   * stream — falls back to the reconciliation/error path.
   */
  private async awaitDeliveryEvidence(turn: TurnContext): Promise<boolean> {
    const adopt = (event: V2Event): true => {
      this.logger.warn(
        `session.prompt failed but session ${turn.sessionId} shows live ` +
          `turn activity (${event.type}); continuing to observe the turn.`,
      );
      return true;
    };
    for (const buffered of turn.preBuffer) {
      if (isDeliveryEvidence(buffered, turn.sessionId)) {
        return adopt(buffered);
      }
    }
    const deadline = Date.now() + turn.deliveryEvidenceWindowMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      let result: IteratorResult<V2Event> | "timeout";
      try {
        result = await turn.reader.nextWithTimeout(remaining);
      } catch {
        // Broken stream: no live evidence obtainable — the message-store
        // fallback is the remaining recovery path.
        return false;
      }
      if (result === "timeout" || result.done) {
        return false;
      }
      turn.preBuffer.push(result.value);
      if (isDeliveryEvidence(result.value, turn.sessionId)) {
        return adopt(result.value);
      }
    }
  }

  /**
   * Post-dispatch pump failure. Transient-class failures (the stage-3
   * reconcile marker) are reconciled internally against the session's
   * message state; anything else — and a failed reconciliation — degrades to
   * an `error` part plus an error finish. Never a retryable surface error.
   */
  private async recoverPumpFailure(
    turn: TurnContext,
    error: unknown,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): Promise<void> {
    const wrapped = wrapError(error, {
      phase: "post-dispatch",
      operation: "event.subscribe",
      sessionId: turn.sessionId,
      modelId: this.modelId,
    });

    if (needsSessionReconciliation(wrapped)) {
      this.logger.warn(
        `Event stream failed mid-turn (${extractErrorMessage(error)}); ` +
          `reconciling session ${turn.sessionId} from its message state.`,
      );
      try {
        const outcome = await this.reconcileFromMessages(turn, push);
        if (
          outcome.blocked ||
          outcome.messages > 0 ||
          turn.state.stepCount > 0
        ) {
          if (!turn.state.finishEmitted) {
            push(finalizeV2Stream(turn.state));
          }
          return;
        }
        // Nothing observed, nothing stored, no pending interaction: the
        // failure stands — an empty "success" would mask a lost turn.
      } catch (reconcileError) {
        this.logger.warn(
          `Session reconciliation failed: ${extractErrorMessage(reconcileError)}`,
        );
      }
    }

    if (!turn.state.finishEmitted) {
      push([{ type: "error", error: wrapped }]);
      push(finalizeV2Stream(turn.state, { unified: "error", raw: undefined }));
    }
  }

  /**
   * Internal reconciliation: surface interactions the stream may have lost
   * (permission/form events are live-only — they never reach the durable
   * log, so a blocked session has no terminal event to find), then wait for
   * the session to settle (bounded, best-effort), fetch its messages, and
   * replay this turn's assistant messages through the reducer as synthesized
   * terminal events. Already-streamed content reduces to nothing (the
   * reducer is idempotent); missed content arrives as whole blocks.
   */
  private async reconcileFromMessages(
    turn: TurnContext,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): Promise<{ blocked: boolean; messages: number }> {
    await this.surfacePendingInteractions(turn, push);
    if (turn.outstandingApprovals.size > 0) {
      // The session is blocked on an approval: finalize as a phase-1 result
      // (the caller's finalize surfaces the approval) — waiting would
      // deadlock, the execution cannot settle until the reply.
      return { blocked: true, messages: 0 };
    }

    await this.waitBounded(turn, turn.silenceWatchdogMs);

    const messages = await this.fetchTurnMessages(turn);
    this.replayStoredMessages(turn, messages, push);
    return { blocked: false, messages: messages.length };
  }

  /**
   * Poll `permission.list`/`form.list` for pending interactions this turn's
   * event stream never delivered, and feed them through the reducer as
   * synthesized events (its ID-based dedup makes re-observation a no-op).
   * Best-effort: listing failures are logged and ignored.
   */
  private async surfacePendingInteractions(
    turn: TurnContext,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): Promise<void> {
    const requestOptions = this.requestOptions(turn.headers, undefined);
    try {
      const permissions = await turn.port.permission.list(
        { sessionID: turn.sessionId },
        requestOptions,
      );
      for (const request of permissions) {
        push(
          convertV2EventToStreamParts(
            synthesizePermissionAskedEvent(request),
            turn.state,
          ),
        );
      }
    } catch (listError) {
      this.logger.debug?.(
        `permission.list unavailable during recovery: ${extractErrorMessage(listError)}`,
      );
    }
    try {
      const forms = await turn.port.form.list(
        { sessionID: turn.sessionId },
        requestOptions,
      );
      for (const form of forms) {
        push(
          convertV2EventToStreamParts(
            synthesizeFormCreatedEvent(form),
            turn.state,
          ),
        );
      }
    } catch (listError) {
      this.logger.debug?.(
        `form.list unavailable during recovery: ${extractErrorMessage(listError)}`,
      );
    }
  }

  /**
   * Bounded `session.wait`: resolves "settled" when the session went idle,
   * "unavailable" when the route failed (current builds 503 it), "timeout"
   * when the bound elapsed first (the execution is plausibly still running).
   * Never rejects and never leaves an unhandled rejection behind.
   */
  private async waitBounded(
    turn: TurnContext,
    boundMs: number,
  ): Promise<"settled" | "unavailable" | "timeout"> {
    // The dangling request (on timeout) is tied to the subscription's
    // teardown, never to the (possibly aborted) call signal.
    const signal = turn.subscription.signal.aborted
      ? undefined
      : turn.subscription.signal;
    const wait = turn.port.session.wait(
      { sessionID: turn.sessionId },
      this.requestOptions(turn.headers, signal),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      wait.then(
        () => "settled" as const,
        (waitError: unknown) => {
          this.logger.debug?.(
            `session.wait unavailable during recovery: ${extractErrorMessage(waitError)}`,
          );
          return "unavailable" as const;
        },
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), boundMs);
      }),
    ]);
    clearTimeout(timer);
    return outcome;
  }

  /**
   * Arm the `session.wait` watchdog for this turn — once, and only after the
   * execution is confirmed started (the one case whose wait semantics the
   * stage-6 capture pinned; steer/queue/interrupt behavior is unpinned
   * upstream). The wait rides the subscription's lifetime, so turn teardown
   * aborts it. Resolution only flips state the pump inspects — completion
   * stays event-driven. A wait failure is internal by the phase rule: log at
   * debug and disarm (the silence watchdog remains the backstop); never a
   * surfaced or retryable error.
   */
  private armWaitWatchdog(turn: TurnContext): void {
    if (turn.waitWatchdogState !== "unarmed" || turn.state.finishEmitted) {
      return;
    }
    turn.waitWatchdogState = "pending";
    turn.waitWatchdog = new Promise<void>((resolve) => {
      turn.port.session
        .wait(
          { sessionID: turn.sessionId },
          this.requestOptions(turn.headers, turn.subscription.signal),
        )
        .then(
          () => {
            if (turn.waitWatchdogState === "pending") {
              turn.waitWatchdogState = "settled";
              resolve();
            }
          },
          (waitError: unknown) => {
            // Failure never resolves the interrupt: the pump keeps its full
            // silence-watchdog cadence instead of probing early.
            if (turn.waitWatchdogState === "pending") {
              turn.waitWatchdogState = "disarmed";
            }
            if (!isAbortError(waitError)) {
              this.logger.debug?.(
                `session.wait watchdog unavailable: ${extractErrorMessage(waitError)}`,
              );
            }
          },
        );
    });
  }

  /**
   * The `session.wait` watchdog resolved while the event stream shows no
   * terminal. Events stay primary: drain the stream for a grace window (the
   * terminal usually trails wait by milliseconds), then reconcile from the
   * message store — finalizing only on stored proof the turn concluded,
   * never completion-by-wait. Returns true when the turn was finalized;
   * false disarms the watchdog and keeps the pump listening.
   */
  private async reconcileAfterWaitSettled(
    turn: TurnContext,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): Promise<boolean> {
    const deadline = Date.now() + turn.waitWatchdogGraceMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const result = await turn.reader.nextWithTimeout(remaining);
      if (result === "timeout") {
        break;
      }
      if (result.done) {
        push(finalizeV2Stream(turn.state));
        return true;
      }
      this.observeEvent(turn, result.value, push);
      if (turn.state.finishEmitted) {
        return true;
      }
    }

    turn.waitWatchdogState = "disarmed";
    try {
      const messages = await this.fetchTurnMessages(turn);
      const last = messages[messages.length - 1];
      const concluded =
        last !== undefined &&
        (last.error !== undefined ||
          (last.finish !== undefined &&
            last.finish !== "tool-calls" &&
            last.finish !== "unknown"));
      if (!concluded) {
        this.logger.warn(
          `session.wait resolved for session ${turn.sessionId} but neither ` +
            "the event stream nor the message store shows a terminal; " +
            "continuing to observe events.",
        );
        return false;
      }
      this.logger.warn(
        `session.wait watchdog: session ${turn.sessionId} settled but the ` +
          "event stream showed no terminal; finalizing from the message store.",
      );
      this.replayStoredMessages(turn, messages, push);
      if (!turn.state.finishEmitted) {
        push(finalizeV2Stream(turn.state));
      }
      return true;
    } catch (probeError) {
      this.logger.debug?.(
        `Wait-watchdog reconciliation failed: ${extractErrorMessage(probeError)}`,
      );
      return false;
    }
  }

  /** This turn's stored assistant messages, in creation order. */
  private async fetchTurnMessages(
    turn: TurnContext,
  ): Promise<SessionMessageAssistant[]> {
    const response = await turn.port.message.list(
      { sessionID: turn.sessionId, order: "asc" },
      this.requestOptions(turn.headers, undefined),
    );
    return selectTurnAssistantMessages(response.data, turn);
  }

  /** Replay stored messages through the reducer as synthesized events. */
  private replayStoredMessages(
    turn: TurnContext,
    messages: SessionMessageAssistant[],
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): void {
    const events = synthesizeReconciliationEvents(messages, turn);
    for (const event of events) {
      push(convertV2EventToStreamParts(event, turn.state));
      if (turn.state.finishEmitted) {
        break;
      }
    }
  }

  /**
   * Silence-watchdog probe: the stream produced nothing for the watchdog
   * interval. Check for a lost blocked-state signal (pending
   * permission/form) or a lost terminal (session settled, terminal event
   * never arrived). Returns true when the turn was finalized; false keeps
   * the pump listening (the execution is plausibly still running). Never
   * throws.
   */
  private async probeSilentTurn(
    turn: TurnContext,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): Promise<boolean> {
    try {
      await this.surfacePendingInteractions(turn, push);
      if (turn.state.finishEmitted) {
        return true;
      }
      if (turn.outstandingApprovals.size > 0) {
        // Blocked on an approval the stream never delivered: phase-1 finish.
        push(finalizeV2Stream(turn.state));
        return true;
      }

      const outcome = await this.waitBounded(turn, turn.silenceWatchdogMs);
      if (outcome === "timeout") {
        return false;
      }
      const messages = await this.fetchTurnMessages(turn);
      if (outcome === "settled") {
        this.logger.warn(
          `Session ${turn.sessionId} settled but the event stream stayed ` +
            "silent; finalizing from the message store.",
        );
        this.replayStoredMessages(turn, messages, push);
        if (!turn.state.finishEmitted) {
          push(finalizeV2Stream(turn.state));
        }
        return true;
      }
      // session.wait unavailable: finalize only on stored proof the turn
      // concluded — a terminal finish or error on the last stored message.
      const last = messages[messages.length - 1];
      const concluded =
        last !== undefined &&
        (last.error !== undefined ||
          (last.finish !== undefined &&
            last.finish !== "tool-calls" &&
            last.finish !== "unknown"));
      if (!concluded) {
        return false;
      }
      this.logger.warn(
        `Session ${turn.sessionId} has a stored terminal state but the ` +
          "event stream stayed silent; finalizing from the message store.",
      );
      this.replayStoredMessages(turn, messages, push);
      if (!turn.state.finishEmitted) {
        push(finalizeV2Stream(turn.state));
      }
      return true;
    } catch (probeError) {
      this.logger.debug?.(
        `Silence probe failed: ${extractErrorMessage(probeError)}`,
      );
      return false;
    }
  }

  /**
   * doGenerate reconciliation against the message store: verify streamed
   * content and fill gaps the delta stream could not cover. Failures are
   * logged and ignored — the streamed result stands.
   */
  private async reconcileGenerateResult(
    turn: TurnContext,
    aggregated: AggregatedParts,
  ): Promise<void> {
    if (turn.assistantMessageIds.size === 0) {
      return;
    }
    let messages: SessionMessageAssistant[];
    try {
      const response = await turn.port.message.list(
        { sessionID: turn.sessionId, order: "asc" },
        this.requestOptions(turn.headers, undefined),
      );
      messages = response.data.filter(
        (message): message is SessionMessageAssistant =>
          message.type === "assistant" &&
          turn.assistantMessageIds.has(message.id),
      );
    } catch (error) {
      this.logger.debug?.(
        `doGenerate message reconciliation skipped: ${extractErrorMessage(error)}`,
      );
      return;
    }
    if (messages.length === 0) {
      return;
    }

    // Content: the reducer assembled it from deltas. Restore any stored
    // block or tool call the stream never delivered — matched by the
    // reducer's key scheme (`${messageId}:${kind}:${ordinal}` for blocks, a
    // running ordinal over text+reasoning in array order; the v2 tool id for
    // tools). Partially streamed blocks are left alone (the reducer's
    // ended-event tail-fill is the recovery path for those).
    for (const message of messages) {
      let ordinal = 0;
      for (const entry of message.content) {
        if (entry.type === "text" || entry.type === "reasoning") {
          const key = `${message.id}:${entry.type}:${ordinal}`;
          ordinal += 1;
          if (entry.text.length > 0 && !aggregated.streamedBlockIds.has(key)) {
            aggregated.content.push({ type: entry.type, text: entry.text });
          }
          continue;
        }
        if (entry.type !== "tool") {
          continue;
        }
        const state = entry.state;
        if (
          state.status === "streaming" ||
          aggregated.streamedToolIds.has(entry.id)
        ) {
          // Streaming states carry only a partial input string — nothing
          // safe to restore; streamed tools are already in the content.
          continue;
        }
        const toolName = entry.name;
        const providerExecuted = entry.executed ?? true;
        aggregated.content.push({
          type: "tool-call",
          toolCallId: entry.id,
          toolName,
          input: JSON.stringify(state.input),
          providerExecuted,
          dynamic: true,
        });
        if (state.status === "completed") {
          aggregated.content.push({
            type: "tool-result",
            toolCallId: entry.id,
            toolName,
            result: state.content as unknown as NonNullable<JSONValue>,
            isError: false,
            dynamic: true,
          });
        } else if (state.status === "error") {
          aggregated.content.push({
            type: "tool-result",
            toolCallId: entry.id,
            toolName,
            result: {
              error: state.error as unknown as JSONValue,
              ...(state.content
                ? { content: state.content as unknown as JSONValue }
                : {}),
            } as NonNullable<JSONValue>,
            isError: true,
            dynamic: true,
          });
        }
      }
    }

    // Usage/cost: step events are authoritative per step. Add message totals
    // only for steps whose step.ended/failed was never observed (live or
    // synthesized) — per-message tokens equal that step's.
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let sawTokens = false;
    for (const message of messages) {
      if (message.tokens && !turn.stepClosedMessageIds.has(message.id)) {
        sawTokens = true;
        input += message.tokens.input;
        output += message.tokens.output;
        reasoning += message.tokens.reasoning;
        cacheRead += message.tokens.cache.read;
        cacheWrite += message.tokens.cache.write;
      }
    }
    if (sawTokens) {
      const usage = aggregated.usage;
      aggregated.usage = {
        inputTokens: {
          total:
            (usage.inputTokens.total ?? 0) + input + cacheRead + cacheWrite,
          noCache: (usage.inputTokens.noCache ?? 0) + input,
          cacheRead: (usage.inputTokens.cacheRead ?? 0) + cacheRead,
          cacheWrite: (usage.inputTokens.cacheWrite ?? 0) + cacheWrite,
        },
        outputTokens: {
          total: (usage.outputTokens.total ?? 0) + output,
          text: usage.outputTokens.text,
          reasoning: (usage.outputTokens.reasoning ?? 0) + reasoning,
        },
        ...(usage.raw !== undefined ? { raw: usage.raw } : {}),
      };
    }

    // Finish: prefer the streamed value; fall back to the last message's.
    const last = messages[messages.length - 1]!;
    if (
      aggregated.finishReason.unified === "other" &&
      aggregated.finishReason.raw === undefined &&
      last.finish !== undefined
    ) {
      aggregated.finishReason = mapOpencodeFinishReason(
        last.finish,
        last.rawFinish,
      );
    }
  }

  /**
   * Opt-in JSON validate/repair for doGenerate (`settings.jsonRepair`):
   * when json mode was requested and the final text fails client-side
   * validation, ask the server's `generate.text` route — documented
   * upstream as session-less/tool-less/history-less, so the original turn
   * is never replayed — to repair it. Bounded attempts; every failure here
   * is internal (post-dispatch phase rule): the original output stands when
   * repair is exhausted or unavailable, recorded in a warning.
   */
  private async repairJsonOutput(
    turn: TurnContext,
    aggregated: AggregatedParts,
  ): Promise<void> {
    const config = this.settings.jsonRepair;
    if (
      !config ||
      !turn.jsonMode ||
      aggregated.error !== undefined ||
      aggregated.finishReason.unified === "error"
    ) {
      return;
    }
    const text = aggregated.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    let failure = validateJsonText(text, turn.jsonSchema);
    if (failure === undefined) {
      return;
    }

    // Model ref for the side call, when one is knowable without a catalog
    // round-trip; omitted otherwise (server default).
    const model =
      this.resolvedModelRef ??
      (this.parsedProviderID
        ? {
            id: this.parsedModelID,
            providerID: this.parsedProviderID,
            ...(this.settings.variant
              ? { variant: this.settings.variant }
              : {}),
          }
        : undefined);

    const maxAttempts = config.maxAttempts ?? 1;
    let attemptsUsed = 0;
    let candidate = text;
    while (attemptsUsed < maxAttempts) {
      attemptsUsed += 1;
      let repaired: string;
      try {
        const response = await turn.port.generate.text(
          {
            prompt: buildJsonRepairPrompt(candidate, turn.jsonSchema, failure),
            ...(model ? { model } : {}),
          },
          this.requestOptions(turn.headers, undefined),
        );
        repaired = response.text;
      } catch (repairError) {
        // Post-dispatch side call: internal only (phase rule) — count the
        // attempt and keep going while the budget lasts.
        this.logger.warn(
          `JSON repair attempt ${attemptsUsed} failed: ${extractErrorMessage(repairError)}`,
        );
        continue;
      }
      const stripped = extractJsonCandidate(repaired);
      const strippedFailure = validateJsonText(stripped, turn.jsonSchema);
      if (strippedFailure === undefined) {
        replaceTextContent(aggregated.content, stripped);
        aggregated.warnings.push({
          type: "other",
          message:
            `responseFormat json: output failed client-side validation ` +
            `(${failure}) and was repaired via generate.text ` +
            `(${attemptsUsed} attempt(s) used).`,
        });
        return;
      }
      candidate = stripped;
      failure = strippedFailure;
    }
    aggregated.warnings.push({
      type: "other",
      message:
        `responseFormat json: output failed client-side validation ` +
        `(${failure}) and ${maxAttempts} repair attempt(s) were exhausted; ` +
        `returning the original output.`,
    });
  }

  // --- abort ------------------------------------------------------------

  private registerAbortCleanup(turn: TurnContext): void {
    const signal = turn.callSignal;
    if (!signal) {
      return;
    }
    const onAbort = (): void => {
      void this.abortServerSide(turn);
      turn.subscription.abort();
    };
    if (signal.aborted) {
      // The signal fired while dispatch was in flight (a listener added now
      // would never fire): run the cleanup immediately.
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  /**
   * Server-side abort: cancel the undelivered inbox item, falling back to
   * interrupting the running execution (the `delivered` flag is client-side
   * knowledge — the item may have been delivered in the window before its
   * events were pumped, making the cancel fail). Best-effort — the caller
   * is leaving either way. Cleanup calls carry headers but never the
   * (already aborted) call signal.
   */
  private async abortServerSide(turn: TurnContext): Promise<void> {
    if (turn.abortHandled || turn.state.finishEmitted) {
      return;
    }
    turn.abortHandled = true;
    const requestOptions = this.requestOptions(turn.headers, undefined);
    if (turn.receipt && !turn.delivered) {
      try {
        await turn.port.session.inbox.cancel(
          { sessionID: turn.sessionId, inboxID: turn.receipt.id },
          requestOptions,
        );
        return;
      } catch (cancelError) {
        this.logger.warn(
          `inbox.cancel failed for session ${turn.sessionId} ` +
            `(${extractErrorMessage(cancelError)}); falling back to interrupt.`,
        );
      }
    }
    try {
      await turn.port.session.interrupt(
        { sessionID: turn.sessionId, continue: false },
        requestOptions,
      );
    } catch (error) {
      this.logger.warn(
        `Abort cleanup failed for session ${turn.sessionId}: ${extractErrorMessage(error)}`,
      );
    }
  }

  // --- forms ------------------------------------------------------------

  /**
   * Ported v1 dedup/in-flight machinery keyed by form id — duplicates await
   * the in-flight run and only terminal outcomes are recorded as handled —
   * plus bounded in-model retries: the reducer hands each form to this
   * callback at most once per turn (nothing redelivers it within the turn),
   * so a transient reply/cancel failure must be retried here or the blocked
   * execution hangs with no recovery path.
   */
  private async handleFormRequest(
    turn: TurnContext,
    form: FormCreated["data"]["form"],
  ): Promise<void> {
    if (!this.settings.onForm && this.settings.formPolicy === "wait") {
      // Explicitly configured to leave forms pending for an external client.
      return;
    }

    for (;;) {
      if (this.handledFormRequests.has(form.id)) {
        return;
      }
      const inFlight = this.inFlightFormRequests.get(form.id);
      if (!inFlight) {
        break;
      }
      if (await inFlight) {
        return;
      }
    }
    if (turn.callSignal?.aborted) {
      this.logger.debug?.(
        `Skipping OpenCode form ${form.id}: request aborted.`,
      );
      return;
    }

    const run = this.runFormAttempts(turn, form);
    this.inFlightFormRequests.set(form.id, run);
    try {
      await run;
    } finally {
      if (this.inFlightFormRequests.get(form.id) === run) {
        this.inFlightFormRequests.delete(form.id);
      }
    }
  }

  /**
   * Attempt to settle a form, retrying transient failures with backoff up
   * to {@link MAX_FORM_ATTEMPTS}. Resolves true when terminally handled.
   * An exhausted run leaves the form retryable for a durable redelivery
   * (a later turn re-observing the still-pending form).
   */
  private async runFormAttempts(
    turn: TurnContext,
    form: FormCreated["data"]["form"],
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_FORM_ATTEMPTS; attempt += 1) {
      if (turn.callSignal?.aborted) {
        return false;
      }
      if (attempt > 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, FORM_RETRY_BASE_DELAY_MS * (attempt - 1)),
        );
      }
      if (await this.attemptFormResponse(turn, form)) {
        this.handledFormRequests.add(form.id);
        return true;
      }
    }
    this.logger.warn(
      `Form ${form.id} could not be settled after ${MAX_FORM_ATTEMPTS} ` +
        "attempts; the execution may stay blocked on it.",
    );
    return false;
  }

  /**
   * Run the onForm handler (or the cancel policy) and send the reply/cancel.
   * Resolves true when terminally handled, false when the attempt failed
   * retryably. Never rejects.
   */
  private async attemptFormResponse(
    turn: TurnContext,
    form: FormCreated["data"]["form"],
  ): Promise<boolean> {
    const request = form as unknown as OpencodeFormRequest;
    let answer: Record<string, string | number | boolean | string[]> | null =
      null;

    if (this.settings.onForm) {
      try {
        const response = await this.settings.onForm(request);
        if (response.type === "answer") {
          const validation = validateFormAnswer(request, response.answer);
          for (const warning of validation.warnings) {
            this.logger.warn(`Form ${form.id} answer: ${warning}`);
          }
          answer = response.answer as Record<
            string,
            string | number | boolean | string[]
          >;
        }
      } catch (error) {
        this.logger.warn(
          `Form handler failed for ${form.id}: ${extractErrorMessage(error)}. Cancelling the form.`,
        );
      }
    } else {
      this.logger.warn(
        `No onForm handler configured; cancelling OpenCode form ${form.id}.`,
      );
    }

    const requestOptions = this.requestOptions(turn.headers, turn.callSignal);
    const action = answer ? "reply" : "cancel";
    try {
      if (answer) {
        await turn.port.form.reply(
          { sessionID: form.sessionID, formID: form.id, answer },
          requestOptions,
        );
      } else {
        await turn.port.form.cancel(
          { sessionID: form.sessionID, formID: form.id },
          requestOptions,
        );
      }
      return true;
    } catch (error) {
      if (
        isTaggedError(error) &&
        (error._tag === "FormAlreadySettledError" ||
          error._tag === "FormNotFoundError")
      ) {
        this.logger.debug?.(
          `Form ${form.id} was already settled elsewhere (${error._tag}).`,
        );
        return true;
      }
      this.logger.warn(
        `Failed to ${action} OpenCode form ${form.id}: ${extractErrorMessage(error)}`,
      );
      // Stay retryable: the session is blocked on the pending form, so a
      // duplicate event must be allowed to try again.
      return false;
    }
  }

  // --- helpers ----------------------------------------------------------

  /** Per-call request options: undefined-filtered headers on EVERY request. */
  private requestOptions(
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): OpencodeRequestOptions {
    return {
      ...(headers ? { headers } : {}),
      ...(signal ? { signal } : {}),
    };
  }
}

// --- module-level helpers -----------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal) ?? new Error("Request aborted");
  }
}

function abortReason(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(extractErrorMessage(error));
}

/**
 * Busy-session rejection on the prompt route. The declared thrown union
 * carries `ConflictError` (409) for a busy session; `SessionBusyError` is
 * kept as a defensive alias (it exists in the tag union but is declared on
 * other routes).
 */
function isPromptBusyError(error: unknown): boolean {
  return isSessionBusyError(error) || isConflictError(error);
}

/**
 * Synthesize a `permission.asked` event from a polled `PermissionRequest`
 * (same data shape). The reducer's ID-based dedup makes re-observation of
 * an already-surfaced request a no-op.
 */
function synthesizePermissionAskedEvent(request: PermissionRequest): V2Event {
  return {
    id: `probe_perm_${request.id}`,
    created: Date.now(),
    type: "permission.asked",
    data: request,
  } as V2Event;
}

/** Synthesize a `form.created` event from a polled `FormInfo`. */
function synthesizeFormCreatedEvent(form: FormInfo): V2Event {
  return {
    id: `probe_form_${form.id}`,
    created: Date.now(),
    type: "form.created",
    data: { form },
  } as unknown as V2Event;
}

function nonRetryableError(message: string, operation: string): APICallError {
  return new APICallError({
    message,
    url: `opencode://${operation}`,
    requestBodyValues: {},
    isRetryable: false,
    data: {
      phase: "pre-dispatch",
      reconcile: false,
      operation,
    } satisfies OpencodeErrorData,
  });
}

function filterHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function extractProviderOptions(
  options: LanguageModelV4CallOptions,
): OpencodeProviderOptions | undefined {
  const raw = options.providerOptions?.["opencode"];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["id"] === "string" ? { id: record["id"] } : {}),
    ...(typeof record["sessionId"] === "string"
      ? { sessionId: record["sessionId"] }
      : {}),
  };
}

/**
 * Collect tool-approval-response parts from the prompt and classify the
 * call. Approval-only: the prompt's trailing message is a tool message
 * carrying approval responses — the AI SDK's continuation shape after a
 * `tool-approval-request` finish, with no new user content.
 */
function collectPromptApprovals(prompt: LanguageModelV4Prompt): {
  approvals: PromptApprovalResponse[];
  approvalOnly: boolean;
} {
  const approvals: PromptApprovalResponse[] = [];
  for (const message of prompt) {
    if (message.role !== "tool") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-approval-response") {
        approvals.push({
          approvalId: part.approvalId,
          approved: part.approved,
          ...(part.reason !== undefined ? { reason: part.reason } : {}),
        });
      }
    }
  }

  const last = prompt[prompt.length - 1];
  const approvalOnly =
    approvals.length > 0 &&
    last !== undefined &&
    last.role === "tool" &&
    last.content.some((part) => part.type === "tool-approval-response");

  return { approvals, approvalOnly };
}

/** Aggregated doGenerate result assembled from stream parts. */
interface AggregatedParts {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
  usage: LanguageModelV4Usage;
  providerMetadata: SharedV4ProviderMetadata | undefined;
  warnings: SharedV4Warning[];
  error: unknown | undefined;
  /** Reducer block ids (`${messageId}:${kind}:${ordinal}`) seen in-stream. */
  streamedBlockIds: Set<string>;
  /** Tool call ids seen in-stream (calls or results). */
  streamedToolIds: Set<string>;
}

const EMPTY_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function aggregateParts(parts: LanguageModelV4StreamPart[]): AggregatedParts {
  const content: LanguageModelV4Content[] = [];
  const blockIndex = new Map<string, number>();
  const aggregated: AggregatedParts = {
    content,
    finishReason: { unified: "other", raw: undefined },
    usage: EMPTY_USAGE,
    providerMetadata: undefined,
    warnings: [],
    error: undefined,
    streamedBlockIds: new Set(),
    streamedToolIds: new Set(),
  };

  for (const part of parts) {
    switch (part.type) {
      case "text-start":
        aggregated.streamedBlockIds.add(part.id);
        blockIndex.set(part.id, content.push({ type: "text", text: "" }) - 1);
        break;
      case "reasoning-start":
        aggregated.streamedBlockIds.add(part.id);
        blockIndex.set(
          part.id,
          content.push({ type: "reasoning", text: "" }) - 1,
        );
        break;
      case "text-delta":
      case "reasoning-delta": {
        const index = blockIndex.get(part.id);
        const entry = index !== undefined ? content[index] : undefined;
        if (entry && (entry.type === "text" || entry.type === "reasoning")) {
          entry.text += part.delta;
        }
        break;
      }
      case "tool-call":
        aggregated.streamedToolIds.add(part.toolCallId);
        content.push(part);
        break;
      case "tool-result":
        aggregated.streamedToolIds.add(part.toolCallId);
        content.push(part);
        break;
      case "tool-approval-request":
      case "file":
      case "reasoning-file":
      case "source":
      case "custom":
        content.push(part);
        break;
      case "finish":
        aggregated.finishReason = part.finishReason;
        aggregated.usage = part.usage;
        aggregated.providerMetadata = part.providerMetadata;
        break;
      case "stream-start":
        aggregated.warnings = part.warnings;
        break;
      case "error":
        aggregated.error = part.error;
        break;
      default:
        // text-end/reasoning-end/tool-input-*/response-metadata/raw carry no
        // aggregate content.
        break;
    }
  }
  return aggregated;
}

/**
 * Client-side validation for json-mode output: `JSON.parse` plus structural
 * validation against the AI SDK-supplied JSON schema via
 * {@link checkJsonSchema}. Returns an error description, or undefined when
 * valid.
 */
function validateJsonText(text: string, schema: unknown): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `not valid JSON: ${extractErrorMessage(error)}`;
  }
  return checkJsonSchema(parsed, schema, "$");
}

/**
 * Dependency-free structural validator for the JSON-Schema subset the AI
 * SDK's zod conversion emits: `type` (including union arrays and
 * `integer`), `properties`, `required`, `items`, `enum`, `const`, and
 * `additionalProperties: false`, applied recursively. Deliberately
 * permissive on everything else (`$ref`, combinators, string/number
 * constraints are ignored): an unsupported keyword must never reject output
 * that full validation would accept — a false rejection would trigger a
 * pointless repair round-trip. The AI SDK caller re-validates the final
 * object regardless. Returns the first violation, or undefined.
 */
function checkJsonSchema(
  value: unknown,
  schema: unknown,
  path: string,
): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const s = schema as Record<string, unknown>;
  if ("$ref" in s) {
    // Referenced definitions are not resolved; stay permissive.
    return undefined;
  }
  if (s["type"] !== undefined) {
    const types = Array.isArray(s["type"]) ? s["type"] : [s["type"]];
    const matches = types.some(
      (type) => typeof type === "string" && matchesJsonType(value, type),
    );
    if (!matches) {
      return (
        `${path}: expected type ${types.map(String).join("|")}, ` +
        `got ${describeJsonType(value)}`
      );
    }
  }
  if (
    Array.isArray(s["enum"]) &&
    !s["enum"].some((e) => jsonEquals(e, value))
  ) {
    return `${path}: value is not one of the enum values`;
  }
  if ("const" in s && !jsonEquals(s["const"], value)) {
    return `${path}: value does not equal the const value`;
  }
  if (Array.isArray(value)) {
    const items = s["items"];
    if (items !== undefined && !Array.isArray(items)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = checkJsonSchema(
          value[index],
          items,
          `${path}[${index}]`,
        );
        if (failure !== undefined) {
          return failure;
        }
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(s["required"])) {
      for (const key of s["required"]) {
        if (typeof key === "string" && !(key in record)) {
          return `${path}: missing required property "${key}"`;
        }
      }
    }
    const rawProperties = s["properties"];
    const properties =
      rawProperties !== null &&
      typeof rawProperties === "object" &&
      !Array.isArray(rawProperties)
        ? (rawProperties as Record<string, unknown>)
        : undefined;
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in record) {
          const failure = checkJsonSchema(
            record[key],
            propertySchema,
            `${path}.${key}`,
          );
          if (failure !== undefined) {
            return failure;
          }
        }
      }
    }
    if (
      s["additionalProperties"] === false &&
      s["patternProperties"] === undefined
    ) {
      for (const key of Object.keys(record)) {
        if (!properties || !(key in properties)) {
          return `${path}: unexpected property "${key}"`;
        }
      }
    }
  }
  return undefined;
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // Unknown type keyword: permissive.
      return true;
  }
}

function describeJsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/** Structural equality for enum/const members (JSON values only). */
function jsonEquals(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Strip a Markdown code fence when the whole output is wrapped in one. */
function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function buildJsonRepairPrompt(
  invalidOutput: string,
  schema: unknown,
  failure: string,
): string {
  return [
    "The following model output was supposed to be a single valid JSON value" +
      (schema !== undefined ? " matching the JSON schema below" : "") +
      `, but it failed validation: ${failure}.`,
    "Return ONLY the corrected JSON value — no prose, no code fences.",
    ...(schema !== undefined ? ["JSON schema:", JSON.stringify(schema)] : []),
    "Invalid output:",
    invalidOutput,
  ].join("\n\n");
}

/**
 * Replace every text part with a single text part holding `text`, at the
 * position of the first original text part (non-text parts keep their
 * relative order).
 */
function replaceTextContent(
  content: LanguageModelV4Content[],
  text: string,
): void {
  let insertAt: number | undefined;
  const kept: LanguageModelV4Content[] = [];
  for (const part of content) {
    if (part.type === "text") {
      insertAt ??= kept.length;
      continue;
    }
    kept.push(part);
  }
  kept.splice(insertAt ?? kept.length, 0, { type: "text", text });
  content.length = 0;
  content.push(...kept);
}

/** Assistant messages belonging to this turn, in creation order. */
function selectTurnAssistantMessages(
  messages: SessionMessageInfo[],
  turn: TurnContext,
): SessionMessageAssistant[] {
  return messages
    .filter(
      (message): message is SessionMessageAssistant =>
        message.type === "assistant" &&
        (turn.assistantMessageIds.has(message.id) ||
          message.time.created >= turn.turnStartedAt),
    )
    .sort((a, b) => a.time.created - b.time.created);
}

/**
 * Synthesize reducer events from stored assistant messages so the recovery
 * path reuses the reducer's idempotent handlers instead of a second
 * assembly code path.
 *
 * Ordinal assumption (documented): stored text/reasoning entries take a
 * running ordinal over the message's text+reasoning content in array order —
 * matching the shared `{assistantMessageID, ordinal}` keyspace of the live
 * delta events. A mismatch degrades to duplicated block content on this
 * rare recovery path, never to data loss.
 */
function synthesizeReconciliationEvents(
  messages: SessionMessageAssistant[],
  turn: TurnContext,
): OpencodeReducerInput[] {
  const sessionId = turn.sessionId;
  let counter = 0;
  const envelope = () => {
    counter += 1;
    return {
      id: `reconcile_${counter}`,
      created: Date.now(),
    };
  };
  // A distinct aggregate keeps synthesized durable keys out of the live
  // events' dedup keyspace.
  const durable = <V extends 1 | 2>(version: V) => ({
    aggregateID: `${sessionId}#reconcile`,
    seq: counter,
    version,
  });

  const events: OpencodeReducerInput[] = [];
  for (const message of messages) {
    if (!turn.assistantMessageIds.has(message.id)) {
      events.push({
        ...envelope(),
        type: "session.step.started",
        durable: durable(1),
        data: {
          sessionID: sessionId,
          assistantMessageID: message.id,
          agent: message.agent,
          model: message.model,
        },
      });
    }

    let ordinal = 0;
    for (const entry of message.content) {
      if (entry.type === "text" || entry.type === "reasoning") {
        events.push({
          ...envelope(),
          type:
            entry.type === "text"
              ? "session.text.ended"
              : "session.reasoning.ended",
          durable: durable(1),
          data: {
            sessionID: sessionId,
            assistantMessageID: message.id,
            ordinal,
            text: entry.text,
          },
        });
        ordinal += 1;
        continue;
      }

      // Tool entry: replay the lifecycle the state has reached. A streaming
      // state carries only a partial input string — nothing safe to replay.
      const state = entry.state;
      if (state.status === "streaming") {
        continue;
      }
      const executed = entry.executed ?? true;
      events.push(
        {
          ...envelope(),
          type: "session.tool.input.started",
          durable: durable(1),
          data: {
            sessionID: sessionId,
            assistantMessageID: message.id,
            id: entry.id,
            name: entry.name,
          },
        },
        {
          ...envelope(),
          type: "session.tool.input.ended",
          durable: durable(1),
          data: {
            sessionID: sessionId,
            assistantMessageID: message.id,
            id: entry.id,
            text: JSON.stringify(state.input),
          },
        },
        {
          ...envelope(),
          type: "session.tool.called",
          durable: durable(1),
          data: {
            sessionID: sessionId,
            assistantMessageID: message.id,
            id: entry.id,
            input: state.input,
            executed,
          },
        },
      );
      if (state.status === "completed") {
        events.push({
          ...envelope(),
          type: "session.tool.success",
          durable: durable(2),
          data: {
            sessionID: sessionId,
            assistantMessageID: message.id,
            id: entry.id,
            // Beta codegen splits ToolContent between the message and event
            // unions (nullable vs optional `name`); structurally identical.
            content:
              state.content as unknown as SessionToolSuccess["data"]["content"],
            executed,
          },
        });
      } else if (state.status === "error") {
        events.push({
          ...envelope(),
          type: "session.tool.failed",
          durable: durable(2),
          data: {
            sessionID: sessionId,
            assistantMessageID: message.id,
            id: entry.id,
            error: state.error,
            ...(state.content
              ? {
                  content:
                    state.content as unknown as SessionToolSuccess["data"]["content"],
                }
              : {}),
            executed,
          },
        });
      }
    }

    // Step accounting, only when the live stream did not close this step
    // (a synthesized step.ended would double-count observed usage). The
    // step is marked closed so later usage reconciliation (doGenerate's
    // message pass) does not count it a second time either.
    if (
      message.finish !== undefined &&
      !turn.stepClosedMessageIds.has(message.id)
    ) {
      turn.stepClosedMessageIds.add(message.id);
      events.push({
        ...envelope(),
        type: "session.step.ended",
        durable: durable(1),
        data: {
          sessionID: sessionId,
          assistantMessageID: message.id,
          finish: message.finish,
          ...(message.rawFinish !== undefined
            ? { rawFinish: message.rawFinish }
            : {}),
          cost: message.cost ?? 0,
          tokens: message.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      });
    }
  }

  const last = messages[messages.length - 1];
  if (last) {
    if (last.error) {
      events.push({
        ...envelope(),
        type: "session.execution.failed",
        durable: durable(1),
        data: { sessionID: sessionId, error: last.error },
      });
    } else if (
      last.finish !== undefined &&
      last.finish !== "tool-calls" &&
      last.finish !== "unknown"
    ) {
      events.push({
        ...envelope(),
        type: "session.execution.succeeded",
        durable: durable(1),
        data: { sessionID: sessionId },
      });
    }
    // Else: no trustworthy terminal — the caller's finalize backstop closes
    // the stream with the last step's finish (or `other`).
  }

  return events;
}
