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
import type { SessionInboxUser, V2Event } from "@opencode-ai/client";
import type {
  OpencodeClientPort,
  OpencodeRequestOptions,
} from "./client-port.js";
import {
  OpencodeLanguageModel,
  type OpencodeLanguageModelConfig,
} from "./opencode-language-model.js";
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
    signal?.addEventListener("abort", () => {
      this.fail({
        name: "ClientError",
        reason: "Transport",
        cause: { name: "AbortError" },
        message: "aborted",
      });
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
    health: { get: fn("health.get", () => ({ healthy: true })) },
    session: {
      create: fn("session.create", () => sessionInfo(SESSION_ID)),
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
        hooks.onPrompt?.(input, receipt);
        return Promise.resolve(receipt);
      },
      wait: (input: unknown, options?: OpencodeRequestOptions) => {
        record("session.wait", input, options);
        return hooks.waitError !== undefined
          ? Promise.reject(hooks.waitError)
          : Promise.resolve(undefined);
      },
      interrupt: fn("session.interrupt", () => ({ interrupted: true })),
      switchModel: fn("session.switchModel", () => undefined),
      switchAgent: fn("session.switchAgent", () => undefined),
      message: fn("session.message", () => {
        throw { _tag: "MessageNotFoundError", message: "not found" };
      }),
      context: fn("session.context", () => []),
      log: () => {
        throw new Error("session.log not scripted");
      },
      inbox: { cancel: fn("session.inbox.cancel", () => undefined) },
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
      list: fn("permission.list", () => []),
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
    form: {
      list: fn("form.list", () => []),
      state: fn("form.state", () => ({ status: "pending" })),
      reply: fn("form.reply", () => undefined),
      cancel: fn("form.cancel", () => undefined),
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
    emit: (...events) => channel!.push(...events),
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
    { getPort: () => fake.port, ...config },
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
function scriptTextTurn(fake: FakePort, text = "Hello world"): void {
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

  it("finalizes with a backstop finish when the event stream ends without a terminal event", async () => {
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
    expect(finish.finishReason.unified).toBe("other");
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
      reply: "once",
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
      reply: "reject",
      message: "too risky",
    });
    expect(result.finishReason.unified).toBe("error");
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

    await model.doGenerate(callOptions());
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
    // Cleanup never carries the aborted call signal.
    expect(cancel.options?.signal).toBeUndefined();
    expect(fake.callsFor("session.interrupt")).toEqual([]);
    await consumed;
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
      continue: false,
    });
    expect(fake.callsFor("session.inbox.cancel")).toEqual([]);
    await reader.cancel().catch(() => undefined);
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
    expect(fake.callsFor("session.wait").length).toBe(1);
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

  it("degrades the system prompt into the first turn's text with a warning", async () => {
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
    const fake = createFakePort({ models: [] });
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
  });
});
