<p align="center">
  <img src="https://img.shields.io/badge/status-beta-orange" alt="beta status">
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/v/ai-sdk-provider-opencode-sdk?color=00A79E" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/unpacked-size/ai-sdk-provider-opencode-sdk?color=00A79E" alt="install size" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/dy/ai-sdk-provider-opencode-sdk.svg?color=00A79E" alt="npm downloads" /></a>
  <a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/badge/node-%3E%3D18-00A79E" alt="Node.js ≥ 18" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/l/ai-sdk-provider-opencode-sdk?color=00A79E" alt="License: MIT" /></a>
</p>

# AI SDK Provider for OpenCode

> **Latest Release**: Version 1.x supports AI SDK v6. For AI SDK v5 support, use the `ai-sdk-v5` tag (0.x.x).

A community provider for the [Vercel AI SDK](https://sdk.vercel.ai/docs) that enables using AI models through [OpenCode](https://opencode.ai) and the `@opencode-ai/sdk`. OpenCode is a terminal-based AI coding assistant that supports multiple providers (Anthropic, OpenAI, Google, and more).

This provider enables you to use OpenCode's AI capabilities through the familiar Vercel AI SDK interface, supporting `generateText()`, `streamText()`, `streamObject()`, and structured output via `generateText()` with `Output.object()`.

## Version Compatibility

| Provider Version | AI SDK Version | NPM Tag     | Status      | Branch                                                                                   |
| ---------------- | -------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| 1.x.x            | v6             | `latest`    | Stable      | `main`                                                                                   |
| 0.x.x            | v5             | `ai-sdk-v5` | Maintenance | [`ai-sdk-v5`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/ai-sdk-v5) |

### Installing the Right Version

**For AI SDK v6 (recommended):**

```bash
npm install ai-sdk-provider-opencode-sdk ai@^6.0.0
```

**For AI SDK v5:**

```bash
npm install ai-sdk-provider-opencode-sdk@ai-sdk-v5 ai@^5.0.0
```

## Zod Compatibility

This package is compatible with **Zod 3 and Zod 4** (aligned with `ai`):

```bash
# With Zod 3
npm install ai-sdk-provider-opencode-sdk ai zod@^3.25.76

# With Zod 4
npm install ai-sdk-provider-opencode-sdk ai zod@^4.1.8
```

## Prerequisites

- Node.js >= 18
- [OpenCode CLI](https://opencode.ai) installed (`npm install -g opencode`)
- Valid API keys configured in OpenCode for your preferred providers

## Quick Start

```typescript
import { generateText } from "ai";
import { opencode } from "ai-sdk-provider-opencode-sdk";

const result = await generateText({
  model: opencode("anthropic/claude-opus-4-5-20251101"),
  prompt: "What is the capital of France?",
});

console.log(result.text);
```

## Usage

### Creating a Provider

```typescript
import { createOpencode } from "ai-sdk-provider-opencode-sdk";

// Default provider (auto-starts server)
const opencode = createOpencode();

// With custom settings
const opencode = createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  autoStartServer: true,
  serverTimeout: 10000,
  defaultSettings: {
    agent: "build",
    sessionTitle: "My Session",
  },
});
```

### Model Selection

Models are specified in `providerID/modelID` format:

```typescript
// Anthropic models (Claude 4.5 series)
opencode("anthropic/claude-sonnet-4-5-20250929");
opencode("anthropic/claude-haiku-4-5-20251001");
opencode("anthropic/claude-opus-4-5-20251101");

// OpenAI models (GPT-5.1 series)
opencode("openai/gpt-5.1");
opencode("openai/gpt-5.1-codex");
opencode("openai/gpt-5.1-codex-mini");
opencode("openai/gpt-5.1-codex-max");

// Google Gemini models
opencode("google/gemini-3-pro-preview");
opencode("google/gemini-2.5-flash");
opencode("google/gemini-2.5-pro");
opencode("google/gemini-2.0-flash");
```

### Streaming

```typescript
import { streamText } from "ai";

const result = streamText({
  model: opencode("anthropic/claude-opus-4-5-20251101"),
  prompt: "Write a haiku about coding.",
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

### Conversation History

```typescript
import { generateText, type ModelMessage } from "ai";

const messages: ModelMessage[] = [
  { role: "user", content: "My name is Alice." },
  { role: "assistant", content: "Hello Alice! How can I help you today?" },
  { role: "user", content: "What is my name?" },
];

const result = await generateText({
  model: opencode("anthropic/claude-opus-4-5-20251101"),
  messages,
});
```

### Agent Selection

OpenCode supports different agents for different tasks:

```typescript
const model = opencode("anthropic/claude-opus-4-5-20251101", {
  agent: "build", // or 'plan', 'general', 'explore'
});
```

### Session Management

Sessions maintain conversation context:

```typescript
const model = opencode("anthropic/claude-opus-4-5-20251101", {
  sessionTitle: "Code Review Session",
});

// First call creates a session
const result1 = await generateText({ model, prompt: "Review this code..." });

// Subsequent calls reuse the same session
const result2 = await generateText({ model, prompt: "What did you find?" });

// Get session ID from metadata
const sessionId = result1.providerMetadata?.opencode?.sessionId;

// Resume a specific session
const resumeModel = opencode("anthropic/claude-opus-4-5-20251101", {
  sessionId: sessionId,
});
```

### Tool Observation

OpenCode executes tools server-side. You can observe tool execution but cannot provide custom implementations:

```typescript
import { streamText } from "ai";

const result = streamText({
  model: opencode("anthropic/claude-opus-4-5-20251101"),
  prompt: "List files in the current directory.",
});

for await (const part of result.fullStream) {
  if (part.type === "tool-call") {
    console.log(`Tool: ${part.toolName}`);
    console.log(`Input: ${JSON.stringify(part.input, null, 2)}`);
  }
  if (part.type === "tool-result") {
    console.log(`Result: ${part.result}`);
  }
}
```

## Feature Support

| Feature                  | Support    | Notes                                               |
| ------------------------ | ---------- | --------------------------------------------------- |
| Text generation          | ✅ Full    | `generateText()`, `streamText()`                    |
| Streaming                | ✅ Full    | Real-time SSE streaming                             |
| Multi-turn conversations | ✅ Full    | Session-based context                               |
| Tool observation         | ✅ Full    | See tool execution                                  |
| Reasoning/thinking       | ✅ Full    | ReasoningPart support                               |
| Model selection          | ✅ Full    | Per-request model                                   |
| Agent selection          | ✅ Full    | build, plan, general, explore                       |
| Abort/cancellation       | ✅ Full    | AbortSignal support                                 |
| Image input (base64)     | ⚠️ Partial | Data URLs only                                      |
| Image input (URL)        | ❌ None    | Not supported                                       |
| Structured output (JSON) | ⚠️ Partial | `Output.object()` / `streamObject()` (prompt-based) |
| Custom tools             | ❌ None    | Server-side only                                    |
| temperature/topP/topK    | ❌ None    | Provider defaults                                   |
| maxTokens                | ❌ None    | Agent config                                        |

## Provider Settings

```typescript
interface OpencodeProviderSettings {
  hostname?: string; // Default: '127.0.0.1'
  port?: number; // Default: 4096
  baseUrl?: string; // Override full URL
  autoStartServer?: boolean; // Default: true
  serverTimeout?: number; // Default: 10000
  defaultSettings?: OpencodeSettings;
}
```

## Model Settings

```typescript
interface OpencodeSettings {
  sessionId?: string; // Resume session
  createNewSession?: boolean; // Force new session
  sessionTitle?: string; // Title for new sessions
  agent?: string; // Agent name
  systemPrompt?: string; // Override system prompt
  tools?: Record<string, boolean>; // Enable/disable tools
  cwd?: string; // Working directory
  logger?: Logger | false; // Logging
  verbose?: boolean; // Debug logging
}
```

## Error Handling

The provider converts OpenCode errors to AI SDK error types:

```typescript
import {
  isAuthenticationError,
  isTimeoutError,
} from "ai-sdk-provider-opencode-sdk";

try {
  const result = await generateText({ model, prompt: "..." });
} catch (error) {
  if (isAuthenticationError(error)) {
    console.error("Check your API keys in OpenCode");
  } else if (isTimeoutError(error)) {
    console.error("Request timed out");
  }
}
```

## Cleanup

Always dispose of the provider when done to stop the managed server:

```typescript
const opencode = createOpencode();

// ... use the provider ...

// Clean up
await opencode.dispose?.();
```

## License

MIT
