import { describe, expect, it } from "vitest";
import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { ClientError } from "@opencode/client";
import {
  extractErrorMessage,
  getClientErrorStatus,
  isAbortError,
  isClientError,
  isMissingRouteError,
  isTaggedError,
  needsSessionReconciliation,
  normalizeStructuredError,
  wrapError,
  type OpencodeErrorData,
  type OpencodeErrorPhase,
} from "./errors.js";

function data(error: Error): OpencodeErrorData {
  expect(APICallError.isInstance(error)).toBe(true);
  return (error as APICallError).data as OpencodeErrorData;
}

function abortCause(): Error {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  return abort;
}

interface WrapCase {
  name: string;
  error: () => unknown;
  /** Expected retryability by phase. */
  retryable: { "pre-dispatch": boolean; "post-dispatch": boolean };
  /** Expected reconcile marker by phase. */
  reconcile: { "pre-dispatch": boolean; "post-dispatch": boolean };
  errorTag?: string;
  clientReason?: string;
  statusCode?: number;
  messageContains?: string[];
}

const PHASES: OpencodeErrorPhase[] = ["pre-dispatch", "post-dispatch"];

const wrapCases: WrapCase[] = [
  // --- ClientError, all five reasons ---
  {
    name: "ClientError Transport",
    error: () =>
      new ClientError("Transport", { cause: new Error("ECONNRESET") }),
    retryable: { "pre-dispatch": true, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": true },
    clientReason: "Transport",
    messageContains: ["transport failure", "ECONNRESET"],
  },
  {
    name: "ClientError UnexpectedStatus without a recoverable status",
    error: () => new ClientError("UnexpectedStatus"),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    clientReason: "UnexpectedStatus",
    messageContains: ["unexpected status"],
  },
  {
    name: "ClientError UnexpectedStatus with cause status 503",
    error: () =>
      new ClientError("UnexpectedStatus", { cause: { status: 503 } }),
    retryable: { "pre-dispatch": true, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": true },
    clientReason: "UnexpectedStatus",
    statusCode: 503,
  },
  {
    name: "ClientError UnexpectedStatus with cause status 429",
    error: () =>
      new ClientError("UnexpectedStatus", { cause: { status: 429 } }),
    retryable: { "pre-dispatch": true, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": true },
    clientReason: "UnexpectedStatus",
    statusCode: 429,
  },
  {
    name: "ClientError UnexpectedStatus with cause status 404",
    error: () =>
      new ClientError("UnexpectedStatus", { cause: { status: 404 } }),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    clientReason: "UnexpectedStatus",
    statusCode: 404,
  },
  {
    name: "ClientError UnsupportedContentType",
    error: () => new ClientError("UnsupportedContentType"),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    clientReason: "UnsupportedContentType",
    messageContains: ["version skew"],
  },
  {
    name: "ClientError MalformedResponse",
    error: () => new ClientError("MalformedResponse"),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    clientReason: "MalformedResponse",
    messageContains: ["version skew"],
  },
  {
    name: "ClientError SseEventTooLarge",
    error: () => new ClientError("SseEventTooLarge"),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    clientReason: "SseEventTooLarge",
    messageContains: ["transport strategy"],
  },
  // --- Tagged errors ---
  {
    name: "SessionBusyError",
    error: () => ({
      _tag: "SessionBusyError",
      sessionID: "ses_1",
      message: "busy",
    }),
    retryable: { "pre-dispatch": true, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": true },
    errorTag: "SessionBusyError",
  },
  {
    name: "ConflictError",
    error: () => ({ _tag: "ConflictError", message: "conflict" }),
    retryable: { "pre-dispatch": true, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": true },
    errorTag: "ConflictError",
  },
  {
    name: "ServiceUnavailableError",
    error: () => ({
      _tag: "ServiceUnavailableError",
      message: "unavailable",
      service: "session.wait",
    }),
    retryable: { "pre-dispatch": true, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": true },
    errorTag: "ServiceUnavailableError",
  },
  {
    name: "InvalidRequestError",
    error: () => ({
      _tag: "InvalidRequestError",
      message: 'invalid at ["prompt"]["text"]',
      kind: "Payload",
    }),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    errorTag: "InvalidRequestError",
  },
  {
    name: "SessionNotFoundError",
    error: () => ({
      _tag: "SessionNotFoundError",
      sessionID: "ses_x",
      message: "not found",
    }),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    errorTag: "SessionNotFoundError",
  },
  {
    name: "FormInvalidAnswerError",
    error: () => ({
      _tag: "FormInvalidAnswerError",
      id: "form_1",
      message: "bad answer",
    }),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    errorTag: "FormInvalidAnswerError",
  },
  {
    name: "UnknownError",
    error: () => ({ _tag: "UnknownError", message: "???" }),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    errorTag: "UnknownError",
  },
  // --- Anything else ---
  {
    name: "plain Error",
    error: () => new Error("boom"),
    retryable: { "pre-dispatch": false, "post-dispatch": false },
    reconcile: { "pre-dispatch": false, "post-dispatch": false },
    messageContains: ["boom"],
  },
];

describe("wrapError (tag/reason × phase table)", () => {
  for (const testCase of wrapCases) {
    for (const phase of PHASES) {
      it(`${testCase.name} — ${phase}`, () => {
        const wrapped = wrapError(testCase.error(), {
          phase,
          operation: "session.prompt",
          sessionId: "ses_1",
        });

        expect(APICallError.isInstance(wrapped)).toBe(true);
        const apiError = wrapped as APICallError;
        expect(apiError.isRetryable).toBe(testCase.retryable[phase]);

        const errorData = data(apiError);
        expect(errorData.phase).toBe(phase);
        expect(errorData.reconcile).toBe(testCase.reconcile[phase]);
        expect(needsSessionReconciliation(apiError)).toBe(
          testCase.reconcile[phase],
        );
        expect(errorData.errorTag).toBe(testCase.errorTag);
        expect(errorData.clientReason).toBe(testCase.clientReason);
        expect(errorData.statusCode).toBe(testCase.statusCode);
        expect(apiError.statusCode).toBe(testCase.statusCode);
        expect(errorData.operation).toBe("session.prompt");
        expect(errorData.sessionId).toBe("ses_1");

        for (const substring of testCase.messageContains ?? []) {
          expect(apiError.message.toLowerCase()).toContain(
            substring.toLowerCase(),
          );
        }
      });
    }
  }

  it("universal rule: NOTHING wraps to a retryable error post-dispatch", () => {
    for (const testCase of wrapCases) {
      const wrapped = wrapError(testCase.error(), { phase: "post-dispatch" });
      if (APICallError.isInstance(wrapped)) {
        expect(wrapped.isRetryable).toBe(false);
      }
    }
  });
});

describe("auth errors", () => {
  it.each(["UnauthorizedError", "ForbiddenError"])(
    "maps %s to LoadAPIKeyError in both phases",
    (tag) => {
      for (const phase of PHASES) {
        const wrapped = wrapError({ _tag: tag, message: "denied" }, { phase });
        expect(LoadAPIKeyError.isInstance(wrapped)).toBe(true);
        expect(wrapped.message).toContain(tag);
        expect(needsSessionReconciliation(wrapped)).toBe(false);
      }
    },
  );
});

describe("abort detection", () => {
  it("detects standard AbortError shapes", () => {
    expect(isAbortError(abortCause())).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError({ code: "ABORT_ERR" })).toBe(true);
  });

  it("detects the client's abort surface: Transport with an abort cause", () => {
    const error = new ClientError("Transport", { cause: abortCause() });
    expect(isAbortError(error)).toBe(true);
  });

  it("does not flag a genuine transport failure", () => {
    const error = new ClientError("Transport", {
      cause: new Error("socket hang up"),
    });
    expect(isAbortError(error)).toBe(false);
    expect(isAbortError(new Error("nope"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it("wrapError passes abort errors through unchanged", () => {
    const abort = abortCause();
    expect(wrapError(abort, { phase: "pre-dispatch" })).toBe(abort);

    const transportAbort = new ClientError("Transport", {
      cause: abortCause(),
    });
    expect(wrapError(transportAbort, { phase: "post-dispatch" })).toBe(
      transportAbort,
    );
  });
});

describe("passthrough", () => {
  it("returns already-wrapped AI SDK errors unchanged", () => {
    const api = new APICallError({
      message: "x",
      url: "opencode://request",
      requestBodyValues: {},
    });
    const auth = new LoadAPIKeyError({ message: "y" });
    expect(wrapError(api, { phase: "post-dispatch" })).toBe(api);
    expect(wrapError(auth, { phase: "pre-dispatch" })).toBe(auth);
    expect(wrapError(auth, { phase: "post-dispatch" })).toBe(auth);
  });

  it("returns a retryable APICallError unchanged pre-dispatch", () => {
    const api = new APICallError({
      message: "x",
      url: "opencode://request",
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(wrapError(api, { phase: "pre-dispatch" })).toBe(api);
  });

  it("demotes a retryable APICallError post-dispatch (universal rule)", () => {
    const api = new APICallError({
      message: "transient upstream failure",
      url: "opencode://session.wait",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
      data: { phase: "pre-dispatch", reconcile: false, operation: "inner.op" },
    });

    const wrapped = wrapError(api, {
      phase: "post-dispatch",
      operation: "session.prompt",
      sessionId: "ses_1",
    });

    expect(wrapped).not.toBe(api);
    expect(APICallError.isInstance(wrapped)).toBe(true);
    const demoted = wrapped as APICallError;
    expect(demoted.isRetryable).toBe(false);
    expect(demoted.message).toBe(api.message);
    expect(demoted.url).toBe(api.url);
    expect(demoted.statusCode).toBe(503);
    expect(demoted.cause).toBe(api);
    expect(needsSessionReconciliation(demoted)).toBe(true);

    const errorData = data(demoted);
    expect(errorData.phase).toBe("post-dispatch");
    expect(errorData.reconcile).toBe(true);
    // Prior context wins; wrap-site context only fills gaps.
    expect(errorData.operation).toBe("inner.op");
    expect(errorData.sessionId).toBe("ses_1");
  });
});

describe("guards", () => {
  it("isClientError accepts instances and structural clones", () => {
    expect(isClientError(new ClientError("Transport"))).toBe(true);
    expect(
      isClientError({ name: "ClientError", reason: "MalformedResponse" }),
    ).toBe(true);
    expect(isClientError(new Error("x"))).toBe(false);
    expect(isClientError(null)).toBe(false);
  });

  it("isTaggedError requires a string _tag", () => {
    expect(isTaggedError({ _tag: "SessionBusyError", message: "m" })).toBe(
      true,
    );
    expect(isTaggedError({ _tag: 7 })).toBe(false);
    expect(isTaggedError(new Error("x"))).toBe(false);
  });

  it("needsSessionReconciliation is false for foreign errors", () => {
    expect(needsSessionReconciliation(new Error("x"))).toBe(false);
    expect(needsSessionReconciliation(undefined)).toBe(false);
    expect(
      needsSessionReconciliation(
        new APICallError({
          message: "x",
          url: "u",
          requestBodyValues: {},
        }),
      ),
    ).toBe(false);
  });
});

describe("getClientErrorStatus", () => {
  it("recovers status via guarded cause inspection only", () => {
    expect(
      getClientErrorStatus(
        new ClientError("UnexpectedStatus", { cause: { status: 500 } }),
      ),
    ).toBe(500);
    expect(
      getClientErrorStatus(
        new ClientError("UnexpectedStatus", { cause: { statusCode: 429 } }),
      ),
    ).toBe(429);
    expect(getClientErrorStatus(new ClientError("UnexpectedStatus"))).toBe(
      undefined,
    );
    expect(
      getClientErrorStatus(
        new ClientError("UnexpectedStatus", { cause: "500" }),
      ),
    ).toBe(undefined);
    expect(
      getClientErrorStatus(
        new ClientError("UnexpectedStatus", { cause: { status: "500" } }),
      ),
    ).toBe(undefined);
  });
});

describe("normalizeStructuredError", () => {
  it("produces a non-retryable, non-reconcile APICallError", () => {
    const wrapped = normalizeStructuredError(
      { type: "overloaded_error", message: "provider overloaded", status: 529 },
      { operation: "session.prompt", sessionId: "ses_1", messageId: "msg_1" },
    );
    expect(wrapped.isRetryable).toBe(false);
    expect(wrapped.statusCode).toBe(529);
    expect(wrapped.message).toContain("overloaded_error");
    expect(wrapped.message).toContain("provider overloaded");
    const errorData = wrapped.data as OpencodeErrorData;
    expect(errorData).toMatchObject({
      phase: "post-dispatch",
      reconcile: false,
      errorType: "overloaded_error",
      statusCode: 529,
      sessionId: "ses_1",
      messageId: "msg_1",
    });
    expect(needsSessionReconciliation(wrapped)).toBe(false);
  });

  it("omits status when the structured error has none", () => {
    const wrapped = normalizeStructuredError(
      { type: "unknown", message: "Provider turn interrupted" },
      {},
    );
    expect(wrapped.statusCode).toBeUndefined();
    expect((wrapped.data as OpencodeErrorData).statusCode).toBeUndefined();
  });
});

describe("extractErrorMessage", () => {
  it("handles strings, Errors, message-bearing objects, and junk", () => {
    expect(extractErrorMessage("boom")).toBe("boom");
    expect(extractErrorMessage(new Error("bang"))).toBe("bang");
    expect(extractErrorMessage({ message: "pow" })).toBe("pow");
    expect(extractErrorMessage(null)).toBe("Unknown error");
    expect(extractErrorMessage(42)).toBe("Unknown error");
  });
});

describe("isMissingRouteError", () => {
  const clientError = (status?: number) =>
    Object.assign(new Error("boom"), {
      name: "ClientError",
      reason: "StatusCode",
      ...(status === undefined ? {} : { cause: { status } }),
    });

  it.each([404, 405, 501])("is true for an explicit %i", (status) => {
    expect(isMissingRouteError(clientError(status))).toBe(true);
  });

  it.each([400, 401, 409, 429, 500, 503])(
    "is false for %i — the route exists, the request was refused",
    (status) => {
      expect(isMissingRouteError(clientError(status))).toBe(false);
    },
  );

  it("is false when the status is unknown (not proven absent)", () => {
    expect(isMissingRouteError(clientError())).toBe(false);
  });

  it("is false for a typed API error, which says nothing about the route", () => {
    expect(
      isMissingRouteError({
        _tag: "InstructionEntryValueTooLargeError",
        message: "too large",
      }),
    ).toBe(false);
  });

  it("is false for a plain error", () => {
    expect(isMissingRouteError(new Error("nope"))).toBe(false);
    expect(isMissingRouteError(undefined)).toBe(false);
  });
});

describe("wrapError classifies a wrapped typed cause", () => {
  // The client manager's preflight re-throws server.info() failures as a
  // plain Error with the typed client error as its cause.
  const preflight = (cause: unknown) =>
    new Error(
      "Failed to reach OpenCode server at http://127.0.0.1:4096 (server.info): boom",
      { cause },
    );

  it("keeps a transient transport failure retryable pre-dispatch", () => {
    const wrapped = wrapError(preflight(new ClientError("Transport")), {
      phase: "pre-dispatch",
      operation: "getPort",
    });
    expect(APICallError.isInstance(wrapped)).toBe(true);
    expect((wrapped as APICallError).isRetryable).toBe(true);
    expect(wrapped.message).toContain("Failed to reach OpenCode server");
  });

  it("maps a wrapped auth failure to LoadAPIKeyError", () => {
    const wrapped = wrapError(
      preflight({ _tag: "UnauthorizedError", message: "bad password" }),
      { phase: "pre-dispatch", operation: "getPort" },
    );
    expect(LoadAPIKeyError.isInstance(wrapped)).toBe(true);
  });

  it("still treats a plain error without a typed cause as non-retryable", () => {
    const wrapped = wrapError(new Error("nope", { cause: new Error("x") }), {
      phase: "pre-dispatch",
      operation: "getPort",
    });
    expect((wrapped as APICallError).isRetryable).toBe(false);
  });
});
