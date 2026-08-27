/**
 * Unit tests for the integration harness's test-model resolution
 * (`integration/harness/test-model.ts`) against a fake in-process HTTP
 * server speaking the pinned client's wire shapes. Two properties under
 * test, both codex sign-off holdouts from stage-10:
 *
 *   1. Every API request the resolver makes is bounded — a server that
 *      accepts a request and never responds cannot hang resolution past the
 *      configured window (AbortSignal threading + hard-deadline race).
 *   2. The resolution order (env override → pinned model via catalog check
 *      + probe → server default with loud warning) is identical in spawned
 *      and attach modes; in particular the pin is probed in attach mode
 *      even when the HOST has no OLLAMA_API_KEY, because the attached
 *      server's own env — reflected in its live catalog — is the authority.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PINNED_TEST_MODEL,
  resolveTestModel,
  type ResolverTimeouts,
  type TestModelRef,
} from "../integration/harness/test-model.js";

const PIN = `${PINNED_TEST_MODEL.providerID}/${PINNED_TEST_MODEL.modelID}`;
const DEFAULT_MODEL: TestModelRef = {
  providerID: "opencode",
  modelID: "fake-default",
};
const DEFAULT_ID = `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`;

/** Tiny bounds so hang tests finish in milliseconds, not minutes. */
const FAST: ResolverTimeouts = {
  probeTimeoutMs: 300,
  probePollMs: 50,
  catalogTimeoutMs: 300,
};

/** Generous wall-clock ceiling every bounded resolution must beat. */
const WALL_CLOCK_LIMIT_MS = 10_000;

interface FakeServerBehavior {
  /** `providerID/modelID` ids the catalog lists. */
  catalog: string[];
  /** Ids whose probe turn succeeds (assistant answers "OK"). */
  working: string[];
  /** Ids whose probe turn terminally fails (assistant carries an error). */
  failing?: string[];
  /** Never respond to `message.list` for sessions on these ids. */
  hangMessagesFor?: string[];
  /** Never respond to `model.list` (catalog unreachable via hang). */
  hangCatalog?: boolean;
}

interface FakeServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Minimal fake of the v2 server surface the resolver touches: `model.list`,
 * `session.create`, `session.prompt`, `message.list`. Responses mirror the
 * generated client's envelope (`{ data: ... }`). Hanging endpoints accept
 * the request and never write a response — the exact failure shape an
 * unbounded client call would deadlock on.
 */
function startFakeServer(behavior: FakeServerBehavior): Promise<FakeServer> {
  const sessionModels = new Map<string, string>();
  let sessionCounter = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const respond = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = (onDone: (body: string) => void): void => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => onDone(raw));
    };

    if (req.method === "GET" && url.pathname === "/api/model") {
      if (behavior.hangCatalog === true) {
        return; // accept and never respond
      }
      respond({
        data: behavior.catalog.map((id) => {
          const slash = id.indexOf("/");
          return {
            providerID: id.slice(0, slash),
            modelID: id.slice(slash + 1),
          };
        }),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      readBody((raw) => {
        const body = JSON.parse(raw) as {
          model?: { providerID?: string; id?: string };
        };
        const id = `ses_${++sessionCounter}`;
        sessionModels.set(
          id,
          `${body.model?.providerID ?? "?"}/${body.model?.id ?? "?"}`,
        );
        respond({ data: { id } });
      });
      return;
    }
    const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
    if (req.method === "POST" && promptMatch !== null) {
      readBody(() => respond({ data: { id: "inbox_1" } }));
      return;
    }
    const messagesMatch = /^\/api\/session\/([^/]+)\/message$/.exec(
      url.pathname,
    );
    if (req.method === "GET" && messagesMatch !== null) {
      const model = sessionModels.get(
        decodeURIComponent(messagesMatch[1] ?? ""),
      );
      if (model !== undefined && behavior.hangMessagesFor?.includes(model)) {
        return; // accept and never respond
      }
      if (model !== undefined && behavior.working.includes(model)) {
        respond({
          data: [
            {
              type: "assistant",
              finish: "stop",
              content: [{ type: "text", text: "OK" }],
            },
          ],
        });
        return;
      }
      respond({
        data: [
          {
            type: "assistant",
            error: { type: "ModelUnavailable", message: "fake outage" },
            content: [],
          },
        ],
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unhandled fake route" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            // Hanging endpoints keep sockets open on purpose; sever them so
            // close() does not wait on them.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function resolveAgainst(
  fake: FakeServer,
  mode: "spawned" | "attach",
  defaultModel: TestModelRef | null = DEFAULT_MODEL,
) {
  return resolveTestModel({
    baseUrl: fake.baseUrl,
    authHeader: "Basic ZmFrZQ==",
    workdir: "/tmp/fake-workdir",
    defaultModel,
    mode,
    timeouts: FAST,
  });
}

const BOTH_MODES = ["spawned", "attach"] as const;

describe("harness test-model resolution", () => {
  let fake: FakeServer | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // The resolver must not consult the host env for availability decisions;
    // clear both knobs so every test starts from "host has nothing".
    for (const key of ["OPENCODE_TEST_MODEL", "OLLAMA_API_KEY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
    await fake?.close();
    fake = undefined;
  });

  describe.each(BOTH_MODES)("resolution order in %s mode", (mode) => {
    it("prefers the OPENCODE_TEST_MODEL env override", async () => {
      process.env.OPENCODE_TEST_MODEL = "custom/override";
      fake = await startFakeServer({
        catalog: ["custom/override", PIN, DEFAULT_ID],
        working: ["custom/override", PIN, DEFAULT_ID],
      });
      const resolved = await resolveAgainst(fake, mode);
      expect(resolved).toEqual({
        providerID: "custom",
        modelID: "override",
        source: "env",
      });
    });

    it("probes and picks the pinned model without any host OLLAMA_API_KEY", async () => {
      fake = await startFakeServer({
        catalog: [PIN, DEFAULT_ID],
        working: [PIN, DEFAULT_ID],
      });
      const resolved = await resolveAgainst(fake, mode);
      expect(resolved).toEqual({ ...PINNED_TEST_MODEL, source: "pin" });
    });

    it("falls back to the server default (with a loud warning) when the catalog lacks the pin", async () => {
      fake = await startFakeServer({
        catalog: [DEFAULT_ID],
        working: [DEFAULT_ID],
      });
      const resolved = await resolveAgainst(fake, mode);
      expect(resolved).toEqual({ ...DEFAULT_MODEL, source: "default" });
      const warnings = vi
        .mocked(console.warn)
        .mock.calls.map((call) => String(call[0]));
      expect(warnings.some((w) => w.includes("UNAVAILABLE"))).toBe(true);
      expect(
        warnings.some((w) =>
          w.includes(
            mode === "spawned" ? "sandboxed server" : "attached server",
          ),
        ),
      ).toBe(true);
    });

    it("falls through to the default when the pin is listed but fails its probe", async () => {
      fake = await startFakeServer({
        catalog: [PIN, DEFAULT_ID],
        working: [DEFAULT_ID],
        failing: [PIN],
      });
      const resolved = await resolveAgainst(fake, mode);
      expect(resolved).toEqual({ ...DEFAULT_MODEL, source: "default" });
    });

    it("returns null when no candidate survives", async () => {
      fake = await startFakeServer({
        catalog: [PIN, DEFAULT_ID],
        working: [],
      });
      const resolved = await resolveAgainst(fake, mode);
      expect(resolved).toBeNull();
    });
  });

  it("spawned and attach modes resolve identically on the same server", async () => {
    fake = await startFakeServer({
      catalog: [PIN, DEFAULT_ID],
      working: [PIN, DEFAULT_ID],
    });
    const spawned = await resolveAgainst(fake, "spawned");
    const attach = await resolveAgainst(fake, "attach");
    expect(attach).toEqual(spawned);
    expect(spawned).toEqual({ ...PINNED_TEST_MODEL, source: "pin" });
  });

  describe("bounded API requests (no unbounded waits)", () => {
    it("aborts a hung message.list at the probe deadline and falls through", async () => {
      fake = await startFakeServer({
        catalog: [PIN, DEFAULT_ID],
        working: [DEFAULT_ID],
        hangMessagesFor: [PIN],
      });
      const started = Date.now();
      const resolved = await resolveAgainst(fake, "spawned");
      const elapsed = Date.now() - started;
      expect(resolved).toEqual({ ...DEFAULT_MODEL, source: "default" });
      // Two probe attempts of 300ms each plus the default's own probe must
      // stay far under this ceiling; an unbounded client call would never
      // return at all.
      expect(elapsed).toBeLessThan(WALL_CLOCK_LIMIT_MS);
    });

    it("aborts a hung model.list at the catalog deadline and fails closed", async () => {
      fake = await startFakeServer({
        catalog: [PIN, DEFAULT_ID],
        working: [PIN, DEFAULT_ID],
        hangCatalog: true,
      });
      const started = Date.now();
      const resolved = await resolveAgainst(fake, "attach");
      const elapsed = Date.now() - started;
      expect(resolved).toBeNull();
      expect(elapsed).toBeLessThan(WALL_CLOCK_LIMIT_MS);
    });
  });
});
