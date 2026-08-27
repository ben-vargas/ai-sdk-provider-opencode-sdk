/**
 * End-to-end header precedence over the REAL generated client: unlike
 * opencode-client-manager.test.ts (which mocks `OpenCode.make` and asserts on
 * construction options), this file lets `OpenCode.make` build a genuine
 * client whose injected `fetch` records the headers of every outgoing
 * request — proving the effective three-layer precedence
 * per-call > user defaults > Service.headers on the wire.
 * Only the Node-only service module is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { discoverMock, ensureMock, stopMock, headersMock } = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  ensureMock: vi.fn(),
  stopMock: vi.fn(),
  headersMock: vi.fn(),
}));

vi.mock("@opencode-ai/client/service", () => ({
  Service: {
    discover: discoverMock,
    ensure: ensureMock,
    stop: stopMock,
    headers: headersMock,
  },
}));

import { createClientManager } from "./opencode-client-manager.js";

interface CapturedRequest {
  url: string;
  headers: Headers;
}

function createCapturingFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    captured.push({ url, headers: new Headers(init?.headers) });
    const body = url.includes("/health")
      ? { healthy: true, version: "2.0.0", pid: 4242 }
      : { status: "completed" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  discoverMock.mockResolvedValue({
    url: "http://127.0.0.1:5555",
    auth: undefined,
  });
  headersMock.mockReturnValue({
    authorization: "Basic service-auth",
    "x-service": "from-service",
  });
  stopMock.mockResolvedValue(undefined);
});

describe("effective header precedence on generated-client requests", () => {
  it("applies per-call > user defaults > Service.headers on the wire", async () => {
    const captured: CapturedRequest[] = [];
    const manager = createClientManager({
      service: {},
      clientOptions: {
        fetch: createCapturingFetch(captured),
        // User defaults override the service authorization but leave
        // x-service intact.
        headers: { Authorization: "Bearer user-token", "x-user": "from-user" },
      },
    });

    const port = await manager.getPort();

    // Preflight requests carry defaults only: user > service.
    const preflight = captured.find((r) => r.url.includes("/health"));
    expect(preflight).toBeDefined();
    expect(preflight!.headers.get("authorization")).toBe("Bearer user-token");
    expect(preflight!.headers.get("x-service")).toBe("from-service");
    expect(preflight!.headers.get("x-user")).toBe("from-user");

    // A per-call request layers its headers over both default layers.
    await port.health.get({
      headers: { authorization: "Bearer per-call", "x-call": "from-call" },
    });

    const perCall = captured.at(-1)!;
    expect(perCall.url).toContain("/health");
    expect(perCall.headers.get("authorization")).toBe("Bearer per-call");
    expect(perCall.headers.get("x-user")).toBe("from-user");
    expect(perCall.headers.get("x-service")).toBe("from-service");
    expect(perCall.headers.get("x-call")).toBe("from-call");
  });
});
