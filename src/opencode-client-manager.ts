/**
 * Client-manager backends: everything between provider settings and the
 * client-port the language model consumes via its `getPort` seam.
 *
 * Backends (design doc §2.2, precedence in this order):
 *   (a) caller-supplied client — wrapped, never disposed by us;
 *   (b) caller-supplied manager — passthrough (handled by the provider
 *       factory / `createClientManagerFromSettings`), never disposed by us;
 *   (c) `baseUrl` → `OpenCode.make({baseUrl, fetch?, headers?})`;
 *   (d) connect-without-start → `Service.discover({file?, version?})`, with
 *       an actionable failure when nothing is registered;
 *   (e) auto-start → `Service.ensure(...)` + `Service.headers(endpoint)`
 *       merged under user headers;
 *   (f) embedded — NOT built in this stage. {@link createClientManagerFromPort}
 *       is the seam: a later `./embedded` entrypoint constructs the in-process
 *       host and injects its port here without touching the network backends.
 *
 * Ownership: the manager holds no subscriptions itself (event subscriptions
 * are per-generation in the language model, aborted by each call's signal),
 * so disposal only invalidates the cached port and — in owned mode only —
 * stops the service. Owned means all three: a dedicated registration
 * `file`, `autoStart`, and a `Service.ensure` that actually spawned the
 * process (its `onStart` fired). Disposal never closes a caller-supplied
 * client, never stops the shared default-registration service, and never
 * stops a service `ensure` merely reused; `stopService()` is the explicit
 * user-invoked stop for those.
 */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import type { Endpoint } from "@opencode-ai/client/service";
import { asClientPort, type OpencodeClientPort } from "./client-port.js";
import { extractErrorMessage } from "./errors.js";
import { getLogger } from "./logger.js";
import type {
  Logger,
  OpencodeClient,
  OpencodeClientManager,
  OpencodeClientOptions,
  OpencodeProviderSettings,
  OpencodeServiceOptions,
} from "./types.js";

export type { OpencodeClientManager } from "./types.js";

/** Internal backend discriminator for {@link DefaultOpencodeClientManager}. */
type ManagerBackend =
  | { kind: "client"; client: OpencodeClient }
  | {
      kind: "baseUrl";
      baseUrl: string;
      clientOptions?: OpencodeClientOptions | undefined;
    }
  | {
      kind: "service";
      autoStart: boolean;
      service?: OpencodeServiceOptions | undefined;
      clientOptions?: OpencodeClientOptions | undefined;
    }
  | { kind: "port"; port: OpencodeClientPort; serverUrl?: string | undefined };

/**
 * Merge default headers for client construction: service auth headers first,
 * user headers over them (user > service). Entries with undefined values are
 * dropped before normalization — the `RequestInit` record form does not admit
 * them even though callers may pass them. Per-call AI SDK headers are layered
 * on top of these later, per request, by the language model.
 */
export function mergeDefaultHeaders(
  serviceHeaders: Record<string, string> | undefined,
  userHeaders: RequestInit["headers"] | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...serviceHeaders };
  if (userHeaders !== undefined) {
    const source =
      typeof (userHeaders as Headers).forEach === "function" ||
      Array.isArray(userHeaders)
        ? userHeaders
        : Object.fromEntries(
            Object.entries(userHeaders as Record<string, string | undefined>)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          );
    // Headers normalizes casing, so a user "Authorization" overrides the
    // service's lowercase "authorization".
    new Headers(source as ConstructorParameters<typeof Headers>[0]).forEach(
      (value, key) => {
        for (const existing of Object.keys(merged)) {
          if (existing.toLowerCase() === key) {
            delete merged[existing];
          }
        }
        merged[key] = value;
      },
    );
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Standard client-manager implementation over the network backends. */
class DefaultOpencodeClientManager implements OpencodeClientManager {
  private portPromise: Promise<OpencodeClientPort> | undefined;
  private endpoint: Endpoint | undefined;
  private serverManaged = false;
  private disposed = false;
  /** Registry sharing: real disposal happens when the last holder disposes. */
  private refCount = 1;

  constructor(
    private readonly backend: ManagerBackend,
    private readonly logger: Logger,
    private readonly registryKey?: string,
  ) {}

  /** @internal Registry sharing: one more holder of this manager. */
  retain(): void {
    this.refCount += 1;
  }

  getPort(): Promise<OpencodeClientPort> {
    if (this.disposed) {
      return Promise.reject(
        new Error("OpencodeClientManager has been disposed"),
      );
    }
    if (!this.portPromise) {
      const acquisition = this.acquirePort();
      this.portPromise = acquisition;
      // A failed acquisition is not cached: the next getPort() retries the
      // full backend acquisition + preflight.
      acquisition.catch(() => {
        if (this.portPromise === acquisition) {
          this.portPromise = undefined;
        }
      });
    }
    return this.portPromise;
  }

  getServerUrl(): string | undefined {
    switch (this.backend.kind) {
      case "baseUrl":
        return this.backend.baseUrl;
      case "service":
        return this.endpoint?.url;
      case "port":
        return this.backend.serverUrl;
      case "client":
        // The configured URL of a caller-supplied client is not recoverable
        // from the v2 client surface.
        return undefined;
    }
  }

  isServerManaged(): boolean {
    return this.serverManaged;
  }

  async stopService(): Promise<void> {
    if (this.backend.kind !== "service") {
      throw new Error(
        "stopService() is only available on the service-discovery backend " +
          "(no client, clientManager, or baseUrl configured)",
      );
    }
    const file = this.backend.service?.file;
    await Service.stop(file !== undefined ? { file } : {});
    this.portPromise = undefined;
    this.endpoint = undefined;
    this.serverManaged = false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.refCount -= 1;
    if (this.refCount > 0) {
      return;
    }
    this.disposed = true;
    if (this.registryKey !== undefined) {
      managerRegistry.delete(this.registryKey);
    }
    this.portPromise = undefined;
    // Owned mode only: a dedicated registration file the provider was
    // configured to spawn into AND actually did spawn — `serverManaged` is
    // set from the `Service.ensure` `onStart` callback, which only fires
    // when ensure starts the process. Never the shared default
    // registration, and never a service we merely discovered: `ensure`
    // silently reuses an already-running service at the same file, and
    // stopping that would kill a process we do not own.
    if (
      this.serverManaged &&
      this.backend.kind === "service" &&
      this.backend.autoStart &&
      this.backend.service?.file !== undefined
    ) {
      try {
        await Service.stop({ file: this.backend.service.file });
      } catch (error) {
        this.logger.warn(
          `Failed to stop owned OpenCode service on dispose: ${extractErrorMessage(error)}`,
        );
      }
    }
  }

  private async acquirePort(): Promise<OpencodeClientPort> {
    const { port, callerSupplied } = await this.buildPort();
    await this.preflight(port, callerSupplied);
    return port;
  }

  private async buildPort(): Promise<{
    port: OpencodeClientPort;
    callerSupplied: boolean;
  }> {
    switch (this.backend.kind) {
      case "client":
        return {
          port: asClientPort(this.backend.client),
          callerSupplied: true,
        };
      case "port":
        return { port: this.backend.port, callerSupplied: true };
      case "baseUrl": {
        const options = this.backend.clientOptions;
        const client = OpenCode.make({
          baseUrl: this.backend.baseUrl,
          fetch: options?.fetch,
          headers: mergeDefaultHeaders(undefined, options?.headers),
        });
        return { port: asClientPort(client), callerSupplied: false };
      }
      case "service": {
        const endpoint = await this.resolveEndpoint();
        this.endpoint = endpoint;
        const options = this.backend.clientOptions;
        const client = OpenCode.make({
          baseUrl: endpoint.url,
          fetch: options?.fetch,
          headers: mergeDefaultHeaders(
            Service.headers(endpoint),
            options?.headers,
          ),
        });
        return { port: asClientPort(client), callerSupplied: false };
      }
    }
  }

  private async resolveEndpoint(): Promise<Endpoint> {
    if (this.backend.kind !== "service") {
      throw new Error("resolveEndpoint requires the service backend");
    }
    const service = this.backend.service;
    if (this.backend.autoStart) {
      try {
        return await Service.ensure({
          file: service?.file,
          version: service?.version,
          command: service?.command,
          env: service?.env,
          onStart: (reason, previousVersion) => {
            this.serverManaged = true;
            this.logger.debug?.(
              `Starting OpenCode service (${reason}${previousVersion ? `, previous version ${previousVersion}` : ""})`,
            );
            service?.onStart?.(reason, previousVersion);
          },
        });
      } catch (error) {
        // Spawn/exit/timeout failures from Service.ensure need the same
        // actionable context as a discovery miss: the default command is
        // broken on published CLI builds, and `baseUrl` is the usable path.
        throw new Error(
          "Failed to auto-start the OpenCode service" +
            (service?.file ? ` (registration file: ${service.file})` : "") +
            `: ${extractErrorMessage(error)}. Note: \`opencode serve ` +
            "--service` is broken on current published CLI builds (see " +
            "docs/v2-spike-findings.md) — pass `baseUrl` to point at a " +
            "server you started yourself, or supply a `service.command` " +
            "that serves the service-registration contract.",
          { cause: error },
        );
      }
    }
    const discovered = await Service.discover({
      file: service?.file,
      version: service?.version,
    });
    if (!discovered) {
      throw new Error(
        "No registered OpenCode service found" +
          (service?.file ? ` (registration file: ${service.file})` : "") +
          (service?.version !== undefined
            ? ", or a registered service was filtered out by the configured " +
              "`service.version` predicate"
            : "") +
          ". Start one with `opencode serve --service`, pass `baseUrl` to " +
          "point at a running server, or set `autoStart: true` to let the " +
          "provider start it. Note: `opencode serve --service` is broken on " +
          "current published CLI builds (see docs/v2-spike-findings.md).",
      );
    }
    return discovered;
  }

  /**
   * First-acquisition preflight: `health.get()` (version logged; gated by the
   * service `version` predicate when configured) and `migration.v1.status()`
   * (warn on required/running/error; never block). Both degrade to warnings
   * for caller-supplied clients/ports — the caller owns that client's
   * lifecycle and configuration.
   */
  private async preflight(
    port: OpencodeClientPort,
    callerSupplied: boolean,
  ): Promise<void> {
    let version: string | undefined;
    try {
      const health = await port.health.get();
      version = health.version;
      this.logger.debug?.(
        `OpenCode server healthy: version ${health.version}, pid ${health.pid}`,
      );
    } catch (error) {
      const detail = extractErrorMessage(error);
      if (callerSupplied) {
        this.logger.warn(`OpenCode health preflight failed: ${detail}`);
      } else {
        throw new Error(
          `Failed to reach OpenCode server${
            this.getServerUrl() ? ` at ${this.getServerUrl()}` : ""
          } (health.get): ${detail}`,
          { cause: error },
        );
      }
    }

    if (version !== undefined) {
      const predicate =
        this.backend.kind === "service"
          ? this.backend.service?.version
          : undefined;
      const satisfied =
        predicate === undefined ||
        (typeof predicate === "string"
          ? predicate === version
          : predicate(version));
      if (!satisfied) {
        // Discovery/ensure already gate on this predicate; this re-check
        // catches a stale registration file racing a server swap.
        throw new Error(
          `OpenCode server version ${version} does not satisfy the configured service version predicate`,
        );
      }
    }

    try {
      const migration = await port.migration.v1.status();
      if (migration.status === "required") {
        this.logger.warn(
          "OpenCode v1→v2 data migration is required but has not run; " +
            "sessions and history may be unavailable until it completes",
        );
      } else if (migration.status === "running") {
        this.logger.warn(
          `OpenCode v1→v2 data migration is running (${migration.progress.label}); results may be incomplete until it finishes`,
        );
      } else if (migration.status === "error") {
        this.logger.warn(
          `OpenCode v1→v2 data migration failed: ${migration.error}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `OpenCode migration preflight failed: ${extractErrorMessage(error)}`,
      );
    }
  }
}

/**
 * Per-holder view of a registry-shared manager. The underlying manager is
 * reference-counted, so each holder must release exactly once; this lease
 * makes `dispose()` idempotent per holder — a duplicate dispose (e.g. from
 * overlapping cleanup/finally paths) cannot decrement another holder's
 * reference or stop a service another provider is still using.
 */
class SharedManagerLease implements OpencodeClientManager {
  private released = false;

  constructor(private readonly shared: DefaultOpencodeClientManager) {}

  getPort(): Promise<OpencodeClientPort> {
    if (this.released) {
      return Promise.reject(
        new Error("OpencodeClientManager has been disposed"),
      );
    }
    return this.shared.getPort();
  }

  getServerUrl(): string | undefined {
    return this.shared.getServerUrl();
  }

  isServerManaged(): boolean {
    return this.shared.isServerManaged();
  }

  stopService(): Promise<void> {
    return this.shared.stopService();
  }

  async dispose(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.shared.dispose();
  }
}

// --- registry -------------------------------------------------------------

/**
 * Managers created from settings are shared per full effective identity:
 * backend kind + baseUrl/registration file + normalized headers + custom
 * fetch/version-predicate/onStart identity + spawn command/env. Function
 * identity is tracked by reference (WeakMap), so two configs differing only
 * in a `fetch` implementation get distinct managers.
 */
const managerRegistry = new Map<string, DefaultOpencodeClientManager>();

const functionIds = new WeakMap<object, number>();
let nextFunctionId = 0;

function referenceId(value: object | undefined): string {
  if (value === undefined) {
    return "-";
  }
  let id = functionIds.get(value);
  if (id === undefined) {
    nextFunctionId += 1;
    id = nextFunctionId;
    functionIds.set(value, id);
  }
  return `#${id}`;
}

/**
 * Structured header identity for the registry key: sorted entries, embedded
 * as a nested array in the JSON key so values containing `=`/`,` cannot
 * collide with distinct header sets.
 */
function headersIdentity(
  headers: RequestInit["headers"] | undefined,
): [string, string][] | "-" {
  const normalized = mergeDefaultHeaders(undefined, headers);
  if (!normalized) {
    return "-";
  }
  return Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b));
}

function registryKeyFor(settings: OpencodeProviderSettings): string {
  const clientOptions = settings.clientOptions;
  const shared = [
    headersIdentity(clientOptions?.headers),
    referenceId(clientOptions?.fetch),
  ];
  if (settings.baseUrl) {
    return JSON.stringify(["baseUrl", settings.baseUrl, ...shared]);
  }
  const service = settings.service;
  return JSON.stringify([
    "service",
    settings.autoStart === true,
    service?.file ?? "-",
    typeof service?.version === "string"
      ? service.version
      : referenceId(service?.version),
    // Arrays/entries kept structural: `["a b"]` must not collide with
    // `["a","b"]`, and env key order must not affect identity.
    service?.command ?? "-",
    service?.env
      ? Object.entries(service.env).sort(([a], [b]) => a.localeCompare(b))
      : "-",
    referenceId(service?.onStart),
    ...shared,
  ]);
}

function backendFromSettings(
  settings: OpencodeProviderSettings,
): ManagerBackend {
  if (settings.client) {
    return { kind: "client", client: settings.client };
  }
  if (settings.baseUrl) {
    return {
      kind: "baseUrl",
      baseUrl: settings.baseUrl,
      clientOptions: settings.clientOptions,
    };
  }
  return {
    kind: "service",
    autoStart: settings.autoStart === true,
    service: settings.service,
    clientOptions: settings.clientOptions,
  };
}

/**
 * Create a fresh (uncached) client manager for the given settings. The
 * `clientManager` setting is not consulted here — injection passthrough is
 * {@link createClientManagerFromSettings}' job.
 */
export function createClientManager(
  settings: OpencodeProviderSettings = {},
  logger?: Logger | false,
): OpencodeClientManager {
  return new DefaultOpencodeClientManager(
    backendFromSettings(settings),
    getLogger(logger, settings.defaultSettings?.verbose),
  );
}

/**
 * Resolve the client manager for provider settings, applying backend
 * precedence (client > clientManager > baseUrl > service):
 * - caller-supplied `client` → a fresh wrapping manager (never cached: the
 *   caller owns the client, and preflight failures only warn);
 * - caller-supplied `clientManager` → returned as-is;
 * - `baseUrl`/service backends → shared via a registry keyed on the full
 *   effective identity, so two providers with identical config reuse one
 *   manager (disposal is reference-counted). Each call returns a fresh
 *   per-holder lease whose `dispose()` is idempotent, so one holder's
 *   duplicate dispose cannot release another holder's reference.
 */
export function createClientManagerFromSettings(
  settings: OpencodeProviderSettings = {},
  logger?: Logger | false,
): OpencodeClientManager {
  if (settings.client) {
    return createClientManager(settings, logger);
  }
  if (settings.clientManager) {
    return settings.clientManager;
  }
  const key = registryKeyFor(settings);
  const existing = managerRegistry.get(key);
  if (existing) {
    existing.retain();
    return new SharedManagerLease(existing);
  }
  const manager = new DefaultOpencodeClientManager(
    backendFromSettings(settings),
    getLogger(logger, settings.defaultSettings?.verbose),
    key,
  );
  managerRegistry.set(key, manager);
  return new SharedManagerLease(manager);
}

/**
 * Embedded-backend seam (backend (f), not built in this stage): wrap an
 * already-constructed client-port — e.g. the in-process embedded host a
 * future `./embedded` entrypoint creates — in a manager the provider factory
 * accepts via the `clientManager` setting. Preflight failures degrade to
 * warnings (the injector owns the port); `getServerUrl()` returns the
 * optional `serverUrl` hint (an embedded host exposes no endpoint);
 * disposal releases nothing — the injector owns the host lifecycle.
 */
export function createClientManagerFromPort(
  port: OpencodeClientPort,
  options?: { logger?: Logger | false; serverUrl?: string },
): OpencodeClientManager {
  return new DefaultOpencodeClientManager(
    { kind: "port", port, serverUrl: options?.serverUrl },
    getLogger(options?.logger),
  );
}

/** @internal Test hook: drop all shared managers. */
export function clearClientManagerRegistry(): void {
  managerRegistry.clear();
}
