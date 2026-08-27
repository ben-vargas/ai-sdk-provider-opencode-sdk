/**
 * Provider factory tests: callable/alias surface, NoSuchModelError for
 * unsupported model types, settings merging, model-instance semantics
 * (no caching — one instance per conversation), manager wiring, and
 * ownership on dispose (owned vs injected manager).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoSuchModelError } from "@ai-sdk/provider";
import type { OpencodeClientPort } from "./client-port.js";
import { clearClientManagerRegistry } from "./opencode-client-manager.js";
import { OpencodeLanguageModel } from "./opencode-language-model.js";
import {
  createOpencode,
  opencode,
  OpencodeModels,
} from "./opencode-provider.js";
import type { OpencodeClient, OpencodeClientManager } from "./types.js";

function createFakeClient(): OpencodeClient {
  return {
    health: {
      get: vi.fn(async () => ({
        healthy: true as const,
        version: "2.0.0",
        pid: 1,
      })),
    },
    migration: {
      v1: { status: vi.fn(async () => ({ status: "completed" as const })) },
    },
  } as unknown as OpencodeClient;
}

function createInjectedManager(): OpencodeClientManager & {
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    getPort: vi.fn(async () => ({}) as OpencodeClientPort),
    getServerUrl: vi.fn(() => "http://injected"),
    isServerManaged: vi.fn(() => false),
    stopService: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  clearClientManagerRegistry();
});

describe("createOpencode", () => {
  it("creates language models via call, languageModel, and chat", () => {
    const provider = createOpencode({ client: createFakeClient() });

    for (const model of [
      provider("anthropic/claude-opus-4-5-20251101"),
      provider.languageModel("anthropic/claude-opus-4-5-20251101"),
      provider.chat("anthropic/claude-opus-4-5-20251101"),
    ]) {
      expect(model).toBeInstanceOf(OpencodeLanguageModel);
      expect(model.provider).toBe("opencode");
      expect(model.modelId).toBe("anthropic/claude-opus-4-5-20251101");
      expect(model.specificationVersion).toBe("v4");
    }
  });

  it("reports provider identity", () => {
    const provider = createOpencode({ client: createFakeClient() });
    expect(provider.specificationVersion).toBe("v4");
  });

  it("returns a fresh model instance per call (no caching)", () => {
    // One instance = one conversation = one pinned session; callers reuse an
    // instance across a conversation's calls, not across conversations.
    const provider = createOpencode({ client: createFakeClient() });
    const first = provider("anthropic/claude-opus-4-5-20251101");
    const second = provider("anthropic/claude-opus-4-5-20251101");
    expect(second).not.toBe(first);
  });

  it("throws NoSuchModelError for embedding and image models", () => {
    const provider = createOpencode({ client: createFakeClient() });
    expect(() => provider.embeddingModel("text-embedding")).toThrow(
      NoSuchModelError,
    );
    expect(() => provider.imageModel("image-model")).toThrow(NoSuchModelError);
  });

  it("merges defaultSettings under per-model settings", () => {
    const provider = createOpencode({
      client: createFakeClient(),
      defaultSettings: {
        sessionMode: "existing",
        sessionId: "ses_default",
        logger: false,
      },
    });

    const fromDefaults = provider("anthropic/claude-opus-4-5-20251101");
    expect((fromDefaults as OpencodeLanguageModel).getSessionId()).toBe(
      "ses_default",
    );

    const overridden = provider("anthropic/claude-opus-4-5-20251101", {
      sessionId: "ses_override",
    });
    expect((overridden as OpencodeLanguageModel).getSessionId()).toBe(
      "ses_override",
    );
  });

  it("wires models to the provider's client manager port", async () => {
    const injected = createInjectedManager();
    const fakePort = { marker: true } as unknown as OpencodeClientPort;
    injected.getPort = vi.fn(async () => fakePort);
    const provider = createOpencode({ clientManager: injected });

    provider("anthropic/claude-opus-4-5-20251101");
    // The model resolves the port lazily per call; the manager is the seam.
    await expect(provider.getClientManager().getPort()).resolves.toBe(fakePort);
  });

  it("exposes the injected client manager via getClientManager", () => {
    const injected = createInjectedManager();
    const provider = createOpencode({ clientManager: injected });
    expect(provider.getClientManager()).toBe(injected);
  });

  it("does not dispose an injected client manager", async () => {
    const injected = createInjectedManager();
    const provider = createOpencode({ clientManager: injected });

    await provider.dispose();

    expect(injected.dispose).not.toHaveBeenCalled();
  });

  it("disposes its owned manager (without closing a supplied client)", async () => {
    const client = createFakeClient();
    const provider = createOpencode({ client });

    await provider.dispose();

    await expect(provider.getClientManager().getPort()).rejects.toThrow(
      /disposed/,
    );
  });

  it("dispose is idempotent per provider and cannot release a shared manager twice", async () => {
    // Two providers with identical settings share one registry manager; a
    // duplicate dispose of provider A (plausible in cleanup/finally paths)
    // must not drop provider B's reference.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/health")
        ? { healthy: true, version: "2.0.0", pid: 1 }
        : { status: "completed" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const settings = {
      baseUrl: "http://shared",
      clientOptions: { fetch: fetchImpl },
    };
    const first = createOpencode(settings);
    const second = createOpencode(settings);

    await first.dispose();
    await first.dispose(); // duplicate
    await expect(first.getClientManager().getPort()).rejects.toThrow(
      /disposed/,
    );
    await expect(second.getClientManager().getPort()).resolves.toBeDefined();

    await second.dispose();
    await expect(second.getClientManager().getPort()).rejects.toThrow(
      /disposed/,
    );
  });

  it("prefers a supplied client over an injected manager and warns", () => {
    const injected = createInjectedManager();
    const warnings: string[] = [];
    const provider = createOpencode({
      client: createFakeClient(),
      clientManager: injected,
      defaultSettings: {
        logger: { warn: (m) => warnings.push(m), error: () => {} },
      },
    });

    expect(provider.getClientManager()).not.toBe(injected);
    expect(warnings.join("\n")).toContain(
      "client takes precedence and clientManager will be ignored",
    );
  });
});

describe("default provider instance", () => {
  it("is callable and produces models without touching the network", () => {
    const model = opencode("anthropic/claude-opus-4-5-20251101");
    expect(model).toBeInstanceOf(OpencodeLanguageModel);
  });
});

describe("OpencodeModels", () => {
  it("maps shortcuts to providerID/modelID ids", () => {
    expect(OpencodeModels["nemotron-3.5-lightning-free"]).toBe(
      "opencode/nemotron-3.5-lightning-free",
    );
    expect(OpencodeModels["big-pickle"]).toBe("opencode/big-pickle");
    expect(OpencodeModels["glm-5.2"]).toBe("ollama/glm-5.2:cloud");
    for (const id of Object.values(OpencodeModels)) {
      expect(id).toMatch(/^[^/]+\/[^/]+$/);
    }
  });
});
