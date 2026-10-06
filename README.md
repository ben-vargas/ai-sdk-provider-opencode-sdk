<p align="center">
  <img src="https://img.shields.io/badge/status-maintenance-lightgrey" alt="maintenance status">
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/v/ai-sdk-provider-opencode-sdk?color=00A79E" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/unpacked-size/ai-sdk-provider-opencode-sdk?color=00A79E" alt="install size" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/dy/ai-sdk-provider-opencode-sdk.svg?color=00A79E" alt="npm downloads" /></a>
  <a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/badge/node-%3E%3D22-00A79E" alt="Node.js ≥ 22" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/l/ai-sdk-provider-opencode-sdk?color=00A79E" alt="License: MIT" /></a>
</p>

# AI SDK Provider for OpenCode

> **This is the 4.x line, for OpenCode 1.x servers (maintenance).** Running OpenCode 2.x? Use 5.x instead: `npm install ai-sdk-provider-opencode-sdk`. Not sure which you have? See [Which version do I need?](#which-version-do-i-need)

A community provider for the [Vercel AI SDK](https://sdk.vercel.ai/docs) (v7) that enables using AI models through an [OpenCode](https://opencode.ai) **1.x** server via `@opencode-ai/sdk` (its `/v2` API entrypoint — an SDK API version, not OpenCode 2.x). OpenCode is a terminal-based AI coding assistant that supports multiple providers (Anthropic, OpenAI, Google, and more).

This provider enables you to use OpenCode's AI capabilities through the familiar Vercel AI SDK interface, supporting `generateText()`, `streamText()`, `streamObject()`, native JSON-schema structured output with practical fallback patterns, tool approval flows, and file/source streaming parts.

## Which version do I need?

Two things decide it: your **AI SDK** major version and your **OpenCode server** major version.

|               | OpenCode 2.x                               | OpenCode 1.x                                                  |
| ------------- | ------------------------------------------ | ------------------------------------------------------------- |
| **AI SDK v7** | 5.x — `npm i ai-sdk-provider-opencode-sdk` | **4.x** — `npm i ai-sdk-provider-opencode-sdk@opencode-v1`    |
| **AI SDK v6** | not supported                              | 3.x (legacy) — `npm i ai-sdk-provider-opencode-sdk@ai-sdk-v6` |
| **AI SDK v5** | not supported                              | 0.x (legacy) — `npm i ai-sdk-provider-opencode-sdk@ai-sdk-v5` |

**Which OpenCode do I have?** `opencode --version` prints a bare `1.x.y` on OpenCode 1 and `opencode v2.x.y` on OpenCode 2. The npm package **`opencode-ai` is OpenCode 1.x**; OpenCode 2.x is published as **`@opencode/cli`**.

## Version Compatibility

| Provider | AI SDK | OpenCode server                              | npm tag       | Branch                                                                                       | Status      |
| -------- | ------ | -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- | ----------- |
| 5.x      | v7     | 2.x (`@opencode/cli`; tested against 2.0.24) | `latest`      | [`main`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk)                         | Active      |
| 4.x      | v7     | 1.x (`opencode-ai`)                          | `opencode-v1` | [`opencode-v1`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/opencode-v1) | Maintenance |
| 3.x      | v6     | 1.x                                          | `ai-sdk-v6`   | [`ai-sdk-v6`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/ai-sdk-v6)     | Legacy      |
| 2.x, 1.x | v6     | 1.x                                          | —             | historical                                                                                   | Legacy      |
| 0.x      | v5     | 1.x                                          | `ai-sdk-v5`   | [`ai-sdk-v5`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/ai-sdk-v5)     | Legacy      |

**Maintenance** lines get bug fixes; **Legacy** lines stay installable but receive no further releases.

## Breaking Changes in 4.0.0

This release upgrades the provider to AI SDK v7 and the V4 provider interfaces:

- **Node.js >= 22**: The package now requires **Node.js >= 22**.
- **File data parts**: Per AI SDK v7, `reference` file input parts are unsupported and skipped with a warning.
- **`reasoning` call option**: The `reasoning` model call option is unsupported; it logs a warning and is ignored.
- **`reasoning-file` parts**: Explicitly a no-op for output conversion (logged at debug level).

## Breaking Changes in 2.0.0

This release upgrades the provider internals to OpenCode SDK v2 and includes behavior changes that can affect existing integrations:

- OpenCode request/response routing now uses v2 parameter shapes (`sessionID`, top-level args).
- New settings are available: `permission`, `variant`, `directory`, `outputFormatRetryCount`.
- `cwd` and `tools` remain supported but are now legacy/deprecated pathways.
- Structured output uses OpenCode native `json_schema` mode. Depending on model/backend route, strict object generation can still be inconsistent.

For production object extraction, use a two-step pattern: try `Output.object(...)` first, then fallback to strict JSON prompting + parse/validate.

### Installing the Right Version

**For AI SDK v7 + OpenCode 1.x (this line):**

```bash
npm install ai-sdk-provider-opencode-sdk@opencode-v1 ai@^7.0.0
```

**For AI SDK v7 + OpenCode 2.x:** use 5.x (`npm install ai-sdk-provider-opencode-sdk ai@^7.0.0`) and its README.

**For AI SDK v6 (legacy, OpenCode 1.x):**

```bash
npm install ai-sdk-provider-opencode-sdk@ai-sdk-v6 ai@^6.0.0
```

**For AI SDK v5 (legacy, OpenCode 1.x):**

```bash
npm install ai-sdk-provider-opencode-sdk@ai-sdk-v5 ai@^5.0.0
```

## Zod Compatibility

This package is compatible with **Zod 3 and Zod 4** (aligned with `ai`):

```bash
# With Zod 3 (4.x line, OpenCode 1.x)
npm install ai-sdk-provider-opencode-sdk@opencode-v1 ai zod@^3.25.76

# With Zod 4 (4.x line, OpenCode 1.x)
npm install ai-sdk-provider-opencode-sdk@opencode-v1 ai zod@^4.1.8
```

## Prerequisites

- Node.js >= 22
- [OpenCode CLI](https://opencode.ai) installed (OpenCode **1.x**: `npm install -g opencode-ai`)
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
const sessionId = result1.finalStep.providerMetadata?.opencode?.sessionId;

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

for await (const part of result.stream) {
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

### Interactive Questions

OpenCode's question tool can ask the user to pick between options mid-generation (a `question.asked` event). The session blocks server-side until the question is answered or rejected. Provide an `onQuestion` callback to answer questions programmatically:

```typescript
const model = opencode("openai/gpt-5.3-codex-spark", {
  onQuestion: (request) => {
    // request.questions: [{ header, question, options: [{ label, description }], multiple?, custom? }]
    return {
      type: "answer",
      // One string[] per question; multiple selections -> multiple strings.
      answers: request.questions.map((q) => [q.options[0]?.label ?? ""]),
    };
  },
});
```

Return `{ type: "reject" }` to decline a question. If the callback throws, the provider logs a warning and rejects the question so generation can continue.

Without a handler, behavior is controlled by `questionPolicy`:

- `"reject"` (default) - the provider rejects the question (`question.reject`) so the session unblocks. Previously the provider emitted a stream error and generation hung until the question was answered in OpenCode directly.
- `"wait"` - legacy behavior: the provider emits a stream `error` part and waits for the question to be answered externally (e.g. in the OpenCode TUI).

Both `streamText` and `generateText` handle questions; the non-streaming path watches for `question.asked` events on a temporary event subscription while the prompt is in flight. See `examples/question-handling.ts` for a full example.

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
| Interactive questions    | ✅ Full    | `onQuestion` callback; questions without a handler rejected by default      |
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
- `examples/question-handling.ts` - Answer OpenCode's interactive questions with `onQuestion`.
- `examples/abort-signal.ts` - Cancellation patterns for generate and stream calls.
- `examples/image-input.ts` - File/image input using base64 or data URLs.
- `examples/custom-config.ts` - Provider/model configuration and reliability controls.
- `examples/client-options.ts` - `clientOptions` passthrough and preconfigured `client` patterns.
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
  clientOptions?: OpencodeClientOptions; // Pass-through to createOpencodeClient()
  client?: OpencodeClient; // Preconfigured SDK client (bypasses server management)
  defaultSettings?: OpencodeSettings;
}
```

`clientOptions` forwards OpenCode SDK client configuration such as:

- `headers` (custom HTTP headers)
- `fetch` (custom fetch implementation)
- `auth` (token or auth function)
- `bodySerializer` / `querySerializer`
- `requestValidator` / `responseValidator` / `responseTransformer`
- `throwOnError`
- standard `RequestInit` fields (`credentials`, `mode`, `cache`, `signal`, etc.)

Notes:

- `baseUrl` and `directory` remain provider/model managed (`baseUrl` at provider level, `directory` via `defaultSettings` or per-model settings).
- If both `client` and `clientOptions` are provided, `client` takes precedence.
- If `client` is provided, its lifecycle remains caller-managed; `dispose()` only cleans up provider-managed server processes.

Example:

```typescript
const opencode = createOpencode({
  baseUrl: "http://127.0.0.1:4096",
  clientOptions: {
    headers: {
      "x-api-key": process.env.OPENCODE_API_KEY ?? "",
    },
    credentials: "include",
    throwOnError: true,
  },
});
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
  onQuestion?: (
    request: OpencodeQuestionRequest,
  ) => Promise<OpencodeQuestionResponse> | OpencodeQuestionResponse; // Answer interactive questions
  questionPolicy?: "reject" | "wait"; // Questions with no handler (default: "reject")
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

The provider never touches how your process handles signals. Importing it installs no process listeners; only when it spawns a server does it add a single `exit` listener, to stop that server when the process exits (normal exit, `process.exit()` or an uncaught exception). A process killed by a signal skips `exit`: Ctrl+C in a terminal reaches the server too, but a signal sent only to your process (e.g. `kill <pid>`) can leave the server running — if that matters, handle the signal and call `dispose()`:

```typescript
process.once("SIGTERM", async () => {
  await opencode.dispose?.();
  process.exit(0);
});
```

## License

MIT
