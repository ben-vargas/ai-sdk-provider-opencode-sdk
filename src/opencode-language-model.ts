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
import { isSessionBusyError } from "@opencode-ai/client";
import type {
  FormCreated,
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
  isTaggedError,
  needsSessionReconciliation,
  wrapError,
  type OpencodeErrorData,
} from "./errors.js";
import { getLogger, logUnsupportedCallOptions } from "./logger.js";
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
}

const DEFAULT_READINESS_TIMEOUT_MS = 3000;
const DEFAULT_APPROVAL_IDLE_TIMEOUT_MS = 1500;
const DEFAULT_SESSION_TITLE = "AI SDK Session";

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
 * `next()`: on timeout the pending promise is stashed and handed to the next
 * caller.
 */
interface EventReader {
  next(): Promise<IteratorResult<V2Event>>;
  nextWithTimeout(ms: number): Promise<IteratorResult<V2Event> | "timeout">;
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
    nextWithTimeout(ms: number) {
      const promise = pending ?? iterator.next();
      pending = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      });
      return Promise.race([promise, timeout]).then((result) => {
        clearTimeout(timer);
        if (result === "timeout") {
          pending = promise;
        }
        return result;
      });
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
  approvalIdleTimeoutMs: number;
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
    const turn = await this.startTurn(options);

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (controller) => {
        void this.runPump(turn, (part) => controller.enqueue(part))
          .then(() => controller.close())
          .catch((error: unknown) => controller.error(error))
          .finally(() => turn.subscription.abort());
      },
      cancel: () => {
        // Consumer cancellation mid-turn: same server-side cleanup as a
        // caller abort — the execution is still running server-side.
        void this.abortServerSide(turn);
        turn.subscription.abort();
      },
    });

    return { stream, request: { body: turn.requestBody } };
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
      turnStartedAt: Date.now(),
      delivered: approvalOnly,
      outstandingApprovals: new Set(),
      assistantMessageIds: new Set(),
      stepClosedMessageIds: new Set(),
      requestBody: undefined,
      abortHandled: false,
      approvalIdleTimeoutMs:
        this.config.approvalIdleTimeoutMs ?? DEFAULT_APPROVAL_IDLE_TIMEOUT_MS,
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
      subscription.abort();
      throw error;
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
        location ? { location: { directory: location.directory } } : undefined,
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
      try {
        await turn.port.permission.reply(
          {
            sessionID: turn.sessionId,
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
              `${turn.sessionId}; assuming it was already replied.`,
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
      this.repliedApprovals.add(approval.approvalId);
      // Also mark it in THIS turn's reducer state: a redelivered
      // permission.asked for a just-replied approval must not resurface.
      turn.state.emittedApprovals.add(approval.approvalId);
      this.pendingApprovalSessions.delete(approval.approvalId);
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
    if (systemParts.length > 0) {
      if (flags.freshSession) {
        text = prependSystemBlock(text, systemParts.join("\n\n"));
        turn.warnings.push({
          type: "unsupported",
          feature: "system prompt",
          details:
            "OpenCode v2 has no per-prompt system field; the system content " +
            "was prepended to the first turn's text as a delimited block " +
            "(system-role priority is lost).",
        });
      } else {
        turn.warnings.push({
          type: "unsupported",
          feature: "system prompt",
          details:
            "System content is only sent on a session's first prompt; this " +
            "call reuses an existing OpenCode session, so it was skipped.",
        });
      }
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
      if (isSessionBusyError(error) && promptInput.delivery !== "queue") {
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
   * Prompt-failure classification. A `SessionBusyError` that survives the
   * queue retry is surfaced non-retryable (an AI SDK retry would just race
   * the same busy session). Other tagged errors are definitive pre-dispatch
   * rejections; transport-class failures have uncertain delivery and follow
   * the post-dispatch rule.
   */
  private wrapPromptError(error: unknown, turn: TurnContext): Error {
    if (isSessionBusyError(error)) {
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
          errorTag: "SessionBusyError",
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
      for (const buffered of turn.preBuffer) {
        this.observeEvent(turn, buffered, push);
        if (turn.state.finishEmitted) {
          return;
        }
      }
      turn.preBuffer = [];

      while (!turn.state.finishEmitted) {
        let result: IteratorResult<V2Event> | "timeout";
        if (turn.outstandingApprovals.size > 0) {
          result = await turn.reader.nextWithTimeout(
            turn.approvalIdleTimeoutMs,
          );
          if (result === "timeout") {
            // Approval quiescence: the execution is blocked awaiting the
            // reply. Surface the blocked turn to the caller (phase 1).
            push(finalizeV2Stream(turn.state));
            return;
          }
        } else {
          result = await turn.reader.next();
        }
        if (result.done) {
          push(finalizeV2Stream(turn.state));
          return;
        }
        this.observeEvent(turn, result.value, push);
      }
    } catch (error) {
      if (isAbortError(error) || turn.callSignal?.aborted) {
        throw abortReason(turn.callSignal) ?? error;
      }
      await this.recoverPumpFailure(turn, error, push);
    }
  }

  /** Feed one event through orchestration tracking and the reducer. */
  private observeEvent(
    turn: TurnContext,
    event: V2Event,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): void {
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
      }
      return { ...part, providerMetadata: { opencode } };
    }
    return part;
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
        await this.reconcileFromMessages(turn, push);
        if (!turn.state.finishEmitted) {
          push(finalizeV2Stream(turn.state));
        }
        return;
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
   * Internal reconciliation: wait for the session to settle (best-effort),
   * fetch its messages, and replay this turn's assistant messages through
   * the reducer as synthesized terminal events. Already-streamed content
   * reduces to nothing (the reducer is idempotent); missed content arrives
   * as whole blocks.
   */
  private async reconcileFromMessages(
    turn: TurnContext,
    push: (parts: LanguageModelV4StreamPart[]) => void,
  ): Promise<void> {
    const requestOptions = this.requestOptions(turn.headers, undefined);
    try {
      await turn.port.session.wait(
        { sessionID: turn.sessionId },
        requestOptions,
      );
    } catch (waitError) {
      // session.wait is a best-effort watchdog: current builds 503 it, and
      // its unavailability must never fail the reconciliation.
      this.logger.debug?.(
        `session.wait unavailable during reconciliation: ${extractErrorMessage(waitError)}`,
      );
    }

    const response = await turn.port.message.list(
      { sessionID: turn.sessionId, order: "asc" },
      requestOptions,
    );
    const messages = selectTurnAssistantMessages(response.data, turn);
    const events = synthesizeReconciliationEvents(messages, turn);
    for (const event of events) {
      push(convertV2EventToStreamParts(event, turn.state));
      if (turn.state.finishEmitted) {
        break;
      }
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

    // Content: the reducer assembled it from deltas; if the stream produced
    // no text at all but the stored messages have some, take the stored text.
    const streamedText = aggregated.content.some(
      (entry) => entry.type === "text" && entry.text.length > 0,
    );
    if (!streamedText) {
      for (const message of messages) {
        for (const entry of message.content) {
          if (entry.type === "text" && entry.text.length > 0) {
            aggregated.content.push({ type: "text", text: entry.text });
          }
        }
      }
    }

    // Usage/cost: step events are authoritative; message totals fill in when
    // no step event was observed (per-message tokens equal the step's).
    const usage = aggregated.usage;
    const usageEmpty =
      (usage.inputTokens.total ?? 0) === 0 &&
      (usage.outputTokens.total ?? 0) === 0;
    if (usageEmpty) {
      let input = 0;
      let output = 0;
      let reasoning = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let sawTokens = false;
      for (const message of messages) {
        if (message.tokens) {
          sawTokens = true;
          input += message.tokens.input;
          output += message.tokens.output;
          reasoning += message.tokens.reasoning;
          cacheRead += message.tokens.cache.read;
          cacheWrite += message.tokens.cache.write;
        }
      }
      if (sawTokens) {
        aggregated.usage = {
          inputTokens: {
            total: input + cacheRead + cacheWrite,
            noCache: input,
            cacheRead,
            cacheWrite,
          },
          outputTokens: { total: output, text: undefined, reasoning },
          ...(usage.raw !== undefined ? { raw: usage.raw } : {}),
        };
      }
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

  // --- abort ------------------------------------------------------------

  private registerAbortCleanup(turn: TurnContext): void {
    turn.callSignal?.addEventListener(
      "abort",
      () => {
        void this.abortServerSide(turn);
        turn.subscription.abort();
      },
      { once: true },
    );
  }

  /**
   * Server-side abort: cancel the undelivered inbox item, else interrupt the
   * running execution. Best-effort — the caller is leaving either way.
   * Cleanup calls carry headers but never the (already aborted) call signal.
   */
  private async abortServerSide(turn: TurnContext): Promise<void> {
    if (turn.abortHandled || turn.state.finishEmitted) {
      return;
    }
    turn.abortHandled = true;
    const requestOptions = this.requestOptions(turn.headers, undefined);
    try {
      if (turn.receipt && !turn.delivered) {
        await turn.port.session.inbox.cancel(
          { sessionID: turn.sessionId, inboxID: turn.receipt.id },
          requestOptions,
        );
      } else {
        await turn.port.session.interrupt(
          { sessionID: turn.sessionId, continue: false },
          requestOptions,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Abort cleanup failed for session ${turn.sessionId}: ${extractErrorMessage(error)}`,
      );
    }
  }

  // --- forms ------------------------------------------------------------

  /**
   * Ported v1 dedup/in-flight machinery keyed by form id: duplicates await
   * the in-flight attempt, only terminal outcomes are recorded as handled,
   * and failed attempts stay retryable for later duplicates.
   */
  private async handleFormRequest(
    turn: TurnContext,
    form: FormCreated["data"]["form"],
  ): Promise<void> {
    if (!this.settings.onForm && this.settings.formPolicy === "wait") {
      // Explicitly configured to leave forms pending for an external client.
      return;
    }

    while (!this.handledFormRequests.has(form.id)) {
      const inFlight = this.inFlightFormRequests.get(form.id);
      if (!inFlight) {
        break;
      }
      if (await inFlight) {
        return;
      }
    }
    if (this.handledFormRequests.has(form.id)) {
      return;
    }
    if (turn.callSignal?.aborted) {
      this.logger.debug?.(
        `Skipping OpenCode form ${form.id}: request aborted.`,
      );
      return;
    }

    const attempt = this.attemptFormResponse(turn, form);
    this.inFlightFormRequests.set(form.id, attempt);
    try {
      if (await attempt) {
        this.handledFormRequests.add(form.id);
      }
    } finally {
      if (this.inFlightFormRequests.get(form.id) === attempt) {
        this.inFlightFormRequests.delete(form.id);
      }
    }
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
  };

  for (const part of parts) {
    switch (part.type) {
      case "text-start":
        blockIndex.set(part.id, content.push({ type: "text", text: "" }) - 1);
        break;
      case "reasoning-start":
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
      case "tool-result":
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
    // (a synthesized step.ended would double-count observed usage).
    if (
      message.finish !== undefined &&
      !turn.stepClosedMessageIds.has(message.id)
    ) {
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
