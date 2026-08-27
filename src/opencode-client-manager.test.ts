/**
 * Client-manager backend tests: selection matrix, ownership/disposal,
 * header merge order, preflight warning paths, and registry identity.
 * `OpenCode.make` and `Service.*` are module-mocked; the fake client records
 * construction options so header/backend assertions read them back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpencodeClientPort } from "./client-port.js";
import type { Logger, OpencodeClient } from "./types.js";

const { makeMock, discoverMock, ensureMock, stopMock, headersMock } =
  vi.hoisted(() => ({
    makeMock: vi.fn(),
    discoverMock: vi.fn(),
    ensureMock: vi.fn(),
    stopMock: vi.fn(),
    headersMock: vi.fn(),
  }));

vi.mock("@opencode-ai/client", () => ({
  OpenCode: { make: makeMock },
}));

vi.mock("@opencode-ai/client/service", () => ({
  Service: {
    discover: discoverMock,
    ensure: ensureMock,
    stop: stopMock,
    headers: headersMock,
  },
}));

import {
  clearClientManagerRegistry,
  createClientManager,
  createClientManagerFromPort,
  createClientManagerFromSettings,
  mergeDefaultHeaders,
} from "./opencode-client-manager.js";

interface FakeClientOverrides {
  healthError?: unknown;
  healthVersion?: string;
  migrationStatus?:
    | { status: "required" | "completed" }
    | { status: "running"; progress: { label: string } }
    | { status: "error"; error: string };
  migrationError?: unknown;
}

function createFakeClient(overrides: FakeClientOverrides = {}) {
  return {
    health: {
      get: vi.fn(async () => {
        if (overrides.healthError !== undefined) {
          throw overrides.healthError;
        }
        return {
          healthy: true as const,
          version: overrides.healthVersion ?? "2.0.0",
          pid: 4242,
        };
      }),
    },
    migration: {
      v1: {
        status: vi.fn(async () => {
          if (overrides.migrationError !== undefined) {
            throw overrides.migrationError;
          }
          return overrides.migrationStatus ?? { status: "completed" as const };
        }),
      },
    },
  };
}

type FakeClient = ReturnType<typeof createFakeClient>;

function asSuppliedClient(fake: FakeClient): OpencodeClient {
  return fake as unknown as OpencodeClient;
}

function createTestLogger(): Logger & {
  warnings: string[];
  debugMessages: string[];
} {
  const warnings: string[] = [];
  const debugMessages: string[] = [];
  return {
    warnings,
    debugMessages,
    warn: (message: string) => warnings.push(message),
    error: () => {},
    debug: (message: string) => debugMessages.push(message),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearClientManagerRegistry();
  makeMock.mockImplementation(() => createFakeClient());
  discoverMock.mockResolvedValue({
    url: "http://127.0.0.1:5555",
    auth: undefined,
  });
  ensureMock.mockResolvedValue({
    url: "http://127.0.0.1:6666",
    auth: { type: "basic", username: "oc", password: "secret" },
  });
  headersMock.mockReturnValue(undefined);
  stopMock.mockResolvedValue(undefined);
});

describe("backend selection", () => {
  it("uses a caller-supplied client without constructing or discovering", async () => {
    const fake = createFakeClient();
    const manager = createClientManager({ client: asSuppliedClient(fake) });

    const port = await manager.getPort();

    expect(port).toBe(fake as unknown as OpencodeClientPort);
    expect(makeMock).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(manager.getServerUrl()).toBeUndefined();
    expect(manager.isServerManaged()).toBe(false);
  });

  it("returns a caller-supplied manager as-is from settings", () => {
    const injected = {
      getPort: vi.fn(),
      getServerUrl: vi.fn(),
      isServerManaged: vi.fn(),
      stopService: vi.fn(),
      dispose: vi.fn(),
    };
    const manager = createClientManagerFromSettings({
      clientManager: injected,
    });
    expect(manager).toBe(injected);
  });

  it("prefers a caller-supplied client over a caller-supplied manager", async () => {
    const fake = createFakeClient();
    const injected = {
      getPort: vi.fn(),
      getServerUrl: vi.fn(),
      isServerManaged: vi.fn(),
      stopService: vi.fn(),
      dispose: vi.fn(),
    };
    const manager = createClientManagerFromSettings({
      client: asSuppliedClient(fake),
      clientManager: injected,
    });

    expect(manager).not.toBe(injected);
    await manager.getPort();
    expect(injected.getPort).not.toHaveBeenCalled();
  });

  it("constructs a client from baseUrl and skips service discovery", async () => {
    const manager = createClientManager({
      baseUrl: "http://localhost:4096",
      service: { file: "/ignored" },
    });

    await manager.getPort();

    expect(makeMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:4096",
      fetch: undefined,
      headers: undefined,
    });
    expect(discoverMock).not.toHaveBeenCalled();
    expect(manager.getServerUrl()).toBe("http://localhost:4096");
    expect(manager.isServerManaged()).toBe(false);
  });

  it("discovers the local service when neither client nor baseUrl is set", async () => {
    const version = (v: string) => v.startsWith("2.");
    const manager = createClientManager({
      service: { file: "/reg.json", version },
    });

    await manager.getPort();

    expect(discoverMock).toHaveBeenCalledWith({ file: "/reg.json", version });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(makeMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:5555" }),
    );
    expect(manager.getServerUrl()).toBe("http://127.0.0.1:5555");
  });

  it("fails discovery with an actionable error when nothing is registered", async () => {
    discoverMock.mockResolvedValue(undefined);
    const manager = createClientManager({ service: { file: "/reg.json" } });

    await expect(manager.getPort()).rejects.toThrow(
      /No registered OpenCode service found.*\/reg\.json.*autoStart/s,
    );
  });

  it("mentions version filtering in the discovery error when a predicate is set", async () => {
    discoverMock.mockResolvedValue(undefined);
    const manager = createClientManager({
      service: { version: (v: string) => v.startsWith("2.") },
    });

    await expect(manager.getPort()).rejects.toThrow(
      /filtered out by the configured `service\.version` predicate/,
    );
  });

  it("wraps auto-start failures in an actionable error", async () => {
    const cause = new Error(
      "Timed out waiting for the background service to start",
    );
    ensureMock.mockRejectedValue(cause);
    const manager = createClientManager({
      autoStart: true,
      service: { file: "/owned.json" },
    });

    const failure = await manager.getPort().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(
      /Failed to auto-start the OpenCode service.*\/owned\.json.*Timed out waiting.*opencode serve\s+--service` is broken.*baseUrl/s,
    );
    expect(failure?.cause).toBe(cause);
  });

  it("auto-starts via Service.ensure and tracks managed state via onStart", async () => {
    const userOnStart = vi.fn();
    ensureMock.mockImplementation(
      async (options: {
        onStart?: (reason: string, previous?: string) => void;
      }) => {
        options.onStart?.("missing");
        return { url: "http://127.0.0.1:6666", auth: undefined };
      },
    );
    const manager = createClientManager({
      autoStart: true,
      service: {
        file: "/owned.json",
        command: ["opencode", "serve", "--service"],
        env: { OC_TEST: "1" },
        onStart: userOnStart,
      },
    });

    await manager.getPort();

    expect(ensureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "/owned.json",
        command: ["opencode", "serve", "--service"],
        env: { OC_TEST: "1" },
      }),
    );
    expect(userOnStart).toHaveBeenCalledWith("missing", undefined);
    expect(manager.isServerManaged()).toBe(true);
  });

  it("does not report managed when ensure attached to an existing service", async () => {
    const manager = createClientManager({ autoStart: true });
    await manager.getPort();
    expect(manager.isServerManaged()).toBe(false);
  });

  it("wraps an injected port via the embedded seam", async () => {
    const fake = createFakeClient();
    const manager = createClientManagerFromPort(
      fake as unknown as OpencodeClientPort,
    );

    const port = await manager.getPort();

    expect(port).toBe(fake as unknown as OpencodeClientPort);
    expect(makeMock).not.toHaveBeenCalled();
    expect(manager.getServerUrl()).toBeUndefined();
    expect(manager.isServerManaged()).toBe(false);
  });
});

describe("header merge", () => {
  it("merges user headers over service auth headers", async () => {
    headersMock.mockReturnValue({ authorization: "Basic c2VydmljZQ==" });
    const manager = createClientManager({
      autoStart: true,
      clientOptions: {
        headers: { Authorization: "Bearer user-token", "x-app": "one" },
      },
    });

    await manager.getPort();

    const options = makeMock.mock.calls[0]![0] as {
      headers: Record<string, string>;
    };
    expect(options.headers).toEqual({
      authorization: "Bearer user-token",
      "x-app": "one",
    });
  });

  it("keeps service auth when user headers do not override it", async () => {
    headersMock.mockReturnValue({ authorization: "Basic c2VydmljZQ==" });
    const manager = createClientManager({
      service: {},
      clientOptions: { headers: { "x-app": "one" } },
    });

    await manager.getPort();

    const options = makeMock.mock.calls[0]![0] as {
      headers: Record<string, string>;
    };
    expect(options.headers).toEqual({
      authorization: "Basic c2VydmljZQ==",
      "x-app": "one",
    });
  });

  it("drops undefined header values before normalization", () => {
    const merged = mergeDefaultHeaders({ authorization: "Basic x" }, {
      "x-defined": "yes",
      "x-undefined": undefined,
    } as unknown as Record<string, string>);
    expect(merged).toEqual({
      authorization: "Basic x",
      "x-defined": "yes",
    });
  });

  it("returns undefined when nothing merges", () => {
    expect(mergeDefaultHeaders(undefined, undefined)).toBeUndefined();
    expect(mergeDefaultHeaders(undefined, {})).toBeUndefined();
  });
});

describe("preflight", () => {
  it("runs health + migration once per acquisition and logs the version", async () => {
    const fake = createFakeClient({ healthVersion: "2.3.4" });
    makeMock.mockReturnValue(fake);
    const logger = createTestLogger();
    const manager = createClientManager({ baseUrl: "http://x" }, logger);

    await manager.getPort();
    await manager.getPort();

    expect(fake.health.get).toHaveBeenCalledTimes(1);
    expect(fake.migration.v1.status).toHaveBeenCalledTimes(1);
    expect(logger.debugMessages.join("\n")).toContain("2.3.4");
  });

  it("throws on health failure for provider-created backends and retries next call", async () => {
    makeMock.mockImplementation(() =>
      createFakeClient({ healthError: new Error("connection refused") }),
    );
    const manager = createClientManager({ baseUrl: "http://down" });

    await expect(manager.getPort()).rejects.toThrow(
      /Failed to reach OpenCode server.*connection refused/s,
    );

    makeMock.mockImplementation(() => createFakeClient());
    await expect(manager.getPort()).resolves.toBeDefined();
    expect(makeMock).toHaveBeenCalledTimes(2);
  });

  it("degrades health failure to a warning for caller-supplied clients", async () => {
    const fake = createFakeClient({ healthError: new Error("boom") });
    const logger = createTestLogger();
    const manager = createClientManager(
      { client: asSuppliedClient(fake) },
      logger,
    );

    await expect(manager.getPort()).resolves.toBeDefined();
    expect(logger.warnings.join("\n")).toContain("health preflight failed");
  });

  it("warns on migration required/running/error but never blocks", async () => {
    for (const migrationStatus of [
      { status: "required" as const },
      { status: "running" as const, progress: { label: "messages" } },
      { status: "error" as const, error: "disk full" },
    ]) {
      clearClientManagerRegistry();
      const fake = createFakeClient({ migrationStatus });
      makeMock.mockReturnValue(fake);
      const logger = createTestLogger();
      const manager = createClientManager({ baseUrl: "http://x" }, logger);

      await expect(manager.getPort()).resolves.toBeDefined();
      expect(logger.warnings.join("\n")).toContain("migration");
    }
  });

  it("warns when migration preflight itself fails", async () => {
    const fake = createFakeClient({ migrationError: new Error("404") });
    makeMock.mockReturnValue(fake);
    const logger = createTestLogger();
    const manager = createClientManager({ baseUrl: "http://x" }, logger);

    await expect(manager.getPort()).resolves.toBeDefined();
    expect(logger.warnings.join("\n")).toContain("migration preflight failed");
  });

  it("rejects on version-predicate mismatch for the service backend", async () => {
    // discover/ensure gate on the predicate too; the health re-check catches
    // a stale registration racing a server swap.
    makeMock.mockReturnValue(createFakeClient({ healthVersion: "1.9.0" }));
    const manager = createClientManager({
      service: { version: (v: string) => v.startsWith("2.") },
    });

    await expect(manager.getPort()).rejects.toThrow(
      /version 1\.9\.0 does not satisfy/,
    );
  });
});

/** `Service.ensure` that actually spawns — fires `onStart`, as a real start does. */
function ensureSpawns(): void {
  ensureMock.mockImplementation(
    async (options: {
      onStart?: (reason: string, previous?: string) => void;
    }) => {
      options.onStart?.("missing");
      return { url: "http://127.0.0.1:6666", auth: undefined };
    },
  );
}

describe("ownership and disposal", () => {
  it("never stops the service for caller-supplied clients on dispose", async () => {
    const manager = createClientManager({
      client: asSuppliedClient(createFakeClient()),
    });
    await manager.getPort();
    await manager.dispose();

    expect(stopMock).not.toHaveBeenCalled();
    await expect(manager.getPort()).rejects.toThrow(/disposed/);
  });

  it("stops the service on dispose only in owned mode (dedicated file + autoStart + actually spawned)", async () => {
    ensureSpawns();
    const owned = createClientManager({
      autoStart: true,
      service: { file: "/owned.json" },
    });
    await owned.getPort();
    await owned.dispose();
    expect(stopMock).toHaveBeenCalledWith({ file: "/owned.json" });
  });

  it("does not stop a pre-existing service ensure reused rather than spawned", async () => {
    // The default `ensureMock` returns an endpoint WITHOUT calling `onStart`
    // — exactly what `Service.ensure` does when a healthy service is already
    // registered at that file. Ownership is what `onStart` signals, not the
    // `autoStart` + dedicated-file configuration.
    const manager = createClientManager({
      autoStart: true,
      service: { file: "/owned.json" },
    });
    await manager.getPort();
    await manager.dispose();
    expect(stopMock).not.toHaveBeenCalled();
  });

  it("does not stop an owned-mode service that was never started", async () => {
    // Configured for owned mode but disposed before any port was acquired:
    // nothing was spawned, so nothing may be stopped.
    const manager = createClientManager({
      autoStart: true,
      service: { file: "/owned.json" },
    });
    await manager.dispose();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
  });

  it("does not stop a default-registration service on dispose even with autoStart", async () => {
    const manager = createClientManager({ autoStart: true });
    await manager.getPort();
    await manager.dispose();
    expect(stopMock).not.toHaveBeenCalled();
  });

  it("does not stop a merely discovered service on dispose even with a file", async () => {
    const manager = createClientManager({ service: { file: "/shared.json" } });
    await manager.getPort();
    await manager.dispose();
    expect(stopMock).not.toHaveBeenCalled();
  });

  it("stopService() explicitly stops the registered service on the service backend", async () => {
    const manager = createClientManager({ service: { file: "/reg.json" } });
    await manager.stopService();
    expect(stopMock).toHaveBeenCalledWith({ file: "/reg.json" });

    const defaultRegistration = createClientManager({});
    await defaultRegistration.stopService();
    expect(stopMock).toHaveBeenCalledWith({});
  });

  it("stopService() throws on non-service backends", async () => {
    const baseUrlManager = createClientManager({ baseUrl: "http://x" });
    await expect(baseUrlManager.stopService()).rejects.toThrow(
      /only available on the service-discovery backend/,
    );

    const clientManager = createClientManager({
      client: asSuppliedClient(createFakeClient()),
    });
    await expect(clientManager.stopService()).rejects.toThrow(
      /only available on the service-discovery backend/,
    );
  });
});

describe("registry identity", () => {
  // Sharing is observed behaviorally: shared identity → one constructed
  // client (one OpenCode.make call, same cached port); distinct identity →
  // distinct clients. Holders receive per-holder leases, so lease-object
  // identity is never the sharing signal.
  it("shares one manager for identical effective identity", async () => {
    const first = createClientManagerFromSettings({ baseUrl: "http://x" });
    const second = createClientManagerFromSettings({ baseUrl: "http://x" });
    expect(await second.getPort()).toBe(await first.getPort());
    expect(makeMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes configs differing only in headers", async () => {
    const first = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { headers: { authorization: "Bearer a" } },
    });
    const second = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { headers: { authorization: "Bearer b" } },
    });
    expect(await second.getPort()).not.toBe(await first.getPort());
    expect(makeMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes header identities that collide under naive key=value,… serialization", async () => {
    const first = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { headers: { authorization: "Bearer a,x=y" } },
    });
    const second = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { headers: { authorization: "Bearer a", x: "y" } },
    });
    expect(await second.getPort()).not.toBe(await first.getPort());
    expect(makeMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes service commands that join to the same string", async () => {
    const first = createClientManagerFromSettings({
      autoStart: true,
      service: { command: ["opencode", "serve --service"] },
    });
    const second = createClientManagerFromSettings({
      autoStart: true,
      service: { command: ["opencode", "serve", "--service"] },
    });
    expect(await second.getPort()).not.toBe(await first.getPort());
    expect(makeMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes configs differing only in fetch identity", async () => {
    const fetchA = vi.fn() as unknown as typeof fetch;
    const fetchB = vi.fn() as unknown as typeof fetch;
    const first = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { fetch: fetchA },
    });
    const second = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { fetch: fetchB },
    });
    const third = createClientManagerFromSettings({
      baseUrl: "http://x",
      clientOptions: { fetch: fetchA },
    });
    expect(await second.getPort()).not.toBe(await first.getPort());
    expect(await third.getPort()).toBe(await first.getPort());
    expect(makeMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes service configs by registration file and autoStart", async () => {
    const discoverDefault = createClientManagerFromSettings({});
    const discoverFile = createClientManagerFromSettings({
      service: { file: "/a.json" },
    });
    const ensureFile = createClientManagerFromSettings({
      service: { file: "/a.json" },
      autoStart: true,
    });
    const defaultPort = await discoverDefault.getPort();
    const filePort = await discoverFile.getPort();
    const ensurePort = await ensureFile.getPort();
    expect(filePort).not.toBe(defaultPort);
    expect(ensurePort).not.toBe(filePort);
    expect(makeMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache caller-supplied clients", () => {
    const client = asSuppliedClient(createFakeClient());
    const first = createClientManagerFromSettings({ client });
    const second = createClientManagerFromSettings({ client });
    expect(second).not.toBe(first);
  });

  it("reference-counts shared managers across holders", async () => {
    const first = createClientManagerFromSettings({ baseUrl: "http://x" });
    const second = createClientManagerFromSettings({ baseUrl: "http://x" });
    expect(await second.getPort()).toBe(await first.getPort());

    await first.dispose();
    // Still retained by the second holder.
    await expect(second.getPort()).resolves.toBeDefined();

    await second.dispose();
    await expect(second.getPort()).rejects.toThrow(/disposed/);

    // Fully disposed managers leave the registry; a new request gets a
    // fresh manager (a new constructed client).
    const third = createClientManagerFromSettings({ baseUrl: "http://x" });
    await expect(third.getPort()).resolves.toBeDefined();
    expect(makeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate dispose by one holder from releasing another holder", async () => {
    const first = createClientManagerFromSettings({ baseUrl: "http://x" });
    const second = createClientManagerFromSettings({ baseUrl: "http://x" });

    await first.dispose();
    await first.dispose(); // duplicate — must not decrement the shared count
    await expect(first.getPort()).rejects.toThrow(/disposed/);
    await expect(second.getPort()).resolves.toBeDefined();

    await second.dispose();
    await expect(second.getPort()).rejects.toThrow(/disposed/);
  });

  it("keeps duplicate dispose from stopping another holder's owned service", async () => {
    ensureSpawns();
    const settings = {
      autoStart: true,
      service: { file: "/owned.json" },
    };
    const first = createClientManagerFromSettings(settings);
    const second = createClientManagerFromSettings(settings);
    await second.getPort();

    await first.dispose();
    await first.dispose(); // duplicate — owned service must keep running
    expect(stopMock).not.toHaveBeenCalled();
    await expect(second.getPort()).resolves.toBeDefined();

    await second.dispose();
    expect(stopMock).toHaveBeenCalledWith({ file: "/owned.json" });
  });
});
