# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- No changes yet.

## [2.1.0] - 2026-02-18

### Added

- **SDK client passthrough options** - Added `clientOptions` on `OpencodeProviderSettings` to forward OpenCode `createOpencodeClient()` configuration (headers, auth, fetch, serializers, validators, transformers, throwOnError, and RequestInit-compatible options).
- **Preconfigured client support** - Added `client` on `OpencodeProviderSettings` to use a prebuilt OpenCode SDK client directly.
- **Client configuration example** - Added `examples/client-options.ts` showing `clientOptions` passthrough and preconfigured `client` usage patterns.

### Changed

- **Client initialization behavior** - `clientOptions` are now applied consistently across external `baseUrl`, existing-server, and auto-started-server client creation paths.
- **Conflict handling** - Reserved `baseUrl` and `directory` values in `clientOptions` are ignored with warnings; `client` takes precedence over `clientOptions`.

## [2.0.0] - 2026-02-13

- **Breaking release** - OpenCode SDK v2 migration and AI SDK v6 hardening.

### Changed

- **OpenCode SDK v2 cutover** - Migrated runtime client/server integration to `@opencode-ai/sdk/v2`.
- **Request shape updates** - Updated session APIs to v2 parameter style (`sessionID`, top-level args) instead of legacy `path/body`.
- **Structured output** - Mapped AI SDK JSON response format to OpenCode native `format: { type: \"json_schema\", schema }`.
- **Dependencies** - Bumped to latest stable compatible versions:
  - `@opencode-ai/sdk` -> `^1.1.65`
  - `@ai-sdk/provider` -> `^3.0.8`
  - `@ai-sdk/provider-utils` -> `^4.0.15`
  - `ai` (dev) -> `^6.0.85`

### Added

- **Permission/approval flow** - Added support for OpenCode permission events as AI SDK `tool-approval-request` stream parts.
- **Approval response handling** - Applied `tool-approval-response` prompt parts through OpenCode `permission.reply()` before sending prompts.
- **New model settings** - Added `permission`, `variant`, `directory`, and `outputFormatRetryCount` settings.
- **File/source streaming output** - Added conversion for OpenCode file parts and source metadata into AI SDK `file` / `source` stream/content parts.
- **Provider lifecycle cleanup API** - Added provider `dispose()` method for managed server/client cleanup.
- **Event typing exports** - Added `EventQuestionAsked` export for SDK v2 question events.
- **Approval metadata** - Added `approvalRequestId` in provider metadata for approval request correlation.

### Fixed

- **Finish reason mapping** - Added `ContextOverflowError` and `StructuredOutputError` handling in finish-reason conversion.
- **Output-length detection** - Treated `ContextOverflowError` as output-length overflow for AI SDK error utilities.

## [1.0.0] - 2026-01-01

### Changed

- **AI SDK v6 migration** - Updated to Language Model Specification V3 (LanguageModelV3 / ProviderV3).
- **Usage/finish metadata** - Nested V3 usage shape and unified finish reasons with raw provider values.
- **Streaming updates** - V3 stream parts and warnings with SharedV3Warning format.
- **Dependencies** - Bumped `@ai-sdk/provider` to v3, `@ai-sdk/provider-utils` to v4, and `ai` to v6.

## [0.0.2] - 2025-12-10

### Changed

- **Updated dependencies** - Bumped to latest compatible versions:
  - `@ai-sdk/provider-utils`: 3.0.9 → 3.0.18
  - `@opencode-ai/sdk`: ^1.0.141 → ^1.0.137 (aligned with stable release)

### Fixed

- **OpenAI model names** - Updated documentation to use current GPT-5.1 series models instead of outdated GPT-4o references

## [0.0.1] - 2025-12-10

### Added

Initial release of the AI SDK Provider for OpenCode.

#### Core Features

- **LanguageModelV2 implementation** - Full AI SDK v5 provider interface
- **Text generation** - `generateText()` support with non-streaming responses
- **Streaming** - `streamText()` with real-time SSE event streaming
- **Object generation** - `generateObject()` with Zod schema validation (prompt-based JSON mode)
- **Object streaming** - `streamObject()` with incremental partial object updates

#### Provider Configuration

- **Auto-start server** - Automatically starts OpenCode server if not running
- **Custom server settings** - Configure hostname, port, baseUrl, serverTimeout
- **Default settings** - Apply default settings to all model instances

#### Model Settings

- **Session management** - Create, resume, and manage conversation sessions
- **Agent selection** - Choose from `build`, `plan`, `general`, `explore` agents
- **System prompts** - Override default system prompts per request
- **Tool configuration** - Enable/disable specific server-side tools
- **Working directory** - Set `cwd` for file operations
- **Logging** - Custom logger support with verbose mode

#### Streaming Features

- **Text streaming** - Real-time text delta delivery
- **Tool observation** - Observe server-side tool execution (Read, Write, Bash, etc.)
- **Tool state tracking** - Track pending → running → completed/error states
- **Usage tracking** - Token usage extracted from step-finish events
- **Finish reason mapping** - Proper finish reason (stop, length, tool-calls, error)

#### Multi-Provider Support

- **Anthropic models** - Claude 4.5 series (opus, sonnet, haiku)
- **OpenAI models** - GPT-5.1 series (gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1-codex-max)
- **Google models** - Gemini 2.0/2.5/3.0 series
- Model ID format: `providerID/modelID` (e.g., `anthropic/claude-opus-4-5-20251101`)

#### Image Input Support

- **Base64/Data URL images** - Vision-capable models can process local images
- Supported formats: PNG, JPEG, GIF, WebP
- Note: Remote image URLs are not supported

#### Abort Signal Support

- **Request cancellation** - Cancel in-progress requests via AbortController
- **Pre-abort detection** - Immediately reject pre-aborted signals
- **Streaming abort** - Cancel streaming requests mid-generation
- **Server-side abort** - Calls `session.abort()` to cleanly terminate server processing

#### Error Handling

- **Typed errors** - Authentication, timeout, and API errors
- **Error utilities** - `isAuthenticationError()`, `isTimeoutError()`, etc.
- **Graceful recovery** - Proper error propagation to AI SDK

#### Examples

- `basic-usage.ts` - Simple text generation
- `streaming.ts` - Real-time streaming with usage tracking
- `conversation-history.ts` - Multi-turn conversations
- `generate-object.ts` - Structured output with various schema patterns
- `stream-object.ts` - Streaming object generation with progress tracking
- `tool-observation.ts` - Observing server-side tool execution
- `image-input.ts` - Processing images with vision models
- `abort-signal.ts` - Request cancellation patterns
- `custom-config.ts` - Provider and model configuration
- `limitations.ts` - Documenting unsupported features
- `long-running-tasks.ts` - Timeout and retry patterns

#### Testing

- **269 unit tests** - Comprehensive test coverage
- Tests for: message conversion, event streaming, error handling, validation, logging

### Known Limitations

The following AI SDK parameters are **not supported** (silently ignored):

- `temperature`, `topP`, `topK` - Sampling parameters
- `maxOutputTokens` - Output length limits
- `presencePenalty`, `frequencyPenalty` - Repetition penalties
- `stopSequences` - Custom stop sequences
- `seed` - Deterministic output

Custom tool definitions are ignored - OpenCode executes tools server-side.

### Dependencies

- `@ai-sdk/provider` ^2.0.0
- `@ai-sdk/provider-utils` ^3.0.0
- `@opencode-ai/sdk` ^0.0.21
- `zod` ^3.0.0 || ^4.0.0 (peer dependency)
