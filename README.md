<p align="center">
  <img src="https://img.shields.io/badge/status-beta-orange" alt="beta status">
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/v/ai-sdk-provider-opencode-sdk?color=00A79E" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/unpacked-size/ai-sdk-provider-opencode-sdk?color=00A79E" alt="install size" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/dy/ai-sdk-provider-opencode-sdk.svg?color=00A79E" alt="npm downloads" /></a>
  <a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/badge/node-%3E%3D18-00A79E" alt="Node.js ≥ 18" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/l/ai-sdk-provider-opencode-sdk?color=00A79E" alt="License: MIT" /></a>
</p>

# AI SDK Provider for OpenCode

> **Latest Release**: Version 2.x supports AI SDK v6. For AI SDK v5 support, use the `ai-sdk-v5` tag (0.x.x).

A community provider for the [Vercel AI SDK](https://sdk.vercel.ai/docs) that enables using AI models through [OpenCode](https://opencode.ai) and the `@opencode-ai/sdk/v2` APIs. OpenCode is a terminal-based AI coding assistant that supports multiple providers (Anthropic, OpenAI, Google, and more).

This provider enables you to use OpenCode's AI capabilities through the familiar Vercel AI SDK interface, supporting `generateText()`, `streamText()`, `streamObject()`, native JSON-schema structured output with practical fallback patterns, tool approval flows, and file/source streaming parts.

## Version Compatibility

| Provider Version | AI SDK Version | NPM Tag     | Status      | Branch                                                                                   |
| ---------------- | -------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| 2.x.x            | v6             | `latest`    | Stable      | `main`                                                                                   |
| 1.x.x            | v6             | N/A         | Legacy      | historical                                                                               |
| 0.x.x            | v5             | `ai-sdk-v5` | Maintenance | [`ai-sdk-v5`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/ai-sdk-v5) |

## Breaking Changes in 2.0.0

This release upgrades the provider internals to OpenCode SDK v2 and includes behavior changes that can affect existing integrations:

- OpenCode request/response routing now uses v2 parameter shapes (`sessionID`, top-level args).
- New settings are available: `permission`, `variant`, `directory`, `outputFormatRetryCount`.
- `cwd` and `tools` remain supported but are now legacy/deprecated pathways.
- Structured output uses OpenCode native `json_schema` mode. Depending on model/backend route, strict object generation can still be inconsistent.

For production object extraction, use a two-step pattern: try `Output.object(...)` first, then fallback to strict JSON prompting + parse/validate.

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
  model: opencode("openai/gpt-5.3-codex-spark"),
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

// OpenAI models (GPT-5.3 / GPT-5.1 series)
opencode("openai/gpt-5.3-codex-spark");
opencode("openai/gpt-5.1");
opencode("openai/gpt-5.1-codex");

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
  model: opencode("openai/gpt-5.3-codex-spark"),
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
  model: opencode("openai/gpt-5.3-codex-spark"),
  messages,
});
```

### Agent Selection

OpenCode supports different agents for different tasks:

```typescript
const model = opencode("openai/gpt-5.3-codex-spark", {
  agent: "build", // or 'plan', 'general', 'explore'
});
```

### Session Management

Sessions maintain conversation context:

```typescript
const model = opencode("openai/gpt-5.3-codex-spark", {
  sessionTitle: "Code Review Session",
});

// First call creates a session
const result1 = await generateText({ model, prompt: "Review this code..." });

// Subsequent calls reuse the same session
const result2 = await generateText({ model, prompt: "What did you find?" });

// Get session ID from metadata
const sessionId = result1.providerMetadata?.opencode?.sessionId;

// Resume a specific session
const resumeModel = opencode("openai/gpt-5.3-codex-spark", {
  sessionId: sessionId,
});
```

### Tool Observation

OpenCode executes tools server-side. You can observe tool execution but cannot provide custom implementations:

```typescript
import { streamText } from "ai";

const result = streamText({
  model: opencode("openai/gpt-5.3-codex-spark"),
  prompt: "List files in the current directory.",
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case "tool-call":
      console.log(`tool-call: ${part.toolName}`);
      break;
    case "tool-result":
      console.log(`tool-result: ${part.toolName}`);
      break;
    case "tool-approval-request":
      console.log(`approval-request: ${part.approvalId}`);
      break;
    case "file":
      console.log(`file: ${part.file.mediaType}`);
      break;
    case "source":
      console.log(`source: ${part.sourceType}`);
      break;
    case "text-delta":
      process.stdout.write(part.text ?? "");
      break;
    case "finish":
      console.log(`finish: ${part.finishReason}`);
      break;
    case "error":
      console.error(part.error);
      break;
  }
}
```

## Feature Support

| Feature                  | Support    | Notes                                                                       |
| ------------------------ | ---------- | --------------------------------------------------------------------------- |
| Text generation          | ✅ Full    | `generateText()`, `streamText()`                                            |
| Streaming                | ✅ Full    | Real-time SSE streaming                                                     |
| Multi-turn conversations | ✅ Full    | Session-based context                                                       |
| Tool observation         | ✅ Full    | See tool execution                                                          |
| Reasoning/thinking       | ✅ Full    | ReasoningPart support                                                       |
| Model selection          | ✅ Full    | Per-request model                                                           |
| Agent selection          | ✅ Full    | build, plan, general, explore                                               |
| Abort/cancellation       | ✅ Full    | AbortSignal support                                                         |
| Image input (base64)     | ⚠️ Partial | Data URLs only                                                              |
| Image input (URL)        | ❌ None    | Not supported                                                               |
| Structured output (JSON) | ⚠️ Partial | Native `json_schema`; use prompt+validation fallback for strict reliability |
| Custom tools             | ❌ None    | Server-side only                                                            |
| Tool approvals           | ✅ Full    | `tool-approval-request` / `tool-approval-response`                          |
| File/source streaming    | ✅ Full    | Emits `file` and `source` stream parts                                      |
| temperature/topP/topK    | ❌ None    | Provider defaults                                                           |
| maxTokens                | ❌ None    | Agent config                                                                |

## Examples

- `examples/basic-usage.ts` - Minimal text generation.
- `examples/streaming.ts` - Streaming text chunks and final usage.
- `examples/conversation-history.ts` - Multi-turn prompts with session continuity.
- `examples/generate-object.ts` - Native object mode with robust JSON fallback.
- `examples/stream-object.ts` - Streaming structured output with fallback parsing.
- `examples/tool-observation.ts` - Observe tool calls, results, approvals, files, and sources.
- `examples/abort-signal.ts` - Cancellation patterns for generate and stream calls.
- `examples/image-input.ts` - File/image input using base64 or data URLs.
- `examples/custom-config.ts` - Provider/model configuration and reliability controls.
- `examples/limitations.ts` - Practical limitations and expected behaviors.
- `examples/long-running-tasks.ts` - Patterns for longer tasks and retries.

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
  tools?: Record<string, boolean>; // Enable/disable tools (deprecated in favor of permissions)
  permission?: Array<{
    permission: string;
    pattern: string;
    action: "allow" | "deny" | "ask";
  }>; // Session ruleset
  variant?: string; // OpenCode variant
  directory?: string; // Per-request directory
  cwd?: string; // Legacy working directory alias
  outputFormatRetryCount?: number; // JSON schema retry count
  logger?: Logger | false; // Logging
  verbose?: boolean; // Debug logging
}
```

## Advanced Exports

The package also exports lower-level APIs for advanced integrations:

- Runtime classes: `OpencodeLanguageModel`, `OpencodeClientManager`
- Validation/config helpers: `validateSettings`, `validateProviderSettings`, `validateModelId`, `mergeSettings`
- Logging helpers: `getLogger`, `defaultLogger`, `silentLogger`, `createContextLogger`
- Event/message utilities: `convertToOpencodeMessages`, `convertEventToStreamParts`, `createStreamState`, `createFinishParts`

These are intended for power users and tooling integrations. Most applications should use `createOpencode()` / `opencode()` directly.

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

## Structured Output Reliability

When using `Output.object(...)`, the provider sends OpenCode native `format: { type: "json_schema", schema }`. This is the preferred path and works in many cases.

Some model/backend routes can still return output that does not parse into a strict object every time. The examples `examples/generate-object.ts` and `examples/stream-object.ts` intentionally demonstrate a robust fallback strategy:

1. Try native structured output.
2. Retry a small number of times.
3. Fallback to strict JSON prompting and validate with Zod.

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
