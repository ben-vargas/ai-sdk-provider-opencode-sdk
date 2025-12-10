# ai-sdk-provider-opencode-sdk

AI SDK v5 provider for [OpenCode](https://opencode.ai) via the `@opencode-ai/sdk`.

This provider enables you to use OpenCode's AI capabilities through the familiar Vercel AI SDK interface, supporting `generateText()`, `streamText()`, `generateObject()`, and `streamObject()`.

## Installation

```bash
npm install ai-sdk-provider-opencode-sdk
```

## Prerequisites

- Node.js >= 18
- [OpenCode CLI](https://opencode.ai) installed (`npm install -g opencode`)
- Valid API keys configured in OpenCode for your preferred providers

## Quick Start

```typescript
import { generateText } from 'ai';
import { opencode } from 'ai-sdk-provider-opencode-sdk';

const result = await generateText({
  model: opencode('anthropic/claude-opus-4-5-20251101'),
  prompt: 'What is the capital of France?',
});

console.log(result.text);
```

## Usage

### Creating a Provider

```typescript
import { createOpencode } from 'ai-sdk-provider-opencode-sdk';

// Default provider (auto-starts server)
const opencode = createOpencode();

// With custom settings
const opencode = createOpencode({
  hostname: '127.0.0.1',
  port: 4096,
  autoStartServer: true,
  serverTimeout: 10000,
  defaultSettings: {
    agent: 'build',
    sessionTitle: 'My Session',
  },
});
```

### Model Selection

Models are specified in `providerID/modelID` format:

```typescript
// Anthropic models (Claude 4.5 series)
opencode('anthropic/claude-sonnet-4-5-20250929')
opencode('anthropic/claude-haiku-4-5-20251001')
opencode('anthropic/claude-opus-4-5-20251101')

// OpenAI models
opencode('openai/gpt-4o')
opencode('openai/gpt-4o-mini')

// Google Gemini models
opencode('google/gemini-3-pro-preview')
opencode('google/gemini-2.5-flash')
opencode('google/gemini-2.5-pro')
opencode('google/gemini-2.0-flash')
```

### Streaming

```typescript
import { streamText } from 'ai';

const result = streamText({
  model: opencode('anthropic/claude-opus-4-5-20251101'),
  prompt: 'Write a haiku about coding.',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

### Conversation History

```typescript
import { generateText, type CoreMessage } from 'ai';

const messages: CoreMessage[] = [
  { role: 'user', content: 'My name is Alice.' },
  { role: 'assistant', content: 'Hello Alice! How can I help you today?' },
  { role: 'user', content: 'What is my name?' },
];

const result = await generateText({
  model: opencode('anthropic/claude-opus-4-5-20251101'),
  messages,
});
```

### Agent Selection

OpenCode supports different agents for different tasks:

```typescript
const model = opencode('anthropic/claude-opus-4-5-20251101', {
  agent: 'build',  // or 'plan', 'general', 'explore'
});
```

### Session Management

Sessions maintain conversation context:

```typescript
const model = opencode('anthropic/claude-opus-4-5-20251101', {
  sessionTitle: 'Code Review Session',
});

// First call creates a session
const result1 = await generateText({ model, prompt: 'Review this code...' });

// Subsequent calls reuse the same session
const result2 = await generateText({ model, prompt: 'What did you find?' });

// Get session ID from metadata
const sessionId = result1.providerMetadata?.opencode?.sessionId;

// Resume a specific session
const resumeModel = opencode('anthropic/claude-opus-4-5-20251101', {
  sessionId: sessionId,
});
```

### Tool Observation

OpenCode executes tools server-side. You can observe tool execution but cannot provide custom implementations:

```typescript
import { streamText } from 'ai';

const result = streamText({
  model: opencode('anthropic/claude-opus-4-5-20251101'),
  prompt: 'List files in the current directory.',
});

for await (const part of result.fullStream) {
  if (part.type === 'tool-call') {
    console.log(`Tool: ${part.toolName}`);
    console.log(`Input: ${part.args}`);
  }
  if (part.type === 'tool-result') {
    console.log(`Result: ${part.result}`);
  }
}
```

## Feature Support

| Feature | Support | Notes |
|---------|---------|-------|
| Text generation | ✅ Full | `generateText()`, `streamText()` |
| Streaming | ✅ Full | Real-time SSE streaming |
| Multi-turn conversations | ✅ Full | Session-based context |
| Tool observation | ✅ Full | See tool execution |
| Reasoning/thinking | ✅ Full | ReasoningPart support |
| Model selection | ✅ Full | Per-request model |
| Agent selection | ✅ Full | build, plan, general, explore |
| Abort/cancellation | ✅ Full | AbortSignal support |
| Image input (base64) | ⚠️ Partial | Data URLs only |
| Image input (URL) | ❌ None | Not supported |
| JSON mode | ⚠️ Partial | Prompt-based |
| Custom tools | ❌ None | Server-side only |
| temperature/topP/topK | ❌ None | Provider defaults |
| maxTokens | ❌ None | Agent config |

## Provider Settings

```typescript
interface OpencodeProviderSettings {
  hostname?: string;        // Default: '127.0.0.1'
  port?: number;            // Default: 4096
  baseUrl?: string;         // Override full URL
  autoStartServer?: boolean; // Default: true
  serverTimeout?: number;   // Default: 10000
  defaultSettings?: OpencodeSettings;
}
```

## Model Settings

```typescript
interface OpencodeSettings {
  sessionId?: string;       // Resume session
  createNewSession?: boolean; // Force new session
  sessionTitle?: string;    // Title for new sessions
  agent?: string;           // Agent name
  systemPrompt?: string;    // Override system prompt
  tools?: Record<string, boolean>; // Enable/disable tools
  cwd?: string;             // Working directory
  logger?: Logger | false;  // Logging
  verbose?: boolean;        // Debug logging
}
```

## Error Handling

The provider converts OpenCode errors to AI SDK error types:

```typescript
import { isAuthenticationError, isTimeoutError } from 'ai-sdk-provider-opencode-sdk';

try {
  const result = await generateText({ model, prompt: '...' });
} catch (error) {
  if (isAuthenticationError(error)) {
    console.error('Check your API keys in OpenCode');
  } else if (isTimeoutError(error)) {
    console.error('Request timed out');
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
