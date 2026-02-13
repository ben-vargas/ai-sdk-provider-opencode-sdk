import type { Logger, OpencodeProviderSettings } from "./types.js";
import { getLogger } from "./logger.js";
import { createTimeoutError, extractErrorMessage } from "./errors.js";

// Import types from the SDK
// We'll use dynamic import to handle the async nature of the SDK
type OpencodeClient = Awaited<
  ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
>;
type OpencodeServer = Awaited<
  ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeServer>
>;

/**
 * Options for creating a client manager.
 */
export interface ClientManagerOptions {
  hostname?: string;
  port?: number;
  baseUrl?: string;
  autoStartServer?: boolean;
  serverTimeout?: number;
  cwd?: string;
  logger?: Logger | false;
}

/**
 * Manages the OpenCode server and client lifecycle.
 * Uses singleton pattern to ensure only one server instance per process.
 */
export class OpencodeClientManager {
  private static instance: OpencodeClientManager | null = null;

  private client: OpencodeClient | null = null;
  private server: OpencodeServer | null = null;
  private options: ClientManagerOptions;
  private logger: Logger;
  private initPromise: Promise<OpencodeClient> | null = null;
  private isDisposed = false;
  private cleanupHandlersRegistered = false;
  private cleanupHandlers: {
    exit?: () => void;
    sigint?: () => void;
    sigterm?: () => void;
    uncaughtException?: (error: Error) => void;
  } = {};

  private constructor(options: ClientManagerOptions) {
    // Filter out undefined values to prevent them from overwriting defaults
    const filteredOptions = Object.fromEntries(
      Object.entries(options).filter(([_, v]) => v !== undefined),
    ) as ClientManagerOptions;

    this.options = {
      hostname: "127.0.0.1",
      port: 4096,
      autoStartServer: true,
      serverTimeout: 10000,
      ...filteredOptions,
    };
    this.logger = getLogger(options.logger);

    // Register cleanup on process exit
    this.registerCleanupHandlers();
  }

  /**
   * Get the singleton instance of the client manager.
   */
  static getInstance(options?: ClientManagerOptions): OpencodeClientManager {
    if (!OpencodeClientManager.instance) {
      OpencodeClientManager.instance = new OpencodeClientManager(options ?? {});
    } else if (options) {
      // Update options if provided
      OpencodeClientManager.instance.updateOptions(options);
    }
    return OpencodeClientManager.instance;
  }

  /**
   * Reset the singleton instance.
   * Used primarily for testing.
   */
  static resetInstance(): void {
    if (OpencodeClientManager.instance) {
      OpencodeClientManager.instance.dispose().catch(() => {});
      OpencodeClientManager.instance = null;
    }
  }

  /**
   * Update options for the client manager.
   */
  private updateOptions(options: ClientManagerOptions): void {
    // Only update if client hasn't been initialized yet
    if (!this.client && !this.initPromise) {
      // Filter out undefined values to prevent them from overwriting existing options
      const filteredOptions = Object.fromEntries(
        Object.entries(options).filter(([_, v]) => v !== undefined),
      ) as ClientManagerOptions;

      this.options = {
        ...this.options,
        ...filteredOptions,
      };
      this.logger = getLogger(options.logger ?? this.options.logger);
    }
  }

  /**
   * Get or create the OpenCode client.
   * Will start the server if autoStartServer is true and server isn't running.
   */
  async getClient(): Promise<OpencodeClient> {
    if (this.isDisposed) {
      throw new Error("Client manager has been disposed");
    }

    if (this.client) {
      return this.client;
    }

    // If initialization is already in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization
    this.initPromise = this.initializeClient();

    try {
      this.client = await this.initPromise;
      return this.client;
    } finally {
      this.initPromise = null;
    }
  }

  /**
   * Initialize the client and optionally the server.
   */
  private async initializeClient(): Promise<OpencodeClient> {
    const { createOpencodeClient, createOpencodeServer } =
      await import("@opencode-ai/sdk/v2");

    // Check if we should use an external URL
    if (this.options.baseUrl) {
      this.logger.debug?.(
        `Connecting to external OpenCode server at ${this.options.baseUrl}`,
      );
      return createOpencodeClient({
        baseUrl: this.options.baseUrl,
        directory: this.options.cwd,
      });
    }

    const serverUrl = `http://${this.options.hostname}:${this.options.port}`;

    // Try to connect to existing server first
    if (await this.isServerRunning(serverUrl)) {
      this.logger.debug?.(
        `Connected to existing OpenCode server at ${serverUrl}`,
      );
      return createOpencodeClient({
        baseUrl: serverUrl,
        directory: this.options.cwd,
      });
    }

    // Start server if autoStart is enabled
    if (this.options.autoStartServer) {
      this.logger.debug?.(`Starting OpenCode server at ${serverUrl}`);

      try {
        this.server = await createOpencodeServer({
          hostname: this.options.hostname,
          port: this.options.port,
          timeout: this.options.serverTimeout,
        });

        this.logger.debug?.(`OpenCode server started at ${this.server.url}`);

        return createOpencodeClient({
          baseUrl: this.server.url,
          directory: this.options.cwd,
        });
      } catch (error) {
        const message = extractErrorMessage(error);

        if (message.includes("Timeout")) {
          throw createTimeoutError(
            this.options.serverTimeout ?? 10000,
            "server startup",
          );
        }

        throw new Error(`Failed to start OpenCode server: ${message}`);
      }
    }

    throw new Error(
      `No OpenCode server running at ${serverUrl} and autoStartServer is disabled`,
    );
  }

  /**
   * Check if an OpenCode server is running at the given URL.
   */
  private async isServerRunning(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      // If health endpoint doesn't exist, try the config endpoint
      try {
        const response = await fetch(`${baseUrl}/config`, {
          method: "GET",
          signal: AbortSignal.timeout(2000),
        });
        return response.ok;
      } catch {
        return false;
      }
    }
  }

  /**
   * Get the server URL.
   */
  getServerUrl(): string {
    if (this.server) {
      return this.server.url;
    }
    if (this.options.baseUrl) {
      return this.options.baseUrl;
    }
    return `http://${this.options.hostname}:${this.options.port}`;
  }

  /**
   * Check if the server was started by this manager.
   */
  isServerManaged(): boolean {
    return this.server !== null;
  }

  /**
   * Dispose of the client manager, stopping the server if managed.
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.unregisterCleanupHandlers();

    if (this.server) {
      this.logger.debug?.("Stopping managed OpenCode server");
      try {
        this.server.close();
      } catch (error) {
        this.logger.warn(
          `Error stopping server: ${extractErrorMessage(error)}`,
        );
      }
      this.server = null;
    }

    this.client = null;
    this.initPromise = null;
  }

  /**
   * Register cleanup handlers for process exit.
   */
  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered) {
      return;
    }

    const cleanup = () => {
      if (this.server) {
        try {
          this.server.close();
        } catch {
          // Ignore errors during cleanup
        }
      }
    };

    const handleSigint = () => {
      cleanup();
      process.exit(0);
    };

    const handleSigterm = () => {
      cleanup();
      process.exit(0);
    };

    const handleUncaughtException = (error: Error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      cleanup();
      process.exit(1);
    };

    this.cleanupHandlers = {
      exit: cleanup,
      sigint: handleSigint,
      sigterm: handleSigterm,
      uncaughtException: handleUncaughtException,
    };

    // Handle various exit signals
    process.once("exit", cleanup);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    process.once("uncaughtException", handleUncaughtException);
    this.cleanupHandlersRegistered = true;
  }

  private unregisterCleanupHandlers(): void {
    if (!this.cleanupHandlersRegistered) {
      return;
    }

    const { exit, sigint, sigterm, uncaughtException } = this.cleanupHandlers;

    if (exit) {
      process.removeListener("exit", exit);
    }
    if (sigint) {
      process.removeListener("SIGINT", sigint);
    }
    if (sigterm) {
      process.removeListener("SIGTERM", sigterm);
    }
    if (uncaughtException) {
      process.removeListener("uncaughtException", uncaughtException);
    }

    this.cleanupHandlers = {};
    this.cleanupHandlersRegistered = false;
  }
}

/**
 * Create a client manager instance.
 * This is a convenience function that returns a singleton.
 */
export function createClientManager(
  options?: ClientManagerOptions,
): OpencodeClientManager {
  return OpencodeClientManager.getInstance(options);
}

/**
 * Create a client manager from provider settings.
 */
export function createClientManagerFromSettings(
  settings: OpencodeProviderSettings,
  logger?: Logger | false,
): OpencodeClientManager {
  return OpencodeClientManager.getInstance({
    hostname: settings.hostname,
    port: settings.port,
    baseUrl: settings.baseUrl,
    autoStartServer: settings.autoStartServer,
    serverTimeout: settings.serverTimeout,
    // Prefer explicit v2 directory setting; fall back to legacy cwd.
    cwd: settings.defaultSettings?.directory ?? settings.defaultSettings?.cwd,
    logger,
  });
}
