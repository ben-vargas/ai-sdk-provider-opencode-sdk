# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.5] - 2026-06-11

### Added

- **Exported `createEmptyResponseDataError`** - New error factory alongside the existing `createAPICallError` / `createTimeoutError` exports.

### Fixed

- **CJS type declarations (FalseESM)** - Split the `exports["."]` conditions so `require` resolves the CommonJS declarations (`./dist/index.d.cts`) that the build already emitted, instead of the ESM `./dist/index.d.ts`. Previously, TypeScript consumers using `require()` under `node16`/`nodenext` module resolution got a "Masquerading as ESM" error from `@arethetypeswrong/cli`; both `publint` and `attw --pack` are now clean across all resolution modes.
- **Empty response data errors** - Prompt calls that succeed but return no response data (the behavior of opencode CLI 1.17.x for invalid or unavailable `provider/model` IDs, e.g. the `github-copilot/gpt-5` repro from [#21](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/issues/21)) now throw an actionable `APICallError` that names the requested model ID, suggests checking `opencode models`, includes the server error payload when available, and carries `errorType: "EmptyResponseData"` — replacing the generic `No response data from OpenCode`. The streaming path surfaces the same error as an `error` stream part and terminates the stream instead of hanging on the event subscription.
- **`wrapError` double-wrapping** - `wrapError` now returns already-wrapped AI SDK errors (`APICallError`, `LoadAPIKeyError`) unchanged instead of re-wrapping them and losing their metadata.
- **Singleton client manager recovery after dispose** - `OpencodeClientManager.dispose()` now releases the singleton slot when the disposed manager is the singleton, so a later `createOpencode()` builds a fresh client manager. Previously the singleton kept pointing at the disposed instance, and every subsequent provider in the same process failed with `Client manager has been disposed`.
- **client-options example** - Step 2 of `examples/client-options.ts` now genuinely demonstrates the preconfigured-client pattern by passing an isolated manager via `clientManager: OpencodeClientManager.createInstance({ client })`. Previously the preconfigured client was handed to the singleton that step 1 had already initialized, so it was ignored and step 2's requests flowed through step 1's client while the demo reported success. The example now also echoes each outgoing request's `x-demo-source` header so the output proves which client served it, drops a spurious `await` on the synchronous v2 `createOpencodeClient()`, and allows overriding the example model via `OPENCODE_MODEL`.

### Changed

- **Clearer stale-options warnings** - The client manager's "already initialized" warnings now point at the escape hatches that actually work (`OpencodeClientManager.createInstance()` with the `clientManager` provider setting, or `OpencodeClientManager.resetInstance()`) instead of the previous generic advice.
- **`clientOptions.responseStyle` normalization** - Managed clients are now always created with fields-style SDK results; `clientOptions.responseStyle: "data"` is ignored with a warning since the provider's response handling requires `{ data, error }` results. Session-creation and prompt result handling also tolerate data-style results from caller-supplied (preconfigured) clients.

## [3.0.4] - 2026-06-11

### Fixed

- **Empty OpenCode response errors** - Empty-body JSON parse failures from the OpenCode server (`SyntaxError: Unexpected end of JSON input`, most commonly caused by an invalid or unavailable `provider/model` ID) are now wrapped in an actionable `APICallError` that names the requested model ID and likely cause. The same wrapping is applied to the streaming prompt failure path, and `modelId` is now included in API call error metadata. (Fixes [#21](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/issues/21), PR [#24](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/pull/24) by [@slegarraga](https://github.com/slegarraga))
- **image-input example** - Updated `examples/image-input.ts` to use `openai/gpt-5.5` instead of the no-longer-available `openai/gpt-5.3-codex`, which caused the example to fail silently (empty response, zero usage).

## [3.0.3] - 2026-06-09

### Fixed

- **Tool approval ordering** - Buffered OpenCode `permission.asked` events until the correlated tool call is registered, preventing AI SDK `ToolCallNotFoundForApprovalError` failures for provider-executed tools that require approval. Also treats early approval registration as closing the tool-input envelope so stale post-registration `running` updates cannot emit late `tool-input-delta` chunks. (Fixes [#22](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/issues/22), PR [#23](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/pull/23) by [@JulieLorin](https://github.com/JulieLorin))

## [3.0.2] - 2026-04-12

### Added

- **Structured output support** - OpenCode's `StructuredOutput` tool input is now re-emitted as text content so the AI SDK's `Output.object()` / `Output.array()` can parse `step.text` correctly. Previously this always threw `NoObjectGeneratedError`. (PR [#16](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/pull/16) by [@abhijit-hota](https://github.com/abhijit-hota))
- **Exported `STRUCTURED_OUTPUT_TOOL` constant** - Shared constant for the `"StructuredOutput"` tool name.

## [3.0.1] - 2026-03-24

### Added

- **User message ID passthrough** - Added support for `providerOptions.opencode.messageID` to control the user message ID sent to OpenCode. Must start with `"msg_"`. (PR [#14](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/pull/14) by [@abhijit-hota](https://github.com/abhijit-hota))
- **Exported `OpencodeProviderOptions` type** - New type in `src/types.ts` documenting the per-request provider options surface.

### Fixed

- **Session creation error messages** - `Failed to create session` now includes the server error payload for easier debugging.

## [3.0.0] - 2026-03-17

### Changed

- **Breaking: multi-slash model ID parsing now matches OpenCode upstream** - Model IDs containing multiple `/` separators now use the first segment as `providerID` and preserve the remaining path as `modelID` (for example, `litellm/anthropic/claude-sonnet-4-6` now resolves to `providerID: "litellm"` and `modelID: "anthropic/claude-sonnet-4-6"`). This changes behavior for integrations that relied on the previous last-segment parsing, so the release is being published as `3.0.0` to avoid silently breaking consumers pinned to `^2.x`.

## [2.1.2] - 2026-03-02

### Fixed

- **Streaming delta handling** - Added support for `message.part.delta` events to enable true incremental text and reasoning streaming instead of batch delivery via `message.part.updated` only. (PR [#9](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/pull/9) by [@abhijit-hota](https://github.com/abhijit-hota))
- **User-message filtering for deltas** - Applied user-role guard to `handlePartDelta` to prevent user prompt text from leaking into assistant stream output, matching existing filtering in `handlePartUpdated`.

### Changed

- **Dependencies** - Bumped `@opencode-ai/sdk` from `^1.1.65` to `^1.2.15`.

## [2.1.1] - 2026-02-19

### Added

- **Isolated client manager instances** - Added `OpencodeClientManager.createInstance()` for creating standalone (non-singleton) client managers, enabling concurrent sessions pointing at different servers.
- **Client manager injection** - Added `clientManager` option on `OpencodeProviderSettings` to use a custom client manager instead of the shared singleton.
- **Validation for conflicting options** - Added warning when both `clientManager` and `client` are provided.

### Changed

- **OpencodeClient type** - Aligned `OpencodeClient` type alias to the SDK-exported `OpencodeClient` type directly instead of inferring from `createOpencodeClient` return type.

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
