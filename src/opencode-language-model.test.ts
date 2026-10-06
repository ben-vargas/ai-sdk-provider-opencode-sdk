/**
 * Full doGenerate/doStream scenarios against a scripted fake client-port.
 * No real server speaks the beta-18286 contract (spike finding 0), so the
 * fake port IS the contract under test: it enforces subscribe-before-prompt,
 * records every call's request options (headers assertions), and lets tests
 * script event delivery, stream failure, and typed errors.
 */
import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { SessionInboxUser, V2Event } from "@opencode/client";
import type {
  OpencodeClientPort,
  OpencodeRequestOptions,
} from "./client-port.js";
import {
  OpencodeLanguageModel,
  type OpencodeLanguageModelConfig,
} from "./opencode-language-model.js";
import { INSTRUCTION_VALUE_MAX_BYTES } from "./system-instruction.js";
import { extractV2EventSessionId } from "./convert-from-opencode-events.js";
import type { OpencodeSettings } from "./types.js";
import {
  SESSION_ID,
  eventFactory,
  tokens,
} from "../test/fixtures/v2-events/index.js";

// --- fake client-port ----------------------------------------------------

interface RecordedCall {
  method: string;
  input: unknown;
  options: OpencodeRequestOptions | undefined;
}

/** Async event channel backing one `event.subscribe` iterator. */
class EventChannel {
  private queue: V2Event[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<V2Event>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  constructor(private signal?: AbortSignal) {
    // Matches @opencode/client 2.x: aborting the subscribe signal ends the
    // iterator quietly (`done`) instead of throwing an AbortError.
    signal?.addEventListener("abort", () => {
      this.close();
    });
  }

  push(...events: V2Event[]): void {
    for (const event of events) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve({ value: event, done: false });
      } else {
        this.queue.push(event);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  iterable(): AsyncIterable<V2Event> {
    const next = (): Promise<IteratorResult<V2Event>> => {
      if (this.queue.length > 0) {
        return Promise.resolve({ value: this.queue.shift()!, done: false });
      }
      if (this.failure !== undefined) {
        return Promise.reject(this.failure);
      }
      if (this.closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    };
    return {
      [Symbol.asyncIterator]: () => ({ next }),
    };
  }
}

interface FakePortHooks {
  onPrompt?: (
    input: Record<string, unknown>,
    receipt: SessionInboxUser,
  ) => void;
  promptError?: (attempt: number) => unknown | undefined;
  onPermissionReply?: (input: Record<string, unknown>) => void;
  /** Suppress the automatic server.connected on subscribe. */
  suppressServerConnected?: boolean;
  messages?: unknown[];
  models?: unknown[];
  waitError?: unknown;
  /** Defer wait resolution: never resolves within the test (default: instant). */
  waitHangs?: boolean;
  /** Pending permission requests returned by permission.list. */
  permissions?: unknown[];
  /** Pending forms returned by form.list. */
  forms?: unknown[];
  /** Message ids `session.message.get` resolves (others: not found). */
  storedMessageIds?: Set<string>;
  /** Disable the implicit `session.inbox.delivered` (tests script it). */
  manualDelivery?: boolean;
  /** Pending inbox items returned by session.inbox.list. */
  inboxItems?: unknown[] | (() => unknown[]);
  /** Make session.inbox.list reject. */
  inboxListError?: unknown;
  /** Scripted generate.text responses (throw inside to fail the call). */
  generateText?: (input: Record<string, unknown>) => { text: string };
  /**
   * Expose `session.instructions.entry` on the port. Off by default so the
   * existing suite keeps exercising the no-entry fallback; the
   * system-prompt tests turn it on.
   */
  instructionEntries?: boolean;
  /** Make `session.instructions.entry.put` reject with this. */
  instructionPutError?: unknown;
  /** Make `session.instructions.entry.remove` reject with this. */
  instructionRemoveError?: unknown;
  /**
   * Make `session.create` mint a distinct id per call, as a real server
   * does. Off by default so existing tests keep asserting on `SESSION_ID`.
   */
  uniqueSessions?: boolean;
}

interface FakePort {
  port: OpencodeClientPort;
  calls: RecordedCall[];
  hooks: FakePortHooks;
  emit: (...events: V2Event[]) => void;
  closeStream: () => void;
  failStream: (error: unknown) => void;
  callsFor: (method: string) => RecordedCall[];
}

const SERVER_CONNECTED = {
  id: "evt_server",
  type: "server.connected",
  data: {},
} as V2Event;

function sessionInfo(id: string): Record<string, unknown> {
  return {
    id,
    projectID: "proj_1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/tmp/fake" },
  };
}

function createFakePort(hooks: FakePortHooks = {}): FakePort {
  const calls: RecordedCall[] = [];
  let channel: EventChannel | undefined;
  let promptAttempts = 0;
  let inboxCounter = 0;
  // Like the real server, a prompt's `session.inbox.delivered` precedes
  // every execution-scoped event it causes: the fake emits it implicitly
  // before the first such event a test scripts (unless the test emits it
  // itself). Scripts that emit nothing leave the prompt undelivered.
  let pendingDelivery: { sessionID: string; inboxID: string } | undefined;
  const emitWithDelivery = (...events: V2Event[]): void => {
    for (const event of events) {
      if (pendingDelivery !== undefined && !hooks.manualDelivery) {
        if (
          event.type === "session.inbox.delivered" &&
          event.data.inboxID === pendingDelivery.inboxID
        ) {
          pendingDelivery = undefined;
        } else if (
          (/^session\.(execution|step|text|reasoning|tool|usage|retry)\./.test(
            event.type,
          ) ||
            event.type === "permission.asked" ||
            event.type === "form.created") &&
          extractV2EventSessionId(event) === pendingDelivery.sessionID
        ) {
          const { sessionID, inboxID } = pendingDelivery;
          pendingDelivery = undefined;
          channel!.push({
            id: `evt_auto_del_${inboxID}`,
            created: 1,
            type: "session.inbox.delivered",
            durable: { aggregateID: sessionID, seq: 0, version: 1 },
            data: { sessionID, inboxID },
          } as V2Event);
        }
      }
      channel!.push(event);
    }
  };
  let sessionCounter = 0;

  const record = (
    method: string,
    input: unknown,
    options: OpencodeRequestOptions | undefined,
  ): void => {
    calls.push({ method, input, options });
  };

  const fn =
    <T>(method: string, impl: (input: never) => T) =>
    (input?: unknown, options?: OpencodeRequestOptions): Promise<T> => {
      record(method, input, options);
      return Promise.resolve(impl(input as never));
    };

  const port = {
    server: { info: fn("server.info", () => ({ version: "2.0.0" })) },
    session: {
      create: fn("session.create", () => {
        sessionCounter += 1;
        return sessionInfo(
          hooks.uniqueSessions ? `${SESSION_ID}_${sessionCounter}` : SESSION_ID,
        );
      }),
      get: fn("session.get", (input: { sessionID: string }) =>
        sessionInfo(input.sessionID),
      ),
      prompt: (
        input: Record<string, unknown>,
        options?: OpencodeRequestOptions,
      ) => {
        record("session.prompt", input, options);
        promptAttempts += 1;
        const error = hooks.promptError?.(promptAttempts);
        if (error !== undefined) {
          return Promise.reject(error);
        }
        inboxCounter += 1;
        const receipt = {
          id: `inbox_${inboxCounter}`,
          sessionID: input["sessionID"],
          timeCreated: Date.now(),
          type: "user",
          payload: { text: input["text"] },
          delivery: input["delivery"] ?? "steer",
        } as SessionInboxUser;
        pendingDelivery = {
          sessionID: String(input["sessionID"]),
          inboxID: receipt.id,
        };
        hooks.onPrompt?.(input, receipt);
        return Promise.resolve(receipt);
      },
      wait: (input: unknown, options?: OpencodeRequestOptions) => {
        record("session.wait", input, options);
        if (hooks.waitHangs) {
          return new Promise<undefined>(() => undefined);
        }
        return hooks.waitError !== undefined
          ? Promise.reject(hooks.waitError)
          : Promise.resolve(undefined);
      },
      interrupt: fn("session.interrupt", () => ({ interrupted: true })),
      switchModel: fn("session.switchModel", () => undefined),
      switchAgent: fn("session.switchAgent", () => undefined),
      message: {
        get: fn("session.message.get", (input: { messageID: string }) => {
          const stored = hooks.storedMessageIds?.has(input.messageID);
          if (stored) {
            return { id: input.messageID, type: "user" };
          }
          throw { _tag: "MessageNotFoundError", message: "not found" };
        }),
      },
      context: fn("session.context", () => []),
      log: () => {
        throw new Error("session.log not scripted");
      },
      form: {
        list: fn("form.list", () => hooks.forms ?? []),
        reply: fn("form.reply", () => undefined),
        cancel: fn("form.cancel", () => undefined),
      },
      inbox: {
        cancel: fn("session.inbox.cancel", () => undefined),
        list: (input: unknown, options?: OpencodeRequestOptions) => {
          record("session.inbox.list", input, options);
          if (hooks.inboxListError !== undefined) {
            return Promise.reject(hooks.inboxListError);
          }
          const items = hooks.inboxItems ?? [];
          return Promise.resolve(typeof items === "function" ? items() : items);
        },
      },
      ...(hooks.instructionEntries
        ? {
            instructions: {
              entry: {
                put: (
                  input: Record<string, unknown>,
                  options?: OpencodeRequestOptions,
                ) => {
                  record("session.instructions.entry.put", input, options);
                  return hooks.instructionPutError !== undefined
                    ? Promise.reject(hooks.instructionPutError)
                    : Promise.resolve(undefined);
                },
                remove: (
                  input: Record<string, unknown>,
                  options?: OpencodeRequestOptions,
                ) => {
                  record("session.instructions.entry.remove", input, options);
                  return hooks.instructionRemoveError !== undefined
                    ? Promise.reject(hooks.instructionRemoveError)
                    : Promise.resolve(undefined);
                },
                list: fn("session.instructions.entry.list", () => []),
              },
            },
          }
        : {}),
    },
    generate: {
      text: (
        input: Record<string, unknown>,
        options?: OpencodeRequestOptions,
      ) => {
        record("generate.text", input, options);
        if (!hooks.generateText) {
          return Promise.reject(new Error("generate.text not scripted"));
        }
        try {
          return Promise.resolve(hooks.generateText(input));
        } catch (error) {
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    },
    message: {
      list: fn("message.list", () => ({
        data: hooks.messages ?? [],
        cursor: {},
      })),
    },
    model: {
      list: fn("model.list", () => ({
        location: { directory: "/tmp/fake", project: {} },
        data: hooks.models ?? [],
      })),
    },
    event: {
      subscribe: (options?: OpencodeRequestOptions) => {
        record("event.subscribe", undefined, options);
        channel = new EventChannel(options?.signal);
        if (!hooks.suppressServerConnected) {
          channel.push(SERVER_CONNECTED);
        }
        return channel.iterable();
      },
    },
    permission: {
      list: fn("permission.list", () => hooks.permissions ?? []),
      get: fn("permission.get", () => ({})),
      reply: (
        input: Record<string, unknown>,
        options?: OpencodeRequestOptions,
      ) => {
        record("permission.reply", input, options);
        hooks.onPermissionReply?.(input);
        return Promise.resolve(undefined);
      },
    },
    migration: {
      v1: {
        status: fn("migration.v1.status", () => ({ status: "completed" })),
      },
    },
  } as unknown as OpencodeClientPort;

  return {
    port,
    calls,
    hooks,
    emit: emitWithDelivery,
    closeStream: () => channel!.close(),
    failStream: (error) => channel!.fail(error),
    callsFor: (method) => calls.filter((call) => call.method === method),
  };
}

// --- test helpers --------------------------------------------------------

function createModel(
  fake: FakePort,
  settings?: OpencodeSettings,
  config?: Partial<OpencodeLanguageModelConfig>,
): OpencodeLanguageModel {
  return new OpencodeLanguageModel(
    "test-provider/test-model",
    { logger: false, ...settings },
    // Fast wait-watchdog grace and delivery-evidence window: the fake port's
    // wait resolves instantly, so any turn that has to wait for late events
    // would otherwise burn the full production bounds before continuing.
    {
      getPort: () => fake.port,
      waitWatchdogGraceMs: 25,
      deliveryEvidenceWindowMs: 100,
      ...config,
    },
  );
}

function userPrompt(text: string): LanguageModelV4Prompt {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

function callOptions(
  overrides: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return { prompt: userPrompt("Hi"), ...overrides };
}

async function collectStream(result: {
  stream: ReadableStream<LanguageModelV4StreamPart>;
}): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return parts;
    }
    parts.push(value);
  }
}

/** Script a complete single-step text turn on prompt delivery. */
/**
 * Script a turn that is delivered and mid-stream (one text delta), never
 * finishing — the shape an abort after delivery interrupts.
 */
function scriptDeliveredStreamingTurn(fake: FakePort): void {
  fake.hooks.onPrompt = (_input, receipt) => {
    const ev = eventFactory(SESSION_ID);
    fake.emit(
      {
        id: "evt_del",
        created: 2,
        type: "session.inbox.delivered",
        durable: { aggregateID: SESSION_ID, seq: 900, version: 1 },
        data: { sessionID: SESSION_ID, inboxID: receipt.id },
      } as V2Event,
      ev.executionStarted(),
      ev.stepStarted("msg_a"),
      ev.textStarted("msg_a", 0),
      ev.textDelta("msg_a", 0, "streaming…"),
    );
  };
}

/** Stream until the first text delta, abort, and wait for the interrupt. */
async function abortMidStream(
  model: OpencodeLanguageModel,
  fake: FakePort,
  controller: AbortController,
): Promise<void> {
  const result = await model.doStream(
    callOptions({ abortSignal: controller.signal }),
  );
  const reader = result.stream.getReader();
  for (;;) {
    const { value } = await reader.read();
    if (value?.type === "text-delta") {
      break;
    }
  }
  controller.abort();
  await reader.read().catch(() => undefined);
  await vi.waitFor(() => {
    expect(fake.callsFor("session.interrupt").length).toBe(1);
  });
}

function scriptTextTurn(fake: FakePort, text = "Hello world"): void {
  fake.hooks.onPrompt = (input, receipt) => {
    // Echo the session the prompt actually targeted: under `uniqueSessions`
    // each turn binds a different id, and events for the wrong session are
    // silently ignored by the pump (the turn would just hang).
    const SESSION_ID = String(input["sessionID"]);
    const ev = eventFactory(SESSION_ID);
    fake.emit(
      {
        id: "evt_del",
        created: 2,
        type: "session.inbox.delivered",
        durable: { aggregateID: SESSION_ID, seq: 900, version: 1 },
        data: { sessionID: SESSION_ID, inboxID: receipt.id },
      } as V2Event,
      ev.executionStarted(),
      ev.stepStarted("msg_a"),
      ev.textStarted("msg_a", 0),
      ev.textDelta("msg_a", 0, text.slice(0, 5)),
      ev.textDelta("msg_a", 0, text.slice(5)),
      ev.textEnded("msg_a", 0, text),
      ev.stepEnded("msg_a", "stop", tokens(10, 4, 1, 2, 0), 0.01),
      ev.executionSucceeded(),
    );
  };
}

// --- tests ---------------------------------------------------------------

describe("doGenerate: happy text turn", () => {
  it("prompts, reduces the event stream, and maps content/finish/usage/cost", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.usage.inputTokens).toEqual({
      total: 12,
      noCache: 10,
      cacheRead: 2,
      cacheWrite: 0,
    });
    expect(result.usage.outputTokens).toEqual({
      total: 4,
      text: undefined,
      reasoning: 1,
    });

    const opencode = result.providerMetadata?.opencode as Record<
      string,
      unknown
    >;
    expect(opencode).toMatchObject({
      sessionId: SESSION_ID,
      messageId: "msg_a",
      inboxId: "inbox_1",
      outcome: "succeeded",
      finish: "stop",
      cost: 0.01,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 1,
        cache: { read: 2, write: 0 },
      },
    });
    expect(result.response?.id).toBe("inbox_1");

    // Session established with the parsed model ref; provider default
    // delivery "queue" is always sent explicitly.
    const create = fake.callsFor("session.create")[0]!.input as Record<
      string,
      unknown
    >;
    expect(create["model"]).toEqual({
      id: "test-model",
      providerID: "test-provider",
    });
    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(prompt["delivery"]).toBe("queue");
    expect(prompt["text"]).toBe("Hi");

    // Subscribe happened before the prompt.
    const order = fake.calls.map((call) => call.method);
    expect(order.indexOf("event.subscribe")).toBeLessThan(
      order.indexOf("session.prompt"),
    );

    // doGenerate reconciles against the message store.
    expect(fake.callsFor("message.list").length).toBe(1);
    expect(model.getSessionId()).toBe(SESSION_ID);
  });

  it("reuses the pinned session on the second call and sends only the latest turn", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);
    await model.doGenerate(callOptions());

    scriptTextTurn(fake, "Second");
    await model.doGenerate(
      callOptions({
        prompt: [
          ...userPrompt("Hi"),
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
          },
          ...userPrompt("And again?"),
        ],
      }),
    );

    expect(fake.callsFor("session.create").length).toBe(1);
    const prompts = fake.callsFor("session.prompt");
    expect(prompts.length).toBe(2);
    expect((prompts[1]!.input as Record<string, unknown>)["text"]).toBe(
      "And again?",
    );
  });
});

describe("doStream", () => {
  it("emits stream-start, response-metadata, deltas, and an enriched finish part", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const parts = await collectStream(await model.doStream(callOptions()));

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts[1]).toMatchObject({
      type: "response-metadata",
      id: "inbox_1",
      modelId: "test-provider/test-model",
    });
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(
      (finish.providerMetadata?.opencode as Record<string, unknown>)["inboxId"],
    ).toBe("inbox_1");
  });

  it("passes includeRawChunks through to the reducer", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const parts = await collectStream(
      await model.doStream(callOptions({ includeRawChunks: true })),
    );
    expect(parts.some((part) => part.type === "raw")).toBe(true);
  });

  it("reports an error, keeping the streamed text, when the event stream ends and nothing shows the turn concluded", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "partial"),
      );
      fake.closeStream();
    };
    const model = createModel(fake);

    const parts = await collectStream(await model.doStream(callOptions()));
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.type).toBe("finish");
    // A clean end of the stream is a dropped stream: with no stored proof
    // the turn concluded, partial text is not reported as a success.
    expect(finish.finishReason.unified).toBe("error");
    expect(parts.some((part) => part.type === "error")).toBe(true);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as { delta: string }).delta)
        .join(""),
    ).toBe("partial");
    // The open text block was closed before the finish.
    expect(parts.some((part) => part.type === "text-end")).toBe(true);
  });

  it("finalizes on the session.idle backstop", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "done-ish"),
        ev.textEnded("msg_a", 0, "done-ish"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.sessionIdle(),
      );
    };
    const model = createModel(fake);

    const parts = await collectStream(await model.doStream(callOptions()));
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
  });
});

describe("multi-step tool turn", () => {
  it("streams tool lifecycle across two steps and finishes from the terminal event", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.toolInputStarted("msg_a", "tool_1", "write"),
        ev.toolInputDelta("msg_a", "tool_1", '{"path":'),
        ev.toolInputDelta("msg_a", "tool_1", '"x.txt"}'),
        ev.toolInputEnded("msg_a", "tool_1", '{"path":"x.txt"}'),
        ev.toolCalled("msg_a", "tool_1", { path: "x.txt" }),
        ev.toolSuccess("msg_a", "tool_1", [{ type: "text", text: "ok" }]),
        ev.stepEnded("msg_a", "tool-calls", tokens(100, 10), 0.02),
        ev.stepStarted("msg_b"),
        ev.textStarted("msg_b", 0),
        ev.textDelta("msg_b", 0, "Wrote the file."),
        ev.textEnded("msg_b", 0, "Wrote the file."),
        ev.stepEnded("msg_b", "stop", tokens(120, 6), 0.03),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content.map((entry) => entry.type)).toEqual([
      "tool-call",
      "tool-result",
      "text",
    ]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    const opencode = result.providerMetadata?.opencode as Record<
      string,
      unknown
    >;
    // Last step's message and summed usage across both steps.
    expect(opencode["messageId"]).toBe("msg_b");
    expect(result.usage.inputTokens.total).toBe(220);
    expect(result.usage.outputTokens.total).toBe(16);
    expect(opencode["cost"]).toBeCloseTo(0.05);
  });
});

describe("approvals: two-phase round-trip", () => {
  function scriptBlockedTurn(fake: FakePort): void {
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.toolInputStarted("msg_a", "tool_1", "bash"),
        ev.toolInputEnded("msg_a", "tool_1", '{"cmd":"rm x"}'),
        ev.permissionAsked("perm_1", {
          action: "bash.execute",
          resources: ["rm x"],
          source: { type: "tool", messageID: "msg_a", id: "tool_1" },
        }),
      );
      // The channel stays open: the server is blocked awaiting the reply.
    };
  }

  it("phase 1 surfaces the approval request and finishes on quiescence; phase 2 replies without prompting and returns the original execution's result", async () => {
    const fake = createFakePort();
    scriptBlockedTurn(fake);
    // createNewSession: approval continuation must still reattach.
    const model = createModel(
      fake,
      { createNewSession: true },
      { approvalIdleTimeoutMs: 25 },
    );

    // --- phase 1
    const phase1 = await model.doGenerate(callOptions());
    const approval = phase1.content.find(
      (entry) => entry.type === "tool-approval-request",
    );
    expect(approval).toMatchObject({
      approvalId: "perm_1",
      toolCallId: "tool_1",
    });
    const meta1 = phase1.providerMetadata?.opencode as Record<string, unknown>;
    expect(meta1["approvalRequestId"]).toBe("perm_1");
    expect(meta1["approvalRequestIds"]).toEqual(["perm_1"]);
    expect(meta1["sessionId"]).toBe(SESSION_ID);

    // --- phase 2
    fake.hooks.onPermissionReply = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        // A redelivered permission.asked must NOT resurface (deduped).
        ev.permissionAsked("perm_1", {
          source: { type: "tool", messageID: "msg_a", id: "tool_1" },
        }),
        ev.toolInputStarted("msg_a", "tool_1", "bash"),
        ev.toolInputEnded("msg_a", "tool_1", '{"cmd":"rm x"}'),
        ev.toolCalled("msg_a", "tool_1", { cmd: "rm x" }),
        ev.toolSuccess("msg_a", "tool_1", [{ type: "text", text: "gone" }]),
        ev.stepEnded("msg_a", "tool-calls", tokens(50, 5), 0.01),
        ev.stepStarted("msg_b"),
        ev.textStarted("msg_b", 0),
        ev.textDelta("msg_b", 0, "Removed."),
        ev.textEnded("msg_b", 0, "Removed."),
        ev.stepEnded("msg_b", "stop", tokens(60, 3), 0.01),
        ev.executionSucceeded(),
      );
    };
    const phase2Prompt: LanguageModelV4Prompt = [
      ...userPrompt("Hi"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool_1",
            toolName: "bash",
            input: '{"cmd":"rm x"}',
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "perm_1",
            approved: true,
          },
        ],
      },
    ];
    const phase2 = await model.doGenerate(
      callOptions({ prompt: phase2Prompt }),
    );

    // Never a second prompt; never a second session; one reply.
    expect(fake.callsFor("session.prompt").length).toBe(1);
    expect(fake.callsFor("session.create").length).toBe(1);
    const reply = fake.callsFor("permission.reply");
    expect(reply.length).toBe(1);
    expect(reply[0]!.input).toMatchObject({
      sessionID: SESSION_ID,
      requestID: "perm_1",
      decision: "once",
    });

    expect(
      phase2.content.filter((entry) => entry.type === "tool-approval-request"),
    ).toEqual([]);
    expect(phase2.content.map((entry) => entry.type)).toEqual([
      "tool-call",
      "tool-result",
      "text",
    ]);
    expect(phase2.finishReason).toEqual({ unified: "stop", raw: "stop" });
    const meta2 = phase2.providerMetadata?.opencode as Record<string, unknown>;
    expect(meta2["repliedApprovalIds"]).toEqual(["perm_1"]);

    // Replied approvals are deduped: a duplicate continuation call has
    // nothing to send and fails clearly instead of hanging.
    const duplicate = await model
      .doGenerate(callOptions({ prompt: phase2Prompt }))
      .catch((error: unknown) => error);
    expect(APICallError.isInstance(duplicate)).toBe(true);
    expect((duplicate as APICallError).isRetryable).toBe(false);
    expect(fake.callsFor("permission.reply").length).toBe(1);
  }, 10_000);

  it("maps a denied approval to reply 'reject' with the reason", async () => {
    const fake = createFakePort();
    scriptBlockedTurn(fake);
    const model = createModel(fake, {}, { approvalIdleTimeoutMs: 25 });
    await model.doGenerate(callOptions());

    fake.hooks.onPermissionReply = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.toolInputStarted("msg_a", "tool_1", "bash"),
        ev.toolInputEnded("msg_a", "tool_1", '{"cmd":"rm x"}'),
        ev.toolFailed("msg_a", "tool_1", {
          type: "permission_denied",
          message: "denied",
        }),
        ev.stepFailed("msg_a", {
          type: "permission_denied",
          message: "denied",
        }),
        ev.executionFailed({ type: "permission_denied", message: "denied" }),
      );
    };
    const result = await model.doGenerate(
      callOptions({
        prompt: [
          ...userPrompt("Hi"),
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "perm_1",
                approved: false,
                reason: "too risky",
              },
            ],
          },
        ],
      }),
    );
    expect(fake.callsFor("permission.reply")[0]!.input).toMatchObject({
      decision: "reject",
      message: "too risky",
    });
    expect(result.finishReason.unified).toBe("error");
  });

  it("surfaces a rejection as 2.0.24 reports it: interrupted with reason 'shutdown'", async () => {
    const fake = createFakePort();
    scriptBlockedTurn(fake);
    const model = createModel(fake, {}, { approvalIdleTimeoutMs: 25 });
    await model.doGenerate(callOptions());

    // Live 2.0.24 sequence: a decline interrupts the step without a reason,
    // which the server labels "shutdown" (core session/execution.ts).
    fake.hooks.onPermissionReply = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.toolFailed("msg_a", "tool_1", {
          type: "aborted",
          message: "The user declined this tool call",
        }),
        ev.stepFailed("msg_a", {
          type: "aborted",
          message: "Step interrupted",
        }),
        ev.executionInterrupted("shutdown"),
      );
    };
    const result = await model.doGenerate(
      callOptions({
        prompt: [
          ...userPrompt("Hi"),
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tool_1",
                toolName: "bash",
                input: '{"cmd":"rm x"}',
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "perm_1",
                approved: false,
              },
            ],
          },
        ],
      }),
    );
    expect(result.finishReason).toEqual({
      unified: "error",
      raw: "interrupted:shutdown",
    });
    // The name comes from the history's tool-call part: 2.0.24 does not
    // re-emit tool.input.started for the resumed tool.
    expect(
      result.content.find((entry) => entry.type === "tool-result"),
    ).toMatchObject({ toolCallId: "tool_1", toolName: "bash", isError: true });
    const meta = result.providerMetadata?.opencode as Record<string, unknown>;
    expect(meta["interruptReason"]).toBe("shutdown");
    expect(meta["repliedApprovalIds"]).toEqual(["perm_1"]);
  });

  it("does not warn about approval responses already replied in earlier turns", async () => {
    const fake = createFakePort();
    scriptBlockedTurn(fake);
    const warn = vi.fn();
    const model = createModel(
      fake,
      { logger: { warn, error: vi.fn() } },
      { approvalIdleTimeoutMs: 25 },
    );
    await model.doGenerate(callOptions());

    fake.hooks.onPermissionReply = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const phase2Prompt: LanguageModelV4Prompt = [
      ...userPrompt("Hi"),
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "perm_1",
            approved: true,
          },
        ],
      },
    ];
    await model.doGenerate(callOptions({ prompt: phase2Prompt }));

    // A later turn carries the replied approval as plain history.
    scriptTextTurn(fake);
    const followUp = await model.doGenerate(
      callOptions({ prompt: [...phase2Prompt, ...userPrompt("Next")] }),
    );
    const mixed = (text: string) => text.includes("mixes tool-approval");
    expect(
      followUp.warnings.some(
        (warning) => warning.type === "other" && mixed(warning.message),
      ),
    ).toBe(false);
    expect(warn.mock.calls.some(([text]) => mixed(String(text)))).toBe(false);
    expect(fake.callsFor("permission.reply").length).toBe(1);
  });

  it("finishes phase 1 on quiescence despite unrelated global events", async () => {
    const fake = createFakePort();
    scriptBlockedTurn(fake);
    const model = createModel(fake, {}, { approvalIdleTimeoutMs: 60 });

    const promise = model.doGenerate(callOptions());
    // Unrelated sessions keep the server-global subscription busy; only
    // THIS session's silence may count toward the quiescence deadline.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const noise = setInterval(() => {
      fake.emit({
        id: "evt_noise",
        created: Date.now(),
        type: "session.idle",
        data: { sessionID: "ses_other" },
      } as V2Event);
    }, 10);
    try {
      const result = await promise;
      expect(
        result.content.some((entry) => entry.type === "tool-approval-request"),
      ).toBe(true);
    } finally {
      clearInterval(noise);
    }
  });

  it("routes mixed-prompt approval replies to the approval's session, not the turn's", async () => {
    const fake = createFakePort();
    scriptBlockedTurn(fake);
    const model = createModel(
      fake,
      {},
      { approvalIdleTimeoutMs: 25, silenceWatchdogMs: 50 },
    );
    await model.doGenerate(callOptions()); // phase 1 blocks SESSION_ID

    // Mixed continuation (approval + new user content) targeting a
    // different caller-managed session via the escape hatch.
    fake.hooks.onPrompt = () => {
      const ev = eventFactory("ses_other");
      fake.emit(
        ev.stepStarted("msg_z"),
        ev.textStarted("msg_z", 0),
        ev.textEnded("msg_z", 0, "ok"),
        ev.stepEnded("msg_z", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const mixedPrompt: LanguageModelV4Prompt = [
      ...userPrompt("Hi"),
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "perm_1",
            approved: true,
          },
        ],
      },
      ...userPrompt("Also do this"),
    ];
    const result = await model.doGenerate(
      callOptions({
        prompt: mixedPrompt,
        providerOptions: { opencode: { sessionId: "ses_other" } },
      }),
    );

    // No predecessor runs on the prompt's session: its own terminal (with
    // no execution.started observed) ends the call with its own answer.
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });

    // The reply lands on the blocked session; the prompt on the turn's.
    expect(fake.callsFor("permission.reply")[0]!.input).toMatchObject({
      sessionID: SESSION_ID,
      requestID: "perm_1",
    });
    expect(fake.callsFor("session.prompt")[1]!.input).toMatchObject({
      sessionID: "ses_other",
    });
  });
});

describe("forms", () => {
  it("answers a form via onForm with keyed answers", async () => {
    const fake = createFakePort();
    const onForm = vi.fn().mockResolvedValue({
      type: "answer",
      answer: { color: "red" },
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.formCreated("form_1", "Pick a color", [
          { key: "color", type: "string", title: "Color", required: true },
        ]),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "Red it is."),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake, { onForm });

    const result = await model.doGenerate(callOptions());
    const meta = result.providerMetadata?.opencode as Record<string, unknown>;
    expect(meta["formIds"]).toEqual(["form_1"]);
    await vi.waitFor(() => {
      expect(fake.callsFor("form.reply").length).toBe(1);
    });
    expect(onForm).toHaveBeenCalledTimes(1);
    expect(fake.callsFor("form.reply")[0]!.input).toEqual({
      sessionID: SESSION_ID,
      formID: "form_1",
      answer: { color: "red" },
    });
    expect(fake.callsFor("form.cancel")).toEqual([]);
  });

  it("cancels the form under the default policy when no handler is configured", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.formCreated("form_2", "Pick", [
          { key: "x", type: "string", title: "X" },
        ]),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "ok"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake);

    await model.doGenerate(callOptions());
    await vi.waitFor(() => {
      expect(fake.callsFor("form.cancel").length).toBe(1);
    });
    expect(fake.callsFor("form.cancel")[0]!.input).toEqual({
      sessionID: SESSION_ID,
      formID: "form_2",
    });
  });

  it("cancels the form when the handler throws", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.formCreated("form_3", "Pick", [
          { key: "x", type: "string", title: "X" },
        ]),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "ok"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake, {
      onForm: () => {
        throw new Error("handler exploded");
      },
    });

    await model.doGenerate(callOptions());
    await vi.waitFor(() => {
      expect(fake.callsFor("form.cancel").length).toBe(1);
    });
  });

  it("retries a transiently failing form reply within the turn", async () => {
    const fake = createFakePort();
    // Nothing redelivers a form within a turn: a transient reply failure
    // must be retried by the model's own machinery.
    let replyAttempts = 0;
    (fake.port.session.form as { reply: unknown }).reply = (
      input: unknown,
      options?: OpencodeRequestOptions,
    ) => {
      fake.calls.push({ method: "form.reply", input, options });
      replyAttempts += 1;
      return replyAttempts === 1
        ? Promise.reject({
            name: "ClientError",
            reason: "Transport",
            message: "blip",
            cause: new Error("blip"),
          })
        : Promise.resolve(undefined);
    };
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.formCreated("form_r", "Pick", [
          { key: "x", type: "string", title: "X" },
        ]),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "ok"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake, {
      onForm: vi.fn().mockResolvedValue({ type: "answer", answer: { x: "y" } }),
    });

    await model.doGenerate(callOptions());
    await vi.waitFor(
      () => {
        expect(fake.callsFor("form.reply").length).toBe(2);
      },
      { timeout: 2000 },
    );
  });

  it("leaves the form pending under formPolicy 'wait' with no handler", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.formCreated("form_4", "Pick", [
          { key: "x", type: "string", title: "X" },
        ]),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "ok"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake, { formPolicy: "wait" });

    await model.doGenerate(callOptions());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.callsFor("form.reply")).toEqual([]);
    expect(fake.callsFor("form.cancel")).toEqual([]);
  });
});

describe("abort", () => {
  it("cancels the undelivered inbox item on abort before delivery", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      // No events: the prompt sits undelivered in the inbox.
    };
    const controller = new AbortController();
    const model = createModel(fake);

    const result = await model.doStream(
      callOptions({ abortSignal: controller.signal }),
    );
    const consumed = collectStream(result).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await vi.waitFor(() => {
      expect(fake.callsFor("session.inbox.cancel").length).toBe(1);
    });
    const cancel = fake.callsFor("session.inbox.cancel")[0]!;
    expect(cancel.input).toEqual({
      sessionID: SESSION_ID,
      inboxID: "inbox_1",
    });
    // Cleanup never carries the aborted call signal — only its own bound.
    expect(cancel.options?.signal).toBeDefined();
    expect(cancel.options?.signal).not.toBe(controller.signal);
    expect(cancel.options?.signal?.aborted).toBe(false);
    // The successful cancel is confirmed against the message store before
    // cleanup concludes: not stored ⇒ not delivered ⇒ no interrupt.
    await vi.waitFor(() => {
      expect(fake.callsFor("session.message.get").length).toBe(1);
    });
    expect(fake.callsFor("session.message.get")[0]!.input).toEqual({
      sessionID: SESSION_ID,
      messageID: "inbox_1",
    });
    await consumed;
    expect(fake.callsFor("session.interrupt")).toEqual([]);
  });

  it("interrupts when a successful inbox.cancel hid an already-delivered item", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      // No events observed: the provider believes the item is undelivered,
      // but the server already promoted it (cancel is then a no-op 204).
    };
    fake.hooks.storedMessageIds = new Set(["inbox_1"]);
    const controller = new AbortController();
    const model = createModel(fake);

    const result = await model.doStream(
      callOptions({ abortSignal: controller.signal }),
    );
    const consumed = collectStream(result).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await vi.waitFor(() => {
      expect(fake.callsFor("session.interrupt").length).toBe(1);
    });
    expect(fake.callsFor("session.inbox.cancel").length).toBe(1);
    expect(fake.callsFor("session.interrupt")[0]!.input).toEqual({
      sessionID: SESSION_ID,
      resume: false,
    });
    await consumed;
  });

  it("holds the next turn until abort cleanup (incl. its interrupt) settles", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      // First prompt: no events — undelivered as far as the client knows.
    };
    fake.hooks.storedMessageIds = new Set(["inbox_1"]);
    // Delay the delivery lookup so a racing second call would dispatch
    // before cleanup's interrupt is sent.
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const getStored = fake.port.session.message.get;
    (fake.port.session.message as { get: unknown }).get = async (
      input: { sessionID: string; messageID: string },
      options?: OpencodeRequestOptions,
    ) => {
      await lookupGate;
      return getStored(input, options);
    };
    const controller = new AbortController();
    const model = createModel(fake);

    const first = await model.doStream(
      callOptions({ abortSignal: controller.signal }),
    );
    const firstConsumed = collectStream(first).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await firstConsumed;

    // Start the next call while cleanup is parked on the lookup.
    scriptTextTurn(fake);
    const second = model.doGenerate(callOptions());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.callsFor("session.prompt").length).toBe(1);

    releaseLookup();
    const result = await second;
    expect(result.finishReason.unified).toBe("stop");
    // The interrupt was sent, and strictly before the second prompt.
    const order = fake.calls.map((call) => call.method);
    const interruptAt = order.indexOf("session.interrupt");
    const secondPromptAt = order.lastIndexOf("session.prompt");
    expect(interruptAt).toBeGreaterThan(-1);
    expect(interruptAt).toBeLessThan(secondPromptAt);
  });

  it("holds the next turn until the interrupted execution has settled", async () => {
    // 2.x acknowledges session.interrupt before the execution's cleanup
    // finishes; its terminal event is published later. The next turn must
    // not subscribe/dispatch until session.wait confirms the session idle.
    const fake = createFakePort();
    scriptDeliveredStreamingTurn(fake);
    let releaseSettle!: () => void;
    const settled = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    (fake.port.session as { wait: unknown }).wait = (
      input: unknown,
      options?: OpencodeRequestOptions,
    ) => {
      fake.calls.push({ method: "session.wait", input, options });
      return settled.then(() => undefined);
    };
    const controller = new AbortController();
    const model = createModel(fake);

    await abortMidStream(model, fake, controller);

    scriptTextTurn(fake);
    const second = model.doGenerate(callOptions());
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Interrupt acknowledged, execution not yet settled: no new dispatch.
    expect(fake.callsFor("session.prompt").length).toBe(1);

    releaseSettle();
    const result = await second;
    expect(fake.callsFor("session.prompt").length).toBe(2);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("re-checks an unconfirmed settlement before the next dispatch", async () => {
    const fake = createFakePort();
    scriptDeliveredStreamingTurn(fake);
    // Every wait fails: settlement can never be confirmed.
    fake.hooks.waitError = { _tag: "UnknownError", message: "boom" };
    const controller = new AbortController();
    const model = createModel(fake);

    await abortMidStream(model, fake, controller);

    scriptTextTurn(fake);
    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(true);
    expect(fake.callsFor("session.prompt").length).toBe(1);

    // Once the server confirms settlement, the session is usable again.
    fake.hooks.waitError = undefined;
    const result = await model.doGenerate(callOptions());
    expect(result.finishReason.unified).toBe("stop");
    expect(fake.callsFor("session.prompt").length).toBe(2);
  });

  it("ignores a previous execution's events still in transit ahead of this turn's delivery", async () => {
    // The 2.x client shares one SSE connection; an earlier execution's
    // terminal (published before this prompt was even accepted) can reach
    // this turn's fresh subscription. SSE order puts it ahead of the turn's
    // own `inbox.delivered`.
    const fake = createFakePort({ manualDelivery: true });
    fake.hooks.onPrompt = (_input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        // Stale: the interrupted previous execution.
        ev.stepStarted("msg_old"),
        ev.textStarted("msg_old", 0),
        ev.textDelta("msg_old", 0, "old partial"),
        ev.executionInterrupted("user"),
        // This turn.
        {
          id: "evt_del",
          created: 2,
          type: "session.inbox.delivered",
          durable: { aggregateID: SESSION_ID, seq: 900, version: 1 },
          data: { sessionID: SESSION_ID, inboxID: receipt.id },
        } as V2Event,
        ev.executionStarted(),
        ev.stepStarted("msg_new"),
        ev.textStarted("msg_new", 0),
        ev.textDelta("msg_new", 0, "fresh answer"),
        ev.textEnded("msg_new", 0, "fresh answer"),
        ev.stepEnded("msg_new", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "fresh answer" }]);
  });

  it("drops an aborted turn's delayed permission ask ahead of this turn's delivery", async () => {
    // The interrupted execution's pending permission is removed server-side
    // without a permission.replied; its delayed ask must not surface as a
    // phantom approval in the next turn.
    const fake = createFakePort({ manualDelivery: true });
    fake.hooks.onPrompt = (input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_old"),
        ev.toolInputStarted("msg_old", "tool_old", "shell"),
        ev.permissionAsked("per_old", {
          action: "shell",
          source: {
            type: "tool",
            messageID: "msg_old",
            id: "tool_old",
          } as never,
        }),
        ev.formCreated("form_old", "Old form", []),
        ev.executionInterrupted("user"),
        {
          id: "evt_enq",
          created: 2,
          type: "session.inbox.enqueued",
          durable: { aggregateID: SESSION_ID, seq: 899, version: 1 },
          data: {
            sessionID: SESSION_ID,
            inboxID: receipt.id,
            item: {
              type: "user",
              payload: { text: String(input["text"]) },
              delivery: "queue",
            },
          },
        } as V2Event,
        ev.executionStarted(),
        ev.stepStarted("msg_new"),
        ev.textStarted("msg_new", 0),
        ev.textDelta("msg_new", 0, "second answer"),
        ev.textEnded("msg_new", 0, "second answer"),
        ev.stepEnded("msg_new", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const onForm = vi.fn(() => ({ type: "cancel" as const }));
    const model = createModel(fake, { onForm });

    const result = await model.doGenerate(callOptions());
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "second answer" }]);
    const metadata = result.providerMetadata?.opencode as Record<
      string,
      unknown
    >;
    expect(metadata["approvalRequestId"]).toBeUndefined();
    expect(onForm).not.toHaveBeenCalled();
    expect(fake.callsFor("form.cancel")).toEqual([]);
  });

  it("drops an earlier turn's delayed retry record but keeps this turn's", async () => {
    const overloaded = {
      type: "provider_overloaded",
      message: "overloaded",
    } as never;
    const fake = createFakePort({ manualDelivery: true });
    fake.hooks.onPrompt = (_input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.retryScheduled("msg_old", 3, 1, overloaded),
        ev.executionInterrupted("user"),
        {
          id: "evt_del",
          created: 2,
          type: "session.inbox.delivered",
          durable: { aggregateID: SESSION_ID, seq: 900, version: 1 },
          data: { sessionID: SESSION_ID, inboxID: receipt.id },
        } as V2Event,
        ev.executionStarted(),
        ev.stepStarted("msg_new"),
        ev.textStarted("msg_new", 0),
        ev.textDelta("msg_new", 0, "second answer"),
        ev.textEnded("msg_new", 0, "second answer"),
        ev.stepEnded("msg_new", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake);
    const result = await model.doGenerate(callOptions());
    const metadata = result.providerMetadata?.opencode as Record<
      string,
      unknown
    >;
    expect(metadata["retry"]).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "second answer" }]);

    // A retry scheduled AFTER this turn's delivery is genuine and kept.
    fake.hooks.onPrompt = (_input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        {
          id: "evt_del2",
          created: 2,
          type: "session.inbox.delivered",
          durable: { aggregateID: SESSION_ID, seq: 901, version: 1 },
          data: { sessionID: SESSION_ID, inboxID: receipt.id },
        } as V2Event,
        ev.executionStarted(),
        ev.stepStarted("msg_b"),
        ev.retryScheduled("msg_b", 1, 1, overloaded),
        ev.textStarted("msg_b", 0),
        ev.textDelta("msg_b", 0, "after retry"),
        ev.textEnded("msg_b", 0, "after retry"),
        ev.stepEnded("msg_b", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const second = await model.doGenerate(callOptions());
    const meta2 = second.providerMetadata?.opencode as Record<string, unknown>;
    expect(meta2["retry"]).toBeDefined();
  });

  it("interrupts the running execution on abort after delivery", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "streaming…"),
      );
    };
    const controller = new AbortController();
    const model = createModel(fake);

    const result = await model.doStream(
      callOptions({ abortSignal: controller.signal }),
    );
    const reader = result.stream.getReader();
    // Consume until the first delta proves delivery was observed.
    for (;;) {
      const { value } = await reader.read();
      if (value?.type === "text-delta") {
        break;
      }
    }
    controller.abort();

    await vi.waitFor(() => {
      expect(fake.callsFor("session.interrupt").length).toBe(1);
    });
    expect(fake.callsFor("session.interrupt")[0]!.input).toEqual({
      sessionID: SESSION_ID,
      resume: false,
    });
    expect(fake.callsFor("session.inbox.cancel")).toEqual([]);
    // The quiet end of the aborted subscription must not finalize the turn
    // as a normal finish: the stream rejects with the abort reason.
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return "closed";
          }
          if (value.type === "finish") {
            return "finished";
          }
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("falls back to interrupt when inbox.cancel fails", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      // No events: undelivered from the client's point of view — but the
      // item may have been delivered in the unobserved window.
    };
    (fake.port.session.inbox as { cancel: unknown }).cancel = (
      input: unknown,
      options?: OpencodeRequestOptions,
    ) => {
      fake.calls.push({ method: "session.inbox.cancel", input, options });
      return Promise.reject({
        _tag: "InvalidRequestError",
        message: "already delivered",
      });
    };
    const controller = new AbortController();
    const model = createModel(fake);

    const result = await model.doStream(
      callOptions({ abortSignal: controller.signal }),
    );
    const consumed = collectStream(result).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await vi.waitFor(() => {
      expect(fake.callsFor("session.interrupt").length).toBe(1);
    });
    expect(fake.callsFor("session.inbox.cancel").length).toBe(1);
    await consumed;
  });

  it("runs server-side cleanup when the signal fires during dispatch", async () => {
    const controller = new AbortController();
    const fake = createFakePort({
      promptError: () => {
        controller.abort();
        return { name: "AbortError", message: "aborted" };
      },
    });
    const model = createModel(fake);

    await expect(
      model.doGenerate(callOptions({ abortSignal: controller.signal })),
    ).rejects.toThrow();
    // No receipt exists, so cleanup interrupts the session (the prompt may
    // still have reached the server).
    await vi.waitFor(() => {
      expect(fake.callsFor("session.interrupt").length).toBe(1);
    });
  });

  it("throws immediately when the signal is already aborted", async () => {
    const fake = createFakePort();
    const controller = new AbortController();
    controller.abort();
    const model = createModel(fake);
    await expect(
      model.doGenerate(callOptions({ abortSignal: controller.signal })),
    ).rejects.toThrow();
    expect(fake.callsFor("session.prompt")).toEqual([]);
  });
});

describe("busy sessions", () => {
  it("retries once with delivery 'queue' on SessionBusyError", async () => {
    const fake = createFakePort({
      promptError: (attempt) =>
        attempt === 1
          ? { _tag: "SessionBusyError", message: "busy", sessionID: SESSION_ID }
          : undefined,
    });
    const model = createModel(fake, { delivery: "steer" });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "ok"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };

    const result = await model.doGenerate(callOptions());
    const prompts = fake.callsFor("session.prompt");
    expect(prompts.length).toBe(2);
    expect((prompts[0]!.input as Record<string, unknown>)["delivery"]).toBe(
      "steer",
    );
    expect((prompts[1]!.input as Record<string, unknown>)["delivery"]).toBe(
      "queue",
    );
    // The busy retry re-sends the same prompt id (one logical prompt).
    const id0 = (prompts[0]!.input as Record<string, unknown>)["id"];
    expect(id0).toMatch(/^msg_/);
    expect((prompts[1]!.input as Record<string, unknown>)["id"]).toBe(id0);
    expect(result.finishReason.unified).toBe("stop");
  });

  it("surfaces a non-retryable error when the queue retry is also rejected", async () => {
    const fake = createFakePort({
      promptError: () => ({
        _tag: "SessionBusyError",
        message: "busy",
        sessionID: SESSION_ID,
      }),
    });
    const model = createModel(fake, { delivery: "steer" });

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(fake.callsFor("session.prompt").length).toBe(2);
  });

  it("retries once on ConflictError under the default 'queue' delivery", async () => {
    // The prompt route's declared thrown union carries ConflictError (409)
    // for a busy session, not SessionBusyError; and the retry must run even
    // when the original delivery was already the provider default "queue".
    const fake = createFakePort({
      promptError: (attempt) =>
        attempt === 1
          ? { _tag: "ConflictError", message: "conflict" }
          : undefined,
    });
    const model = createModel(fake);
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textEnded("msg_a", 0, "ok"),
        ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };

    const result = await model.doGenerate(callOptions());
    const prompts = fake.callsFor("session.prompt");
    expect(prompts.length).toBe(2);
    expect((prompts[0]!.input as Record<string, unknown>)["delivery"]).toBe(
      "queue",
    );
    expect((prompts[1]!.input as Record<string, unknown>)["delivery"]).toBe(
      "queue",
    );
    expect(result.finishReason.unified).toBe("stop");
  });

  it("surfaces a persistent ConflictError non-retryable after the queue retry", async () => {
    const fake = createFakePort({
      promptError: () => ({ _tag: "ConflictError", message: "conflict" }),
    });
    const model = createModel(fake);

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(fake.callsFor("session.prompt").length).toBe(2);
  });
});

describe("post-dispatch failure reconciliation", () => {
  it("reconciles a mid-turn transport failure from the message store instead of surfacing a retryable error", async () => {
    const fake = createFakePort({
      waitError: {
        _tag: "ServiceUnavailableError",
        message: "Session wait is not available yet",
      },
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "Hello world" }],
          finish: "stop",
          cost: 0.02,
          tokens: tokens(10, 5, 0, 0, 0),
        },
      ],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "Hello"),
      );
      setTimeout(() => {
        fake.failStream({
          name: "ClientError",
          reason: "Transport",
          message: "socket hang up",
          cause: new Error("socket hang up"),
        });
      }, 10);
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    // The partially-streamed block was completed from the stored message.
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.usage.inputTokens.total).toBe(10);
    // Two wait calls: the execution-start watchdog (rejected by waitError,
    // internally absorbed) and the reconciliation's bounded wait.
    expect(fake.callsFor("session.wait").length).toBe(2);
    expect(fake.callsFor("message.list").length).toBeGreaterThan(0);
  });

  it("degrades to a non-retryable error part when reconciliation also fails", async () => {
    const fake = createFakePort();
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(ev.stepStarted("msg_a"));
      setTimeout(() => {
        fake.failStream({
          name: "ClientError",
          reason: "Transport",
          message: "socket hang up",
          cause: new Error("boom"),
        });
      }, 10);
    };
    // message.list also fails.
    (fake.port.message as { list: unknown }).list = () =>
      Promise.reject({
        name: "ClientError",
        reason: "Transport",
        message: "still down",
        cause: new Error("down"),
      });
    const model = createModel(fake);

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    const apiError = error as APICallError;
    expect(apiError.isRetryable).toBe(false);
    expect(
      (apiError.data as { reconcile?: boolean } | undefined)?.reconcile,
    ).toBe(true);
  });
});

describe("readiness handshake", () => {
  it("proceeds after the bounded race when server.connected never arrives", async () => {
    const warn = vi.fn();
    const fake = createFakePort({ suppressServerConnected: true });
    scriptTextTurn(fake);
    const model = new OpencodeLanguageModel(
      "test-provider/test-model",
      { logger: { warn, error: vi.fn() } },
      { getPort: () => fake.port, readinessTimeoutMs: 20 },
    );

    const result = await model.doGenerate(callOptions());
    expect(result.finishReason.unified).toBe("stop");
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("readiness handshake timed out"),
      ),
    ).toBe(true);
  });
});

describe("headers propagation", () => {
  it("merges undefined-filtered per-call headers into every port request of the generation", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const onForm = vi.fn().mockResolvedValue({ type: "cancel" });
    const model = createModel(fake, { onForm });
    const original = fake.hooks.onPrompt!;
    fake.hooks.onPrompt = (input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.formCreated("form_h", "F", [
          { key: "x", type: "string", title: "X" },
        ]),
      );
      original(input, receipt);
    };

    const headers = { authorization: "Bearer secret", "x-omitted": undefined };
    await model.doGenerate(callOptions({ headers }));
    await vi.waitFor(() => {
      expect(fake.callsFor("form.cancel").length).toBe(1);
    });

    expect(fake.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of fake.calls) {
      expect(
        call.options?.headers,
        `headers missing on ${call.method}`,
      ).toEqual({ authorization: "Bearer secret" });
    }
  });
});

describe("call-option degradations", () => {
  it("warns on unsupported sampling params and appends the JSON instruction for responseFormat json", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const result = await model.doGenerate(
      callOptions({
        temperature: 0.5,
        topP: 0.9,
        responseFormat: {
          type: "json",
          schema: { type: "object", properties: { a: { type: "string" } } },
        },
      }),
    );

    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "unsupported" && warning.feature.includes("json"),
      ),
    ).toBe(true);
    expect(
      result.warnings.filter((warning) => warning.type === "other").length,
    ).toBeGreaterThanOrEqual(2);
    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(String(prompt["text"])).toContain("valid JSON only");
    expect(String(prompt["text"])).toContain('"a"');
  });

  it("degrades the system prompt into the turn's text when the server has no instruction-entry route", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake, { systemPrompt: "Be terse." });

    const result = await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in French." },
          ...userPrompt("Bonjour?"),
        ],
      }),
    );
    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(String(prompt["text"])).toContain("<<<opencode:system>>>");
    expect(String(prompt["text"])).toContain("Be terse.");
    expect(String(prompt["text"])).toContain("Answer in French.");
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "unsupported" && warning.feature === "system prompt",
      ),
    ).toBe(true);
  });

  it("writes the system prompt as an instruction entry — no prepend, no warning", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake, { systemPrompt: "Be terse." });

    const result = await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in French." },
          ...userPrompt("Bonjour?"),
        ],
      }),
    );

    const put = fake.callsFor("session.instructions.entry.put")[0]!
      .input as Record<string, unknown>;
    expect(put["key"]).toBe("ai-sdk.system");
    expect(put["value"]).toBe("Be terse.\n\nAnswer in French.");
    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(String(prompt["text"])).not.toContain("<<<opencode:system>>>");
    expect(String(prompt["text"])).toBe("Bonjour?");
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "unsupported" && warning.feature === "system prompt",
      ),
    ).toBe(false);
  });

  it("does not rewrite an unchanged instruction entry on a later turn", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake, { systemPrompt: "Be terse." });

    await model.doGenerate(callOptions());
    scriptTextTurn(fake);
    await model.doGenerate(callOptions());

    // A redundant put would announce another durable system message.
    expect(fake.callsFor("session.instructions.entry.put").length).toBe(1);
  });

  it("removes the entry when a later call carries no system content", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake);

    await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in French." },
          ...userPrompt("Bonjour?"),
        ],
      }),
    );
    scriptTextTurn(fake);
    await model.doGenerate(callOptions());

    const remove = fake.callsFor("session.instructions.entry.remove")[0]!
      .input as Record<string, unknown>;
    expect(remove["key"]).toBe("ai-sdk.system");
    // A stale system prompt must not leak into the second turn's text.
    const second = fake.callsFor("session.prompt")[1]!.input as Record<
      string,
      unknown
    >;
    expect(String(second["text"])).not.toContain("Answer in French.");
  });

  it("falls back to the prepend when the system prompt exceeds the entry size cap", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    // cap - 1 raw chars encode to cap + 1 JSON bytes — one over the cap.
    const oversized = "y".repeat(INSTRUCTION_VALUE_MAX_BYTES - 1);
    const model = createModel(fake, { systemPrompt: oversized });

    const result = await model.doGenerate(callOptions());

    expect(fake.callsFor("session.instructions.entry.put")).toEqual([]);
    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(String(prompt["text"])).toContain("<<<opencode:system>>>");
    const warning = result.warnings.find(
      (candidate) =>
        candidate.type === "unsupported" &&
        candidate.feature === "system prompt",
    );
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning)).toContain(
      `${INSTRUCTION_VALUE_MAX_BYTES + 1} bytes`,
    );
  });

  it("falls back to the prepend when the entry write fails", async () => {
    const fake = createFakePort({
      instructionEntries: true,
      instructionPutError: { _tag: "SessionBusyError", message: "busy" },
    });
    scriptTextTurn(fake);
    const model = createModel(fake, { systemPrompt: "Be terse." });

    const result = await model.doGenerate(callOptions());

    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(String(prompt["text"])).toContain("Be terse.");
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "unsupported" && warning.feature === "system prompt",
      ),
    ).toBe(true);
  });

  it("retries the entry write on a later turn when the failure was not a missing route", async () => {
    const fake = createFakePort({
      instructionEntries: true,
      instructionPutError: { _tag: "SessionBusyError", message: "busy" },
    });
    scriptTextTurn(fake);
    const model = createModel(fake, { systemPrompt: "Be terse." });

    await model.doGenerate(callOptions());
    scriptTextTurn(fake);
    await model.doGenerate(callOptions());

    // A transient failure must not downgrade the whole conversation.
    expect(fake.callsFor("session.instructions.entry.put").length).toBe(2);
  });

  it("bounds the per-session entry cache under createNewSession", async () => {
    const fake = createFakePort({
      instructionEntries: true,
      uniqueSessions: true,
    });
    const model = createModel(fake, {
      systemPrompt: "Be terse.",
      createNewSession: true,
    });

    // 34 fresh sessions with a 32-entry cache: the first two are evicted,
    // but every call still writes exactly once — eviction must never cause
    // a *missing* write, only (at worst) a redundant one on revisit.
    for (let index = 0; index < 34; index += 1) {
      scriptTextTurn(fake);
      await model.doGenerate(callOptions());
    }

    expect(fake.callsFor("session.create").length).toBe(34);
    expect(fake.callsFor("session.instructions.entry.put").length).toBe(34);
  });

  it("stops probing the route after an explicit 404", async () => {
    const notFound = Object.assign(new Error("no such route"), {
      name: "ClientError",
      reason: "StatusCode",
      cause: { status: 404 },
    });
    const fake = createFakePort({
      instructionEntries: true,
      instructionPutError: notFound,
    });
    scriptTextTurn(fake);
    const model = createModel(fake, { systemPrompt: "Be terse." });

    await model.doGenerate(callOptions());
    scriptTextTurn(fake);
    await model.doGenerate(callOptions());

    expect(fake.callsFor("session.instructions.entry.put").length).toBe(1);
  });

  it("clears the written entry when a later prompt is too large to write", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake);

    await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in French." },
          ...userPrompt("Bonjour?"),
        ],
      }),
    );
    scriptTextTurn(fake);
    // cap - 1 raw chars encode to cap + 1 JSON bytes — one over the cap.
    const oversized = "y".repeat(INSTRUCTION_VALUE_MAX_BYTES - 1);
    const result = await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: oversized },
          ...userPrompt("Encore?"),
        ],
      }),
    );

    // Leaving "Answer in French." in the entry would keep a stale system
    // prompt outranking the prepended one the caller actually asked for.
    expect(fake.callsFor("session.instructions.entry.remove").length).toBe(1);
    const second = fake.callsFor("session.prompt")[1]!.input as Record<
      string,
      unknown
    >;
    expect(String(second["text"])).toContain(oversized);
    const warning = result.warnings.find(
      (candidate) =>
        candidate.type === "unsupported" &&
        candidate.feature === "system prompt",
    );
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning)).not.toContain("may still apply");
  });

  it("clears the written entry when a later write fails", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake);

    await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in French." },
          ...userPrompt("Bonjour?"),
        ],
      }),
    );
    fake.hooks.instructionPutError = {
      _tag: "SessionBusyError",
      message: "busy",
    };
    scriptTextTurn(fake);
    await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in German." },
          ...userPrompt("Hallo?"),
        ],
      }),
    );

    expect(fake.callsFor("session.instructions.entry.remove").length).toBe(1);
    const second = fake.callsFor("session.prompt")[1]!.input as Record<
      string,
      unknown
    >;
    expect(String(second["text"])).toContain("Answer in German.");
  });

  it("warns when the stale entry could not be removed", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake);

    await model.doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "Answer in French." },
          ...userPrompt("Bonjour?"),
        ],
      }),
    );
    fake.hooks.instructionRemoveError = {
      _tag: "SessionBusyError",
      message: "busy",
    };
    scriptTextTurn(fake);
    const result = await model.doGenerate(callOptions());

    // No system content to prepend, but the session is still governed by an
    // entry this call asked to drop — silence would be a lie.
    const warning = result.warnings.find(
      (candidate) =>
        candidate.type === "unsupported" &&
        candidate.feature === "system prompt",
    );
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning)).toContain("could not be removed");
  });

  it("does not clear the entry on a fresh session that carries no system content", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake);

    await model.doGenerate(callOptions());

    // A session created a moment ago has no entries: no request needed.
    expect(fake.callsFor("session.instructions.entry.remove")).toEqual([]);
  });

  it("reconciles a session of unknown entry state instead of assuming it is empty", async () => {
    const fake = createFakePort({ instructionEntries: true });
    scriptTextTurn(fake);
    const model = createModel(fake);

    // A caller-supplied session this instance never wrote to — the same
    // state an evicted cache entry leaves behind. Assuming "empty" would
    // let an `ai-sdk.system` entry written earlier keep governing the turn.
    await model.doGenerate(
      callOptions({
        providerOptions: { opencode: { sessionId: "ses_unknown" } },
      }),
    );

    const remove = fake.callsFor("session.instructions.entry.remove")[0]!
      .input as Record<string, unknown>;
    expect(remove["sessionID"]).toBe("ses_unknown");
    expect(remove["key"]).toBe("ai-sdk.system");
  });

  it("survives cache eviction: a revisited session is still reconciled", async () => {
    const fake = createFakePort({ instructionEntries: true });
    const model = createModel(fake);
    const withSystem = (system: string, sessionId: string) =>
      callOptions({
        prompt: [{ role: "system", content: system }, ...userPrompt("Hi")],
        providerOptions: { opencode: { sessionId } },
      });

    scriptTextTurn(fake);
    await model.doGenerate(withSystem("Answer in French.", "ses_first"));
    // 32 further sessions push `ses_first` out of the 32-entry cache.
    for (let index = 0; index < 32; index += 1) {
      scriptTextTurn(fake);
      await model.doGenerate(withSystem("Be terse.", `ses_${index}`));
    }
    scriptTextTurn(fake);
    await model.doGenerate(
      callOptions({
        providerOptions: { opencode: { sessionId: "ses_first" } },
      }),
    );

    // Eviction must degrade to "unknown", not "empty": reading a forgotten
    // session as empty would leave "Answer in French." governing the turn.
    expect(
      fake
        .callsFor("session.instructions.entry.remove")
        .some(
          (call) =>
            (call.input as Record<string, unknown>)["sessionID"] ===
            "ses_first",
        ),
    ).toBe(true);
  });
});

describe("session modes and provider options", () => {
  it("validates and pins an existing session (sessionId) without creating one", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake, {
      sessionId: SESSION_ID,
      sessionMode: "existing",
    });

    await model.doGenerate(callOptions());
    expect(fake.callsFor("session.get").length).toBe(1);
    expect(fake.callsFor("session.create")).toEqual([]);

    // Validation happens once per instance.
    scriptTextTurn(fake);
    await model.doGenerate(callOptions());
    expect(fake.callsFor("session.get").length).toBe(1);
  });

  it("providerOptions.opencode.sessionId targets that session for the call", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    await model.doGenerate(
      callOptions({
        providerOptions: {
          opencode: { sessionId: SESSION_ID, id: "msg_custom" },
        },
      }),
    );
    expect(fake.callsFor("session.create")).toEqual([]);
    const prompt = fake.callsFor("session.prompt")[0]!.input as Record<
      string,
      unknown
    >;
    expect(prompt["sessionID"]).toBe(SESSION_ID);
    expect(prompt["id"]).toBe("msg_custom");
  });

  it("createNewSession creates a fresh session per ordinary call", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake, { createNewSession: true });
    await model.doGenerate(callOptions());
    scriptTextTurn(fake);
    await model.doGenerate(callOptions());
    expect(fake.callsFor("session.create").length).toBe(2);
  });

  it("omits the model ref for a bare model ID (server default applies)", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = new OpencodeLanguageModel(
      "bare-model",
      { logger: false },
      { getPort: () => fake.port },
    );
    await model.doGenerate(callOptions());
    const create = fake.callsFor("session.create")[0]!.input as Record<
      string,
      unknown
    >;
    expect(create["model"]).toBeUndefined();
    expect(fake.callsFor("model.list")).toEqual([]);
  });

  it("resolves a bare model ID + variant through the catalog", async () => {
    const fake = createFakePort({
      models: [
        { id: "bare-model", modelID: "bare-model", providerID: "prov-a" },
      ],
    });
    scriptTextTurn(fake);
    const model = new OpencodeLanguageModel(
      "bare-model",
      { logger: false, variant: "fast" },
      { getPort: () => fake.port },
    );
    await model.doGenerate(callOptions());
    expect(fake.callsFor("model.list").length).toBe(1);
    const create = fake.callsFor("session.create")[0]!.input as Record<
      string,
      unknown
    >;
    expect(create["model"]).toEqual({
      id: "bare-model",
      providerID: "prov-a",
      variant: "fast",
    });
  });

  it("rejects a bare model ID + variant the catalog cannot disambiguate", async () => {
    // A non-empty catalog is authoritative immediately (no settle wait).
    const fake = createFakePort({
      models: [
        { id: "other-model", modelID: "other-model", providerID: "prov-a" },
      ],
    });
    const model = new OpencodeLanguageModel(
      "bare-model",
      { logger: false, variant: "fast" },
      { getPort: () => fake.port },
    );
    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(fake.callsFor("session.create")).toEqual([]);
    expect(fake.callsFor("model.list").length).toBe(1);
  });

  it("re-polls a cold (empty) catalog until the server fills it", async () => {
    const fake = createFakePort({ models: [] });
    scriptTextTurn(fake);
    setTimeout(() => {
      fake.hooks.models = [
        { id: "bare-model", modelID: "bare-model", providerID: "prov-a" },
      ];
    }, 300);
    const model = new OpencodeLanguageModel(
      "bare-model",
      { logger: false, variant: "fast" },
      { getPort: () => fake.port, catalogSettleMs: 5_000 },
    );
    await model.doGenerate(callOptions());
    expect(fake.callsFor("model.list").length).toBeGreaterThan(1);
    const create = fake.callsFor("session.create")[0]!.input as Record<
      string,
      unknown
    >;
    expect(create["model"]).toEqual({
      id: "bare-model",
      providerID: "prov-a",
      variant: "fast",
    });
  });

  it("fails retryably when the catalog stays empty past the settle window", async () => {
    const fake = createFakePort({ models: [] });
    const model = new OpencodeLanguageModel(
      "bare-model",
      { logger: false, variant: "fast" },
      { getPort: () => fake.port, catalogSettleMs: 100 },
    );
    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(true);
    expect((error as APICallError).message).toContain("catalog is still empty");
    expect(fake.callsFor("session.create")).toEqual([]);
  });

  it("stops polling a cold catalog when the call is aborted", async () => {
    const fake = createFakePort({ models: [] });
    const model = new OpencodeLanguageModel(
      "bare-model",
      { logger: false, variant: "fast" },
      { getPort: () => fake.port, catalogSettleMs: 60_000 },
    );
    const controller = new AbortController();
    const pending = model
      .doGenerate(callOptions({ abortSignal: controller.signal }))
      .catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
    const polls = fake.callsFor("model.list").length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fake.callsFor("model.list").length).toBe(polls);
    expect(fake.callsFor("session.create")).toEqual([]);
  });
});

describe("turn serialization", () => {
  it("serializes concurrent calls on one instance (no session-create race, no cross-talk)", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const [first, second] = await Promise.all([
      model.doGenerate(callOptions()),
      model.doGenerate(callOptions()),
    ]);

    // Without serialization both initial calls race session.create and both
    // pumps read the same session's events.
    expect(fake.callsFor("session.create").length).toBe(1);
    expect(fake.callsFor("session.prompt").length).toBe(2);
    expect(first.finishReason.unified).toBe("stop");
    expect(second.finishReason.unified).toBe("stop");
  });
});

describe("dispatch-failure reconciliation", () => {
  it("reconciles an uncertain prompt delivery through the session instead of rethrowing", async () => {
    const fake = createFakePort({
      promptError: () => ({
        name: "ClientError",
        reason: "Transport",
        message: "socket hang up",
        cause: new Error("hang"),
      }),
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "Made it anyway" }],
          finish: "stop",
          cost: 0.01,
          tokens: tokens(7, 3, 0, 0, 0),
        },
      ],
    });
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Made it anyway" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    // Never retried the prompt itself, reconciled instead.
    expect(fake.callsFor("session.prompt").length).toBe(1);
    expect(fake.callsFor("message.list").length).toBeGreaterThan(0);
  });

  it("degrades to a non-retryable error when nothing was dispatched or stored", async () => {
    const fake = createFakePort({
      promptError: () => ({
        name: "ClientError",
        reason: "Transport",
        message: "socket hang up",
        cause: new Error("hang"),
      }),
      messages: [],
    });
    const model = createModel(fake);

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
  });
});

describe("caller abort during message-store recovery", () => {
  const storedTurn = () => [
    {
      id: "msg_a",
      type: "assistant",
      time: { created: Date.now() + 10_000 },
      agent: "default",
      model: { id: "test-model", providerID: "test-provider" },
      content: [{ type: "text", text: "recovered text" }],
      finish: "stop",
      cost: 0,
      tokens: tokens(1, 1, 0, 0, 0),
    },
  ];

  /**
   * Park `message.list` until the caller aborts; like the real client, the
   * parked read then rejects with the abort. Resolves `listing` once the
   * recovery read is in flight.
   */
  function parkMessageList(fake: FakePort): Promise<void> {
    return parkRead(fake, "message.list");
  }

  type ParkedRoute =
    | "message.list"
    | "permission.list"
    | "form.list"
    | "generate.text";

  /** Park one read route until the caller's signal aborts it. */
  function parkRead(fake: FakePort, route: ParkedRoute): Promise<void> {
    let entered!: () => void;
    const listing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = {
      "message.list": fake.port.message,
      "permission.list": fake.port.permission,
      "form.list": fake.port.session.form,
      "generate.text": fake.port.generate,
    }[route] as Record<string, unknown>;
    const key = route === "generate.text" ? "text" : "list";
    owner[key] = (input: unknown, options?: OpencodeRequestOptions) => {
      fake.calls.push({ method: route, input, options });
      entered();
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        const fail = () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
        // Without a signal the read would hang forever; the test then
        // fails on its own timeout.
      });
    };
    return listing;
  }

  type Scenario = {
    name: string;
    setup: () => {
      fake: FakePort;
      config: Partial<OpencodeLanguageModelConfig>;
    };
  };
  const scenarios: Scenario[] = [
    {
      name: "lost-response recovery",
      setup: () => {
        const fake = createFakePort({
          promptError: () => ({
            name: "ClientError",
            reason: "Transport",
            message: "socket hang up",
          }),
          inboxItems: [],
          messages: storedTurn(),
        });
        return { fake, config: { deliveryEvidenceWindowMs: 20 } };
      },
    },
    {
      name: "silence watchdog",
      setup: () => {
        const fake = createFakePort({
          waitError: { _tag: "ServiceUnavailableError", message: "n/a" },
          messages: storedTurn(),
        });
        fake.hooks.onPrompt = () => {
          const ev = eventFactory(SESSION_ID);
          fake.emit(ev.executionStarted(), ev.stepStarted("msg_a"));
        };
        return { fake, config: { silenceWatchdogMs: 20 } };
      },
    },
    {
      name: "wait watchdog",
      setup: () => {
        // wait resolves instantly (fake default) while no terminal arrives.
        const fake = createFakePort({ messages: storedTurn() });
        fake.hooks.onPrompt = () => {
          const ev = eventFactory(SESSION_ID);
          fake.emit(ev.executionStarted(), ev.stepStarted("msg_a"));
        };
        return { fake, config: {} };
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`doGenerate rejects, emitting nothing, when aborted during ${scenario.name}`, async () => {
      const { fake, config } = scenario.setup();
      const listing = parkMessageList(fake);
      const controller = new AbortController();
      const model = createModel(fake, undefined, config);
      const pending = model
        .doGenerate(callOptions({ abortSignal: controller.signal }))
        .catch((caught: unknown) => caught);
      await listing;
      controller.abort();
      const error = await pending;
      expect((error as Error).name).toBe("AbortError");
    });

    it(`doStream rejects with no text or finish when aborted during ${scenario.name}`, async () => {
      const { fake, config } = scenario.setup();
      const listing = parkMessageList(fake);
      const controller = new AbortController();
      const model = createModel(fake, undefined, config);
      const result = await model.doStream(
        callOptions({ abortSignal: controller.signal }),
      );
      const reader = result.stream.getReader();
      const afterAbort: string[] = [];
      let aborted = false;
      void listing.then(() => {
        aborted = true;
        controller.abort();
      });
      const error = await (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return undefined;
          }
          if (aborted) {
            afterAbort.push(value.type);
          }
        }
      })().catch((caught: unknown) => caught);
      expect((error as Error | undefined)?.name).toBe("AbortError");
      expect(afterAbort).not.toContain("text-delta");
      expect(afterAbort).not.toContain("text-start");
      expect(afterAbort).not.toContain("finish");
    });
  }

  // Interaction reads (permission/form lists) run first in recovery; they
  // must be cancellable too, and an aborted call must release the slot.
  for (const scenario of scenarios.filter(
    (candidate) => candidate.name !== "wait watchdog",
  )) {
    for (const route of ["permission.list", "form.list"] as const) {
      for (const api of ["generate", "stream"] as const) {
        it(`${api} rejects promptly when aborted during ${route} in ${scenario.name}, releasing the slot`, async () => {
          const { fake, config } = scenario.setup();
          const parked = parkRead(fake, route);
          const controller = new AbortController();
          const model = createModel(fake, undefined, config);
          const run = async (): Promise<unknown> => {
            if (api === "generate") {
              return model.doGenerate(
                callOptions({ abortSignal: controller.signal }),
              );
            }
            const result = await model.doStream(
              callOptions({ abortSignal: controller.signal }),
            );
            const reader = result.stream.getReader();
            for (;;) {
              const { done } = await reader.read();
              if (done) {
                return undefined;
              }
            }
          };
          const pending = run().catch((caught: unknown) => caught);
          await parked;
          controller.abort();
          const error = await pending;
          expect((error as Error | undefined)?.name).toBe("AbortError");

          // The slot is free: a fresh call on the instance dispatches (once
          // the server can confirm the interrupted execution settled — the
          // silence scenario's failing wait otherwise keeps the session
          // gated, by design).
          const prompts = fake.callsFor("session.prompt").length;
          fake.hooks.promptError = undefined;
          fake.hooks.waitError = undefined;
          scriptTextTurn(fake);
          (fake.port.permission as { list: unknown }).list = () =>
            Promise.resolve([]);
          (fake.port.session.form as { list: unknown }).list = () =>
            Promise.resolve([]);
          await model.doGenerate(callOptions());
          expect(fake.callsFor("session.prompt").length).toBe(prompts + 1);
        });
      }
    }
  }

  // Stream-consumer cancellation (reader.cancel()) is not a caller abort —
  // the call signal never fires — yet it must cancel in-flight recovery
  // reads too, or the pump keeps the instance's turn slot.
  const cancelCases: Array<{ scenario: string; route: ParkedRoute }> = [
    { scenario: "lost-response recovery", route: "permission.list" },
    { scenario: "lost-response recovery", route: "form.list" },
    { scenario: "lost-response recovery", route: "message.list" },
    { scenario: "silence watchdog", route: "permission.list" },
    { scenario: "silence watchdog", route: "form.list" },
    { scenario: "wait watchdog", route: "message.list" },
  ];
  for (const { scenario: name, route } of cancelCases) {
    it(`consumer cancel during ${route} in ${name} cancels the read and frees the slot`, async () => {
      const scenario = scenarios.find((candidate) => candidate.name === name)!;
      const { fake, config } = scenario.setup();
      const parked = parkRead(fake, route);
      const model = createModel(fake, undefined, config);
      // Also with an un-aborted caller signal supplied.
      const result = await model.doStream(
        callOptions({ abortSignal: new AbortController().signal }),
      );
      const reader = result.stream.getReader();
      const drained = (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) {
              return;
            }
          }
        } catch {
          /* cancelled */
        }
      })();
      await parked;
      await reader.cancel();
      await drained;
      const parkedCall = fake.calls.filter((call) => call.method === route)[0]!;
      expect(parkedCall.options?.signal?.aborted).toBe(true);

      // The slot is free without releasing the parked read by hand.
      const prompts = fake.callsFor("session.prompt").length;
      fake.hooks.promptError = undefined;
      fake.hooks.waitError = undefined;
      scriptTextTurn(fake);
      (fake.port.permission as { list: unknown }).list = () =>
        Promise.resolve([]);
      (fake.port.session.form as { list: unknown }).list = () =>
        Promise.resolve([]);
      (fake.port.message as { list: unknown }).list = () =>
        Promise.resolve({ location: { directory: "/tmp" }, data: [] });
      await model.doGenerate(callOptions());
      expect(fake.callsFor("session.prompt").length).toBe(prompts + 1);
    });
  }

  it("doGenerate rejects when aborted during its final message-store reconciliation", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const parked = parkMessageList(fake);
    const controller = new AbortController();
    const model = createModel(fake);
    const pending = model
      .doGenerate(callOptions({ abortSignal: controller.signal }))
      .catch((caught: unknown) => caught);
    await parked;
    controller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
  });

  it("doGenerate rejects when aborted during JSON repair, without returning repaired output", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake, "not json at all");
    const parked = parkRead(fake, "generate.text");
    const controller = new AbortController();
    const model = createModel(fake, { jsonRepair: { maxAttempts: 3 } });
    const pending = model
      .doGenerate(
        callOptions({
          abortSignal: controller.signal,
          responseFormat: {
            type: "json",
            schema: { type: "object", properties: { a: { type: "number" } } },
          },
        }),
      )
      .catch((caught: unknown) => caught);
    await parked;
    controller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
    // No further repair attempts after the abort.
    expect(fake.callsFor("generate.text").length).toBe(1);
  });
});

describe("silence watchdog", () => {
  it("finalizes from the message store when the stream goes silent after the session settled", async () => {
    const fake = createFakePort({
      // Wait 503s: the execution-start wait watchdog disarms itself, so
      // completion detection falls to the silence probe under test here.
      waitError: {
        _tag: "ServiceUnavailableError",
        message: "Session wait is not available yet",
      },
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "Hello world" }],
          finish: "stop",
          cost: 0.02,
          tokens: tokens(10, 5, 0, 0, 0),
        },
      ],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      // The stream loses everything after step start — no terminal, no idle.
      fake.emit(ev.executionStarted(), ev.stepStarted("msg_a"));
    };
    const model = createModel(fake, {}, { silenceWatchdogMs: 20 });

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.usage.inputTokens.total).toBe(10);
    expect(fake.callsFor("permission.list").length).toBeGreaterThan(0);
    expect(fake.callsFor("form.list").length).toBeGreaterThan(0);
    expect(fake.callsFor("session.wait").length).toBeGreaterThan(0);
  });

  it("surfaces a pending permission the stream never delivered (phase-1 finish)", async () => {
    const fake = createFakePort({
      permissions: [
        {
          id: "perm_9",
          sessionID: SESSION_ID,
          action: "fs.write",
          resources: ["/x"],
        },
      ],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(ev.executionStarted(), ev.stepStarted("msg_a"));
    };
    const model = createModel(fake, {}, { silenceWatchdogMs: 20 });

    const result = await model.doGenerate(callOptions());
    const approval = result.content.find(
      (entry) => entry.type === "tool-approval-request",
    );
    expect(approval).toMatchObject({ approvalId: "perm_9" });
    const meta = result.providerMetadata?.opencode as Record<string, unknown>;
    expect(meta["approvalRequestId"]).toBe("perm_9");
  });
});

describe("doGenerate message reconciliation", () => {
  it("restores reasoning, tool calls/results, and usage the stream lost", async () => {
    const fake = createFakePort({
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [
            { type: "reasoning", text: "thinking…" },
            {
              type: "tool",
              id: "tool_1",
              name: "bash",
              executed: true,
              state: {
                status: "completed",
                input: { cmd: "ls" },
                content: [{ type: "text", text: "files" }],
              },
            },
            { type: "text", text: "Done." },
          ],
          finish: "stop",
          cost: 0.02,
          tokens: tokens(12, 6, 2, 0, 0),
        },
      ],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      // Partial SSE loss: only the terminal made it through.
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual(
      expect.arrayContaining([
        { type: "reasoning", text: "thinking…" },
        { type: "text", text: "Done." },
        expect.objectContaining({ type: "tool-call", toolCallId: "tool_1" }),
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "tool_1",
          isError: false,
        }),
      ]),
    );
    expect(result.usage.inputTokens.total).toBe(12);
    expect(result.usage.outputTokens.total).toBe(6);
    expect(result.usage.outputTokens.reasoning).toBe(2);
  });

  it("does not duplicate streamed text when reasoning and text share ordinal 0", async () => {
    // The server numbers text and reasoning fragments with separate
    // counters, so a reasoning model's step streams `reasoning#0` and
    // `text#0` and is stored as [reasoning, text].
    const fake = createFakePort({
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [
            { type: "reasoning", text: "thinking…" },
            { type: "text", text: "Done." },
          ],
          finish: "stop",
          cost: 0,
          tokens: tokens(12, 6, 2, 0, 0),
        },
      ],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.reasoningStarted("msg_a", 0),
        ev.reasoningDelta("msg_a", 0, "thinking…"),
        ev.textStarted("msg_a", 0),
        ev.reasoningEnded("msg_a", 0, "thinking…"),
        ev.textDelta("msg_a", 0, "Done."),
        ev.textEnded("msg_a", 0, "Done."),
        ev.stepEnded("msg_a", "stop", tokens(12, 6, 2, 0, 0), 0),
        ev.executionSucceeded(),
      );
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([
      { type: "reasoning", text: "thinking…" },
      { type: "text", text: "Done." },
    ]);
  });
});

describe("unsupported tools", () => {
  it("warns when caller-defined tools or toolChoice are supplied", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const result = await model.doGenerate(
      callOptions({
        tools: [
          { type: "function", name: "myTool", inputSchema: {} },
        ] as LanguageModelV4CallOptions["tools"],
      }),
    );
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "other" &&
          warning.message.includes("Custom tool definitions"),
      ),
    ).toBe(true);
  });

  it("warns for a non-default toolChoice without tools", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);

    const result = await model.doGenerate(
      callOptions({ toolChoice: { type: "required" } }),
    );
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "other" &&
          warning.message.includes("Custom tool definitions"),
      ),
    ).toBe(true);
  });

  it("stays quiet for the AI SDK's default toolChoice with no tools", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const warn = vi.fn();
    const model = createModel(fake, { logger: { warn, error: vi.fn() } });

    // generateText/streamText always pass `{ type: "auto" }` and `tools`
    // undefined when the caller supplied none.
    const result = await model.doGenerate(
      callOptions({ toolChoice: { type: "auto" } }),
    );
    expect(result.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("session.wait watchdog", () => {
  it("is a no-op on a healthy turn (armed once, completion stays event-driven)", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const warn = vi.fn();
    const model = createModel(fake, {
      logger: { warn, error: vi.fn() },
    });

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    // Exactly the armed watchdog — no bounded re-wait, no recovery path.
    expect(fake.callsFor("session.wait").length).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("finalizes from the message store when wait resolves but the terminal event was lost", async () => {
    const fake = createFakePort({
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "Hello world" }],
          finish: "stop",
          cost: 0.02,
          tokens: tokens(10, 5, 0, 0, 0),
        },
      ],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      // Stream loses everything after the first delta — no terminal event.
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "Hello"),
      );
    };
    // Silence watchdog far beyond the test timeout: completing at all
    // proves the wait watchdog (not the silence probe) drove recovery.
    const model = createModel(fake, {}, { silenceWatchdogMs: 60_000 });

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.usage.inputTokens.total).toBe(10);
  });

  it("keeps listening when wait resolves without stored proof of conclusion (events stay primary)", async () => {
    const fake = createFakePort({ messages: [] });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(ev.executionStarted(), ev.stepStarted("msg_a"));
      // The turn is genuinely still running: the rest arrives later, after
      // the (spuriously resolved) wait watchdog has been consumed.
      setTimeout(() => {
        const late = eventFactory(SESSION_ID);
        fake.emit(
          late.textStarted("msg_a", 0),
          late.textDelta("msg_a", 0, "Hello world"),
          late.textEnded("msg_a", 0, "Hello world"),
          late.stepEnded("msg_a", "stop", tokens(10, 4, 1, 2, 0), 0.01),
          late.executionSucceeded(),
        );
      }, 100);
    };
    const model = createModel(fake, {}, { silenceWatchdogMs: 60_000 });

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
  });

  it("absorbs a wait failure internally (phase rule): the turn completes from events", async () => {
    const fake = createFakePort({
      waitError: {
        _tag: "ServiceUnavailableError",
        message: "Session wait is not available yet",
      },
    });
    scriptTextTurn(fake);
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(fake.callsFor("session.wait").length).toBe(1);
  });
});

describe("prompt ids", () => {
  it("sends a fresh OpenCode-format msg_ id per prompt, or the caller's", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);
    await model.doGenerate(callOptions());
    await model.doGenerate(callOptions());
    await model.doGenerate(
      callOptions({ providerOptions: { opencode: { id: "msg_caller_1" } } }),
    );
    const ids = fake
      .callsFor("session.prompt")
      .map((call) => (call.input as Record<string, unknown>)["id"]);
    expect(ids[0]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(ids[1]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(String(ids[0]) < String(ids[1])).toBe(true);
    expect(ids[2]).toBe("msg_caller_1");
  });
});

describe("delivery-uncertainty inbox reconciliation", () => {
  const transportError = () => ({
    name: "ClientError",
    reason: "Transport",
    message: "socket hang up",
    cause: new Error("hang"),
  });

  function inboxEvent(
    type: "session.inbox.enqueued" | "session.inbox.delivered",
    data: Record<string, unknown>,
  ): V2Event {
    return {
      id: `evt_${type}_${String(data["inboxID"])}`,
      created: 1,
      type,
      durable: { aggregateID: SESSION_ID, seq: 0, version: 1 },
      data: { sessionID: SESSION_ID, ...data },
    } as V2Event;
  }

  /** The prompt id the provider sent (it always sends one). */
  function sentPromptId(fake: FakePort): string {
    const input = fake.callsFor("session.prompt")[0]!.input as {
      id?: string;
    };
    return input.id!;
  }

  function pendingUserItem(
    text: string,
    id = "msg_u1",
  ): Record<string, unknown> {
    return {
      id,
      sessionID: SESSION_ID,
      timeCreated: Date.now(),
      type: "user",
      payload: { text },
      delivery: "queue",
    };
  }

  it("adopts an enqueued prompt as the receipt and keeps observing the turn", async () => {
    const fake = createFakePort({ promptError: () => transportError() });
    fake.hooks.inboxItems = () => {
      // The prompt WAS enqueued: the turn runs shortly after the check.
      setTimeout(() => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          inboxEvent("session.inbox.delivered", {
            inboxID: sentPromptId(fake),
          }),
          ev.executionStarted(),
          ev.stepStarted("msg_a"),
          ev.textStarted("msg_a", 0),
          ev.textDelta("msg_a", 0, "Hello world"),
          ev.textEnded("msg_a", 0, "Hello world"),
          ev.stepEnded("msg_a", "stop", tokens(10, 4, 1, 2, 0), 0.01),
          ev.executionSucceeded(),
        );
      }, 10);
      return [pendingUserItem("Hi", sentPromptId(fake))];
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    // The pending inbox item became this turn's receipt.
    expect(result.response?.id).toBe(sentPromptId(fake));
    expect(fake.callsFor("session.inbox.list").length).toBe(1);
    expect(fake.callsFor("session.prompt").length).toBe(1);
  });

  it("keeps observing when delivery outran the inbox check (pending-only inbox)", async () => {
    const fake = createFakePort({ promptError: () => transportError() });
    fake.hooks.inboxItems = () => {
      // The prompt was already delivered: the pending row is gone (the beta
      // inbox table is pending-only), and the running turn's events arrive
      // on the live subscription during the evidence window — preceded, as
      // on the real server, by the prompt's own inbox events (matched by
      // text: the lost response left no receipt id).
      setTimeout(() => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          inboxEvent("session.inbox.enqueued", {
            inboxID: sentPromptId(fake),
            item: { type: "user", payload: { text: "Hi" }, delivery: "queue" },
          }),
          inboxEvent("session.inbox.delivered", {
            inboxID: sentPromptId(fake),
          }),
          ev.executionStarted(),
          ev.stepStarted("msg_a"),
          ev.textStarted("msg_a", 0),
          ev.textDelta("msg_a", 0, "Hello world"),
          ev.textEnded("msg_a", 0, "Hello world"),
          ev.stepEnded("msg_a", "stop", tokens(10, 4, 1, 2, 0), 0.01),
          ev.executionSucceeded(),
        );
      }, 10);
      return [];
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(fake.callsFor("session.inbox.list").length).toBe(1);
    expect(fake.callsFor("session.prompt").length).toBe(1);
  });

  it("does not take an earlier execution's in-transit terminal as delivery evidence after a lost response", async () => {
    const fake = createFakePort({ promptError: () => transportError() });
    fake.hooks.inboxItems = () => {
      setTimeout(() => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          // Stale: the previous (interrupted) execution, still in transit.
          ev.stepStarted("msg_old"),
          ev.textDelta("msg_old", 0, "old partial"),
          ev.executionInterrupted("user"),
          // This turn: accepted despite the lost response.
          inboxEvent("session.inbox.enqueued", {
            inboxID: sentPromptId(fake),
            item: { type: "user", payload: { text: "Hi" }, delivery: "queue" },
          }),
          ev.executionStarted(),
          inboxEvent("session.inbox.delivered", {
            inboxID: sentPromptId(fake),
          }),
          ev.stepStarted("msg_a"),
          ev.textStarted("msg_a", 0),
          ev.textDelta("msg_a", 0, "Hello world"),
          ev.textEnded("msg_a", 0, "Hello world"),
          ev.stepEnded("msg_a", "stop", tokens(10, 4, 1, 2, 0), 0.01),
          ev.executionSucceeded(),
        );
      }, 10);
      return [];
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("keeps stale-event isolation after adopting a receipt from inbox.list", async () => {
    const fake = createFakePort({ promptError: () => transportError() });
    fake.hooks.inboxItems = () => {
      setTimeout(() => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          ev.executionInterrupted("user"),
          inboxEvent("session.inbox.delivered", {
            inboxID: sentPromptId(fake),
          }),
          ev.executionStarted(),
          ev.stepStarted("msg_a"),
          ev.textStarted("msg_a", 0),
          ev.textDelta("msg_a", 0, "Hello world"),
          ev.textEnded("msg_a", 0, "Hello world"),
          ev.stepEnded("msg_a", "stop", tokens(10, 4, 1, 2, 0), 0.01),
          ev.executionSucceeded(),
        );
      }, 10);
      return [pendingUserItem("Hi", sentPromptId(fake))];
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.response?.id).toBe(sentPromptId(fake));
  });

  it("ignores an earlier call's delayed identical-text inbox events after a lost response", async () => {
    // An earlier call with the SAME text was aborted before any of its
    // events arrived; they are all still in transit on the shared SSE
    // connection when this call's prompt response is lost. Only this
    // call's own prompt id may end isolation.
    const fake = createFakePort({ promptError: () => transportError() });
    fake.hooks.inboxItems = () => {
      setTimeout(() => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          inboxEvent("session.inbox.enqueued", {
            inboxID: "msg_earlier",
            item: { type: "user", payload: { text: "Hi" }, delivery: "queue" },
          }),
          ev.executionStarted(),
          inboxEvent("session.inbox.delivered", { inboxID: "msg_earlier" }),
          ev.stepStarted("msg_old"),
          ev.textStarted("msg_old", 0),
          ev.textDelta("msg_old", 0, "first"),
          ev.executionInterrupted("user"),
          inboxEvent("session.inbox.enqueued", {
            inboxID: sentPromptId(fake),
            item: { type: "user", payload: { text: "Hi" }, delivery: "queue" },
          }),
          ev.executionStarted(),
          inboxEvent("session.inbox.delivered", {
            inboxID: sentPromptId(fake),
          }),
          ev.stepStarted("msg_a"),
          ev.textStarted("msg_a", 0),
          ev.textDelta("msg_a", 0, "second answer"),
          ev.textEnded("msg_a", 0, "second answer"),
          ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
          ev.executionSucceeded(),
        );
      }, 10);
      return [];
    };
    const model = createModel(fake);

    const result = await model.doGenerate(callOptions());
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.content).toEqual([{ type: "text", text: "second answer" }]);
  });

  it("rejects a caller abort during lost-response recovery (doGenerate)", async () => {
    const fake = createFakePort({
      promptError: () => transportError(),
      inboxItems: [],
      // Stored partial content recovery could otherwise finalize from.
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "partial" }],
        },
      ],
    });
    const controller = new AbortController();
    const model = createModel(fake, undefined, {
      deliveryEvidenceWindowMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await model
      .doGenerate(callOptions({ abortSignal: controller.signal }))
      .catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("AbortError");
  });

  it("rejects a caller abort during lost-response recovery (doStream)", async () => {
    const fake = createFakePort({
      promptError: () => transportError(),
      inboxItems: [],
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: Date.now() + 10_000 },
          agent: "default",
          model: { id: "test-model", providerID: "test-provider" },
          content: [{ type: "text", text: "partial" }],
        },
      ],
    });
    const controller = new AbortController();
    const model = createModel(fake, undefined, {
      deliveryEvidenceWindowMs: 5_000,
    });
    const result = await model.doStream(
      callOptions({ abortSignal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    const parts: string[] = [];
    const error = await (async () => {
      const reader = result.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return undefined;
        }
        parts.push(value.type);
      }
    })().catch((caught: unknown) => caught);
    expect((error as Error | undefined)?.name).toBe("AbortError");
    expect(parts).not.toContain("finish");
    expect(parts).not.toContain("text-delta");
  });

  it("surfaces the non-retryable error when the inbox shows the prompt was never enqueued", async () => {
    const fake = createFakePort({
      promptError: () => transportError(),
      inboxItems: [],
      messages: [],
    });
    const model = createModel(fake);

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(fake.callsFor("session.inbox.list").length).toBe(1);
  });

  it("does not match a pending item with different text (foreign inbox item)", async () => {
    const fake = createFakePort({
      promptError: () => transportError(),
      inboxItems: [pendingUserItem("something else entirely")],
      messages: [],
    });
    const model = createModel(fake);

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
  });

  it("falls back to message reconciliation when the inbox check itself fails", async () => {
    const fake = createFakePort({
      promptError: () => transportError(),
      inboxListError: transportError(),
      messages: [],
    });
    const model = createModel(fake);

    const error = await model
      .doGenerate(callOptions())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect(fake.callsFor("session.inbox.list").length).toBe(1);
    // The existing reconciliation path still ran after the failed check.
    expect(fake.callsFor("message.list").length).toBeGreaterThan(0);
  });
});

describe("JSON validate/repair loop", () => {
  const JSON_FORMAT = {
    type: "json" as const,
    schema: { type: "object", properties: { a: { type: "number" } } },
  };

  it("is disabled by default: invalid output passes through with no repair call", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake, "not json at all");
    const model = createModel(fake);

    const result = await model.doGenerate(
      callOptions({ responseFormat: JSON_FORMAT }),
    );
    expect(result.content).toEqual([{ type: "text", text: "not json at all" }]);
    expect(fake.callsFor("generate.text").length).toBe(0);
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "unsupported" &&
          warning.feature.includes("responseFormat"),
      ),
    ).toBe(true);
  });

  it("does not call repair when the output validates first try", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake, '{"a": 1}');
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({ responseFormat: JSON_FORMAT }),
    );
    expect(result.content).toEqual([{ type: "text", text: '{"a": 1}' }]);
    expect(fake.callsFor("generate.text").length).toBe(0);
  });

  it("repairs invalid output via generate.text and records the attempts", async () => {
    const fake = createFakePort({
      generateText: () => ({ text: '```json\n{"a": 1}\n```' }),
    });
    scriptTextTurn(fake, "Sure! Here you go: {a: 1}");
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({ responseFormat: JSON_FORMAT }),
    );
    // Code fence stripped, text content replaced with the repaired JSON.
    expect(result.content).toEqual([{ type: "text", text: '{"a": 1}' }]);
    const calls = fake.callsFor("generate.text");
    expect(calls.length).toBe(1);
    const input = calls[0]!.input as { prompt: string; model?: unknown };
    expect(input.prompt).toContain("Sure! Here you go");
    expect(input.prompt).toContain('"properties"');
    expect(input.model).toEqual({
      id: "test-model",
      providerID: "test-provider",
    });
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "other" &&
          warning.message.includes("repaired via generate.text"),
      ),
    ).toBe(true);
  });

  it("repairs a schema top-level type mismatch (valid JSON, wrong shape)", async () => {
    const fake = createFakePort({
      generateText: () => ({ text: '{"a": 2}' }),
    });
    scriptTextTurn(fake, "[1, 2]");
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({ responseFormat: JSON_FORMAT }),
    );
    expect(result.content).toEqual([{ type: "text", text: '{"a": 2}' }]);
    expect(fake.callsFor("generate.text").length).toBe(1);
  });

  it("repairs output that parses but violates the schema (property type)", async () => {
    const fake = createFakePort({
      generateText: () => ({ text: '{"a": 1}' }),
    });
    scriptTextTurn(fake, '{"a": "wrong"}');
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: { a: { type: "number" } },
            required: ["a"],
          },
        },
      }),
    );
    expect(result.content).toEqual([{ type: "text", text: '{"a": 1}' }]);
    expect(fake.callsFor("generate.text").length).toBe(1);
  });

  it("repairs deep schema violations: missing required, bad enum, wrong item type", async () => {
    const NESTED_FORMAT = {
      type: "json" as const,
      schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["alpha", "beta"] },
          nested: {
            type: "object",
            properties: {
              counts: { type: "array", items: { type: "integer" } },
            },
            required: ["counts"],
          },
        },
        required: ["kind", "nested"],
        additionalProperties: false,
      },
    };
    const fake = createFakePort({
      generateText: () => ({
        text: '{"kind": "alpha", "nested": {"counts": [1, 2]}}',
      }),
    });
    // Bad enum member AND a non-integer array item AND an extra property.
    scriptTextTurn(
      fake,
      '{"kind": "gamma", "nested": {"counts": [1.5]}, "extra": true}',
    );
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({ responseFormat: NESTED_FORMAT }),
    );
    expect(result.content).toEqual([
      { type: "text", text: '{"kind": "alpha", "nested": {"counts": [1, 2]}}' },
    ]);
    expect(fake.callsFor("generate.text").length).toBe(1);
  });

  it("rejects a repair that still violates the schema (attempts exhausted)", async () => {
    const fake = createFakePort({
      generateText: () => ({ text: '{"a": "still wrong"}' }),
    });
    scriptTextTurn(fake, '{"a": "wrong"}');
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: { a: { type: "number" } },
            required: ["a"],
          },
        },
      }),
    );
    // The schema-invalid repair is NOT accepted; the original output stands.
    expect(result.content).toEqual([{ type: "text", text: '{"a": "wrong"}' }]);
    expect(fake.callsFor("generate.text").length).toBe(1);
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "other" &&
          warning.message.includes("repair attempt(s) were exhausted"),
      ),
    ).toBe(true);
  });

  it("keeps the original output after exhausting bounded attempts", async () => {
    const fake = createFakePort({
      generateText: () => ({ text: "still not json" }),
    });
    scriptTextTurn(fake, "not json");
    const model = createModel(fake, { jsonRepair: { maxAttempts: 2 } });

    const result = await model.doGenerate(
      callOptions({ responseFormat: JSON_FORMAT }),
    );
    expect(result.content).toEqual([{ type: "text", text: "not json" }]);
    expect(fake.callsFor("generate.text").length).toBe(2);
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "other" &&
          warning.message.includes("repair attempt(s) were exhausted"),
      ),
    ).toBe(true);
  });

  it("treats a failed repair call as a consumed attempt (internal, never surfaced)", async () => {
    const fake = createFakePort({
      generateText: () => {
        throw new Error("generate.text unavailable");
      },
    });
    scriptTextTurn(fake, "not json");
    const model = createModel(fake, { jsonRepair: {} });

    const result = await model.doGenerate(
      callOptions({ responseFormat: JSON_FORMAT }),
    );
    expect(result.content).toEqual([{ type: "text", text: "not json" }]);
    expect(fake.callsFor("generate.text").length).toBe(1);
    expect(
      result.warnings.some(
        (warning) =>
          warning.type === "other" &&
          warning.message.includes("repair attempt(s) were exhausted"),
      ),
    ).toBe(true);
  });
});

describe("5.0.1 review fixes", () => {
  function storedAnswer(text: string) {
    return {
      id: "msg_a",
      type: "assistant",
      time: { created: Date.now() + 10_000 },
      agent: "default",
      model: { id: "test-model", providerID: "test-provider" },
      content: [{ type: "text", text }],
      finish: "stop",
      cost: 0,
      tokens: tokens(10, 5, 0, 0, 0),
    };
  }

  it("reconciles instead of finishing when the event stream ends cleanly mid-turn (doStream)", async () => {
    // 2.x never reconnects /api/event: a server restart or proxy timeout
    // ends the stream cleanly. The rest of the answer is in the store.
    const fake = createFakePort({
      waitHangs: true,
      messages: [storedAnswer("Hello world")],
    });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "Hello"),
      );
      fake.closeStream();
    };
    const model = createModel(fake, {}, { silenceWatchdogMs: 200 });

    const parts = await collectStream(await model.doStream(callOptions()));
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(text).toBe("Hello world");
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(fake.callsFor("message.list").length).toBeGreaterThan(0);
  });

  it("surfaces an error, not an empty success, when the stream ends before anything happened", async () => {
    const fake = createFakePort({ waitHangs: true, messages: [] });
    fake.hooks.onPrompt = () => {
      fake.closeStream();
    };
    const model = createModel(fake, {}, { silenceWatchdogMs: 200 });

    const parts = await collectStream(await model.doStream(callOptions()));
    expect(parts.some((part) => part.type === "error")).toBe(true);
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason.unified).toBe("error");
  });

  it("reconciles a clean stream end that arrives after session.wait settled", async () => {
    // The wait watchdog path reads the stream too; its EOF must recover the
    // same way (the fake's wait resolves immediately).
    const fake = createFakePort({ messages: [storedAnswer("Hello world")] });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "Hello"),
      );
      fake.closeStream();
    };
    const parts = await collectStream(
      await createModel(fake).doStream(callOptions()),
    );
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello world");
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
  });

  it("does not report a partial, unfinished stored message as success", async () => {
    // The server creates the assistant message at step.started and sets
    // `finish` only when the step ends: its existence proves nothing.
    const unfinished = { ...storedAnswer("Hello"), finish: undefined };
    const fake = createFakePort({ waitHangs: true, messages: [unfinished] });
    fake.hooks.onPrompt = () => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        ev.executionStarted(),
        ev.stepStarted("msg_a"),
        ev.textStarted("msg_a", 0),
        ev.textDelta("msg_a", 0, "Hello"),
      );
      fake.closeStream();
    };
    const parts = await collectStream(
      await createModel(fake, {}, { silenceWatchdogMs: 10 }).doStream(
        callOptions(),
      ),
    );
    expect(parts.some((part) => part.type === "error")).toBe(true);
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason.unified).toBe("error");
  });

  it("surfaces the queued execution's own failure before delivery in a mixed continuation", async () => {
    // Upstream fails an execution in prepareContext before promoting the
    // inbox item (e.g. AgentNotFoundError): execution.started, then
    // execution.failed, with no inbox.delivered.
    const fake = createFakePort({ manualDelivery: true });
    fake.hooks.onPrompt = (_input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        {
          id: "evt_enqueued",
          created: 1,
          type: "session.inbox.enqueued",
          durable: { aggregateID: SESSION_ID, seq: 90, version: 1 },
          data: {
            sessionID: SESSION_ID,
            inboxID: receipt.id,
            item: { type: "user", payload: { text: "new" }, delivery: "queue" },
          },
        } as V2Event,
        ev.executionStarted(),
        ev.executionFailed({ type: "unknown", message: "Agent not found" }),
      );
    };
    const model = createModel(
      fake,
      {},
      { silenceWatchdogMs: 10, waitWatchdogGraceMs: 5 },
    );
    const parts = await collectStream(
      await model.doStream(
        callOptions({
          prompt: [
            ...userPrompt("Hi"),
            {
              role: "tool",
              content: [
                {
                  type: "tool-approval-response",
                  approvalId: "perm_1",
                  approved: true,
                },
              ],
            },
            ...userPrompt("Also do this"),
          ],
        }),
      ),
    );
    const finish = parts[parts.length - 1] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason.unified).toBe("error");
  });

  describe("mixed continuation + stream end", () => {
    const mixedOptions = () =>
      callOptions({
        prompt: [
          ...userPrompt("Hi"),
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "perm_1",
                approved: true,
              },
            ],
          },
          ...userPrompt("Also do this"),
        ],
      });
    const inbox = (type: string, id: string): V2Event =>
      ({
        id: `evt_${type}_${id}`,
        created: 1,
        type,
        durable: {
          aggregateID: SESSION_ID,
          seq: type.endsWith("enqueued") ? 90 : 91,
          version: 1,
        },
        data: {
          sessionID: SESSION_ID,
          inboxID: id,
          ...(type.endsWith("enqueued")
            ? {
                item: {
                  type: "user",
                  payload: { text: "new" },
                  delivery: "queue",
                },
              }
            : {}),
        },
      }) as V2Event;
    const ownUserMessage = (id: string) => ({
      id,
      type: "user",
      text: "Also do this",
      time: { created: Date.now() },
    });

    for (const delivered of [false, true]) {
      it(`does not count the predecessor's answer as this prompt's (delivered=${String(delivered)})`, async () => {
        const fake = createFakePort({ manualDelivery: true, waitHangs: true });
        fake.hooks.onPrompt = (_input, receipt) => {
          const ev = eventFactory(SESSION_ID);
          const previous = {
            ...storedAnswer("Previous answer."),
            time: { created: Date.now() },
          };
          fake.hooks.messages = [previous];
          fake.emit(
            inbox("session.inbox.enqueued", receipt.id),
            ev.stepStarted("msg_a"),
            ev.textStarted("msg_a", 0),
            ev.textEnded("msg_a", 0, "Previous answer."),
            ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
          );
          if (delivered) {
            // Queued prompts can run within the same execution: delivered,
            // but no answer stored yet.
            fake.hooks.messages.push(ownUserMessage(receipt.id));
            fake.emit(inbox("session.inbox.delivered", receipt.id));
          }
          fake.closeStream();
        };
        const parts = await collectStream(
          await createModel(fake, {}, { silenceWatchdogMs: 10 }).doStream(
            mixedOptions(),
          ),
        );
        expect(parts.some((part) => part.type === "error")).toBe(true);
        const finish = parts[parts.length - 1] as Extract<
          LanguageModelV4StreamPart,
          { type: "finish" }
        >;
        expect(finish.finishReason.unified).toBe("error");
      });
    }

    for (const delivered of [false, true]) {
      it(`surfaces a failure of this prompt inside the resumed execution (delivered=${String(delivered)})`, async () => {
        // OpenCode can drain the queued prompt within the resumed execution
        // (no new execution.started); preparing its context can fail before
        // the prompt is delivered.
        const fake = createFakePort({ manualDelivery: true });
        fake.hooks.onPrompt = (_input, receipt) => {
          const ev = eventFactory(SESSION_ID);
          fake.hooks.messages = [
            {
              ...storedAnswer("Previous answer."),
              time: { created: Date.now() },
            },
          ];
          fake.emit(
            inbox("session.inbox.enqueued", receipt.id),
            ev.stepStarted("msg_a"),
            ev.textStarted("msg_a", 0),
            ev.textEnded("msg_a", 0, "Previous answer."),
            ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
          );
          if (delivered) {
            fake.hooks.messages.push(ownUserMessage(receipt.id));
            fake.emit(inbox("session.inbox.delivered", receipt.id));
          }
          fake.emit(
            ev.executionFailed({ type: "unknown", message: "Agent not found" }),
          );
        };
        const parts = await collectStream(
          await createModel(fake, {}, { silenceWatchdogMs: 10 }).doStream(
            mixedOptions(),
          ),
        );
        const finish = parts[parts.length - 1] as Extract<
          LanguageModelV4StreamPart,
          { type: "finish" }
        >;
        expect(finish.finishReason.unified).toBe("error");
        expect(
          (finish.providerMetadata?.["opencode"] as Record<string, unknown>)[
            "outcome"
          ],
        ).toBe("failed");
      });
    }

    it("fails instead of finishing with the predecessor's result when the session settles undelivered", async () => {
      const fake = createFakePort({ manualDelivery: true });
      fake.hooks.onPrompt = (_input, receipt) => {
        const ev = eventFactory(SESSION_ID);
        fake.hooks.messages = [
          {
            ...storedAnswer("Previous answer."),
            time: { created: Date.now() },
          },
        ];
        fake.emit(
          inbox("session.inbox.enqueued", receipt.id),
          ev.stepStarted("msg_a"),
          ev.textStarted("msg_a", 0),
          ev.textEnded("msg_a", 0, "Previous answer."),
          ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
          ev.executionSucceeded(),
        );
      };
      const parts = await collectStream(
        await createModel(fake, {}, { silenceWatchdogMs: 10 }).doStream(
          mixedOptions(),
        ),
      );
      expect(parts.some((part) => part.type === "error")).toBe(true);
      const finish = parts[parts.length - 1] as Extract<
        LanguageModelV4StreamPart,
        { type: "finish" }
      >;
      expect(finish.finishReason.unified).toBe("error");
    });

    it("does not await a predecessor when the approval belongs to another session", async () => {
      // Phase 1 blocks SESSION_ID on perm_1.
      const fake = createFakePort({ manualDelivery: true });
      fake.hooks.onPrompt = (_input, receipt) => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          inbox("session.inbox.enqueued", receipt.id),
          ev.executionStarted(),
          inbox("session.inbox.delivered", receipt.id),
          ev.stepStarted("msg_a"),
          ev.toolInputStarted("msg_a", "tool_1", "bash"),
          ev.toolInputEnded("msg_a", "tool_1", '{"cmd":"rm x"}'),
          ev.permissionAsked("perm_1", {
            source: { type: "tool", messageID: "msg_a", id: "tool_1" },
          }),
        );
      };
      const model = createModel(
        fake,
        {},
        { approvalIdleTimeoutMs: 25, silenceWatchdogMs: 50 },
      );
      await model.doGenerate(callOptions());

      // Mixed call whose new content goes to another session: nothing is
      // queued behind a resumed execution there, so its own terminal (with
      // no execution.started or inbox.delivered observed) ends the call.
      fake.hooks.onPermissionReply = () => {};
      fake.hooks.onPrompt = (_input, receipt) => {
        const other = eventFactory("ses_other");
        fake.emit(
          {
            ...inbox("session.inbox.enqueued", receipt.id),
            data: {
              sessionID: "ses_other",
              inboxID: receipt.id,
              item: { type: "user", payload: { text: "x" }, delivery: "queue" },
            },
          } as V2Event,
          other.stepStarted("msg_z"),
          other.textStarted("msg_z", 0),
          other.textEnded("msg_z", 0, "ok"),
          other.stepEnded("msg_z", "stop", tokens(1, 1), 0),
          other.executionSucceeded(),
        );
      };
      const result = await model.doGenerate({
        ...mixedOptions(),
        providerOptions: { opencode: { sessionId: "ses_other" } },
      });
      expect(fake.callsFor("permission.reply")[0]!.input).toMatchObject({
        sessionID: SESSION_ID,
      });
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    });

    it("uses the pinned-session fallback when deciding whether the prompt has a predecessor", async () => {
      // An existing-session model can reply to an approval this instance
      // never surfaced: the reply falls back to the pinned session, while
      // the new content targets another session.
      const fake = createFakePort({ manualDelivery: true });
      const model = createModel(
        fake,
        { sessionId: SESSION_ID },
        { silenceWatchdogMs: 10 },
      );
      fake.hooks.onPrompt = (_input, receipt) => {
        const other = eventFactory("ses_other");
        fake.emit(
          {
            ...inbox("session.inbox.enqueued", receipt.id),
            durable: { aggregateID: "ses_other", seq: 90, version: 1 },
            data: {
              sessionID: "ses_other",
              inboxID: receipt.id,
              item: {
                type: "user",
                payload: { text: "new" },
                delivery: "queue",
              },
            },
          } as V2Event,
          other.stepStarted("msg_z"),
          other.textEnded("msg_z", 0, "ok"),
          other.stepEnded("msg_z", "stop", tokens(1, 1), 0),
          other.executionSucceeded(),
        );
      };
      const parts = await collectStream(
        await model.doStream({
          ...mixedOptions(),
          providerOptions: { opencode: { sessionId: "ses_other" } },
        }),
      );
      expect(fake.callsFor("permission.reply")[0]!.input).toMatchObject({
        sessionID: SESSION_ID,
      });
      expect(fake.callsFor("session.prompt")[0]!.input).toMatchObject({
        sessionID: "ses_other",
      });
      expect(
        parts
          .filter((part) => part.type === "text-delta")
          .map((part) => (part as { delta: string }).delta)
          .join(""),
      ).toBe("ok");
      const finish = parts[parts.length - 1] as Extract<
        LanguageModelV4StreamPart,
        { type: "finish" }
      >;
      expect(finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
      expect(parts.some((part) => part.type === "error")).toBe(false);
    });

    it("treats a predecessor ending before this prompt's enqueue as the predecessor's", async () => {
      // Phase 1 blocks SESSION_ID on perm_1.
      const fake = createFakePort({ manualDelivery: true });
      fake.hooks.onPrompt = (_input, receipt) => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          inbox("session.inbox.enqueued", receipt.id),
          ev.executionStarted(),
          inbox("session.inbox.delivered", receipt.id),
          ev.stepStarted("msg_a"),
          ev.toolInputStarted("msg_a", "tool_1", "bash"),
          ev.toolInputEnded("msg_a", "tool_1", '{"cmd":"rm x"}'),
          ev.permissionAsked("perm_1", {
            source: { type: "tool", messageID: "msg_a", id: "tool_1" },
          }),
        );
      };
      const model = createModel(
        fake,
        {},
        { approvalIdleTimeoutMs: 25, silenceWatchdogMs: 50 },
      );
      await model.doGenerate(callOptions());

      // The resumed execution ends BEFORE the new prompt's enqueue; the new
      // prompt's own execution then runs without an observed
      // execution.started or inbox.delivered.
      fake.hooks.onPermissionReply = () => {};
      fake.hooks.onPrompt = (_input, receipt) => {
        const ev = eventFactory(SESSION_ID);
        fake.emit(
          ev.executionSucceeded(),
          inbox("session.inbox.enqueued", receipt.id),
          ev.stepStarted("msg_c"),
          ev.textStarted("msg_c", 0),
          ev.textEnded("msg_c", 0, "New answer."),
          ev.stepEnded("msg_c", "stop", tokens(1, 1), 0),
          ev.executionSucceeded(),
        );
      };
      const result = await model.doGenerate(mixedOptions());
      expect(result.content).toEqual([{ type: "text", text: "New answer." }]);
      expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    });

    it("recovers this prompt's stored answer once it concluded", async () => {
      const fake = createFakePort({ manualDelivery: true, waitHangs: true });
      fake.hooks.onPrompt = (_input, receipt) => {
        const ev = eventFactory(SESSION_ID);
        const previous = {
          ...storedAnswer("Previous answer."),
          time: { created: Date.now() },
        };
        const current = { ...storedAnswer("New answer."), id: "msg_b" };
        fake.hooks.messages = [previous, ownUserMessage(receipt.id), current];
        fake.emit(
          inbox("session.inbox.enqueued", receipt.id),
          ev.stepStarted("msg_a"),
          ev.textEnded("msg_a", 0, "Previous answer."),
          ev.stepEnded("msg_a", "stop", tokens(1, 1), 0),
          inbox("session.inbox.delivered", receipt.id),
        );
        fake.closeStream();
      };
      const parts = await collectStream(
        await createModel(fake, {}, { silenceWatchdogMs: 10 }).doStream(
          mixedOptions(),
        ),
      );
      expect(parts.some((part) => part.type === "error")).toBe(false);
      const finish = parts[parts.length - 1] as Extract<
        LanguageModelV4StreamPart,
        { type: "finish" }
      >;
      expect(finish.finishReason.unified).toBe("stop");
      expect(
        parts
          .filter((part) => part.type === "text-delta")
          .map((part) => (part as { delta: string }).delta)
          .join(""),
      ).toContain("New answer.");
    });
  });

  it("detaches its abort listener from the caller's signal when the turn ends", async () => {
    const fake = createFakePort();
    scriptTextTurn(fake);
    const model = createModel(fake);
    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((
      type: string,
      listener: unknown,
      opts?: unknown,
    ) => {
      if (type === "abort") added.push(listener);
      return add(
        type,
        listener as EventListener,
        opts as AddEventListenerOptions,
      );
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((
      type: string,
      listener: unknown,
      opts?: unknown,
    ) => {
      if (type === "abort") removed.push(listener);
      return remove(
        type,
        listener as EventListener,
        opts as EventListenerOptions,
      );
    }) as typeof signal.removeEventListener;

    for (let i = 0; i < 3; i++) {
      scriptTextTurn(fake);
      await model.doGenerate(callOptions({ abortSignal: signal }));
    }
    // Every listener the provider attached to the caller's signal is gone.
    const leaked = added.filter((listener) => !removed.includes(listener));
    expect(leaked).toEqual([]);
  });

  it("keeps waiting for the queued prompt after a mixed approval continuation", async () => {
    // Phase 1: a tool blocks on approval.
    const fake = createFakePort({ manualDelivery: true });
    const inbox = (type: string, inboxID: string): V2Event =>
      ({
        id: `evt_${type}_${inboxID}`,
        created: 1,
        type,
        durable: { aggregateID: SESSION_ID, seq: 0, version: 1 },
        data: {
          sessionID: SESSION_ID,
          inboxID,
          ...(type === "session.inbox.enqueued"
            ? {
                item: {
                  type: "user",
                  payload: { text: "x" },
                  delivery: "queue",
                },
              }
            : {}),
        },
      }) as V2Event;
    fake.hooks.onPrompt = (_input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        inbox("session.inbox.enqueued", receipt.id),
        ev.executionStarted(),
        inbox("session.inbox.delivered", receipt.id),
        ev.stepStarted("msg_a"),
        ev.toolInputStarted("msg_a", "tool_1", "bash"),
        ev.toolInputEnded("msg_a", "tool_1", '{"cmd":"rm x"}'),
        ev.permissionAsked("perm_1", {
          source: { type: "tool", messageID: "msg_a", id: "tool_1" },
        }),
      );
    };
    const model = createModel(fake, {}, { approvalIdleTimeoutMs: 25 });
    const phase1 = await model.doGenerate(callOptions());
    expect(
      phase1.content.some((part) => part.type === "tool-approval-request"),
    ).toBe(true);

    // Phase 2 (mixed): the approval resumes the blocked execution, which
    // ends AFTER the new prompt was enqueued behind it; then the queued
    // prompt is delivered and answered.
    fake.hooks.onPermissionReply = () => {};
    fake.hooks.onPrompt = (_input, receipt) => {
      const ev = eventFactory(SESSION_ID);
      fake.emit(
        inbox("session.inbox.enqueued", receipt.id),
        ev.toolCalled("msg_a", "tool_1", { cmd: "rm x" }),
        ev.toolSuccess("msg_a", "tool_1", [{ type: "text", text: "gone" }]),
        ev.stepEnded("msg_a", "tool-calls", tokens(1, 1), 0),
        ev.stepStarted("msg_b"),
        ev.textStarted("msg_b", 0),
        ev.textEnded("msg_b", 0, "Removed."),
        ev.stepEnded("msg_b", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
        ev.executionStarted(),
        inbox("session.inbox.delivered", receipt.id),
        ev.stepStarted("msg_c"),
        ev.textStarted("msg_c", 0),
        ev.textEnded("msg_c", 0, "New answer."),
        ev.stepEnded("msg_c", "stop", tokens(1, 1), 0),
        ev.executionSucceeded(),
      );
    };
    const result = await model.doGenerate(
      callOptions({
        prompt: [
          ...userPrompt("Hi"),
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "perm_1",
                approved: true,
              },
            ],
          },
          ...userPrompt("Also do this"),
        ],
      }),
    );
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text);
    expect(text).toContain("New answer.");
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
  }, 10_000);
});
