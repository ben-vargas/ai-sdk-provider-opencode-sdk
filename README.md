<p align="center">
  <img src="https://img.shields.io/badge/status-beta-orange" alt="beta status">
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/v/ai-sdk-provider-opencode-sdk?color=00A79E" alt="npm version" /></a>
  <a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/badge/node-%3E%3D22-00A79E" alt="Node.js ≥ 22" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/l/ai-sdk-provider-opencode-sdk?color=00A79E" alt="License: MIT" /></a>
</p>

# AI SDK Provider for OpenCode v2

A community provider for the [Vercel AI SDK](https://sdk.vercel.ai/docs) (v7) that runs generations through an [OpenCode](https://opencode.ai) **v2** server via `@opencode-ai/client`. OpenCode is an AI coding agent: it owns the model catalog, executes tools server-side, and manages sessions; this provider maps that onto `generateText()` / `streamText()` with tool observation, two-phase tool approvals, interactive forms, and native usage/cost metadata.

> ## ⚠️ Beta status — read before using
>
> This 5.x line targets the **OpenCode v2 beta contract** and is pinned to `@opencode-ai/client@0.0.0-beta-18286`.
>
> **No published OpenCode binary currently serves this contract.** The dev- and beta-channel CLIs speak an older, incompatible protocol. The only known compatible server is the upstream [`anomalyco/opencode`](https://github.com/anomalyco/opencode) `beta` branch **built from source** (commit `f4a9b93`, matching the pinned client). This repo's integration harness clones, builds, and serves it in an isolated sandbox — see [`integration/harness/beta-server.ts`](integration/harness/beta-server.ts) and the reproduction steps in [`docs/v2-spike-findings.md`](docs/v2-spike-findings.md).
>
> For OpenCode 1.18.x servers (the current published CLI), use the **4.x** line of this package.
>
> Migrating from 4.x? See **[docs/migrating-v4-to-v5.md](docs/migrating-v4-to-v5.md)** — v2 is a new backend, not an SDK bump, and most settings changed.

## Version compatibility

| Provider | AI SDK | OpenCode server             | Status                        |
| -------- | ------ | --------------------------- | ----------------------------- |
| 5.x      | v7     | v2 beta (built from source) | Beta                          |
| 4.x      | v7     | 1.18.x (published CLI)      | Maintenance                   |
| 3.x      | v6     | 1.x                         | Maintenance (`ai-sdk-v6` tag) |

## Requirements

- Node.js >= 22
- An OpenCode v2 server that speaks the beta-18286 contract (see the status banner)
- Credentials configured on that server for the providers you want to use (e.g. OpenCode zen)

```bash
npm install ai-sdk-provider-opencode-sdk@next ai@^7.0.0
```

## Quick start

The v2 beta server requires Basic auth (`opencode:<password>`) on every route:

```typescript
import { generateText } from "ai";
import { createOpencode } from "ai-sdk-provider-opencode-sdk";

const opencode = createOpencode({
  baseUrl: "http://127.0.0.1:14196",
  clientOptions: {
    headers: {
      Authorization:
        "Basic " + Buffer.from("opencode:" + password).toString("base64"),
    },
  },
});

const result = await generateText({
  model: opencode("opencode/nemotron-3.5-lightning-free"),
  prompt: "What is the capital of France?",
});

console.log(result.text);
await opencode.dispose();
```

### Backends

`createOpencode` selects exactly one backend, in precedence order:

1. **`client`** — a caller-supplied `OpenCode.make(...)` client. Used as-is; the provider never closes it.

   ```typescript
   import { OpenCode } from "@opencode-ai/client";
   const client = OpenCode.make({ baseUrl, headers });
   const opencode = createOpencode({ client });
   ```

2. **`clientManager`** — a caller-supplied manager (advanced injection seam; see `createClientManagerFromPort`). Never disposed by the provider.

3. **`baseUrl`** — the provider constructs the client with `clientOptions` (`headers`, `fetch`).

4. **Service discovery** — `Service.discover()` via the local registration file, with the registered endpoint's auth merged automatically. `autoStart: true` additionally spawns via `Service.ensure`. **Caveat:** no published CLI supports `opencode serve --service` yet (only source builds write a registration), so the default is discovery-only (`autoStart: false`), and the zero-config default provider (`import { opencode }`) only works once a registered service exists.

Every backend runs a connection preflight (`health.get` + `migration.v1.status`) on first use.

### Model IDs

Models are `providerID/modelID` strings from your server's catalog (`model.list`); a bare `modelID` omits the model at session create so the server default applies. `OpencodeModels` exports shortcuts for six OpenCode zen free-tier IDs, each cross-checked against both a live beta catalog and the upstream models.dev catalog (they need zen credentials on your server; catalogs are server- and credential-dependent, so any ID your own catalog lists works — the shortcuts are a convenience, not a limit):

```typescript
import { OpencodeModels } from "ai-sdk-provider-opencode-sdk";
opencode(OpencodeModels["big-pickle"]); // "opencode/big-pickle"
```

## Sessions and conversations

OpenCode owns the transcript: model and agent are **session state**, and a prompt sends only new user text. The binding rule is **one model instance = one conversation = one pinned session**:

```typescript
const model = opencode("opencode/big-pickle", { sessionTitle: "My run" });

const r1 = await generateText({ model, prompt: "My name is Alice." });
const r2 = await generateText({ model, prompt: "What is my name?" }); // same session

const sessionId = r1.finalStep.providerMetadata?.opencode?.sessionId;
```

`sessionMode` controls the binding:

- `"ephemeral"` (default) — the provider creates and exclusively owns a session per conversation (it survives tool-approval round-trips within the conversation).
- `"persistent"` — one provider-created session reused across conversations (the v4 implicit default, now opt-in).
- `"existing"` — pin the session given by `sessionId` (implied when `sessionId` is set without a mode). **Shared-session caveat:** the v2 beta has no inbox→execution correlation key, so events from other clients on the same session (e.g. a TUI) can be misattributed to your call. Use exclusively-owned sessions unless you accept that.

Per call, `providerOptions.opencode.sessionId` targets an existing session for that one request, and `providerOptions.opencode.id` sets the prompt's user-message ID:

```typescript
await generateText({
  model,
  prompt: "...",
  providerOptions: { opencode: { sessionId: "ses_..." } },
});
```

Prompts to a busy session use `delivery: "queue"` by default (the provider always sends it explicitly — the _server_ default is `"steer"`, which injects the prompt into the in-flight turn as mid-turn context rather than starting or superseding one).

## Tool observation and approvals

OpenCode executes its own tools server-side. You **cannot** supply tool implementations — AI SDK `tools`/`toolChoice` are ignored with a warning — but tool activity streams through as standard AI SDK parts (`tool-call`, `tool-result`, incremental `tool-input-delta`), and tool-produced files surface as `file`/`source` parts.

When the server's permission config requires approval (e.g. `permission: { bash: "ask" }`), the flow is two-phase:

1. The call finishes with a `tool-approval-request` content part; the session stays pinned on the model instance.
2. Call the **same model instance** again with the prior history plus a `tool-approval-response` part (`{ approvalId, approved }`). The provider sends `permission.reply` and resumes the **original** blocked execution — no new prompt is sent.

Pending/replied approval IDs are reported under `providerMetadata.opencode`. See [`examples/tool-approval.ts`](examples/tool-approval.ts) for the full round-trip.

## Interactive forms (`onForm`)

Forms are v2's replacement for v1 questions: typed, keyed fields answered with a keyed record (not positional arrays).

```typescript
const model = opencode("opencode/big-pickle", {
  onForm: (form) => ({
    type: "answer",
    answer: { environment: "staging", confirm: true },
  }),
  formPolicy: "cancel", // no handler (or handler throws): cancel unblocks the session; "wait" leaves it pending
});
```

Return `{ type: "cancel" }` to decline. Handled form IDs appear in `providerMetadata.opencode.formIds`. Note: the form wiring follows the beta contract and is unit-tested, but no live server flow has produced a form end-to-end yet — treat it as beta within the beta.

## Structured output: honest status

**OpenCode v2 has no server-side structured output.** The v1 `json_schema` format is gone from the prompt contract, so this provider cannot enforce a schema. What it does instead:

- `responseFormat: { type: "json" }` appends a prompt-engineered JSON instruction (schema included when provided) and emits an unsupported-format **warning** — the model may still deviate.
- Opt-in `jsonRepair: { maxAttempts }` (non-streaming only): the final text is validated client-side (`JSON.parse` + structural check against the schema); on failure the server's session-less `generate.text` route is asked to repair the output, bounded by `maxAttempts`. The original turn is never replayed, so tool side effects cannot repeat.

Always validate the result yourself (the AI SDK's object helpers re-validate — expect failures to surface there). Never assume enforcement.

## Files and images

The v2 prompt accepts files only as URIs, and **`data:` URIs are the only scheme verified to work across server builds** (others are rejected at prompt time or fail the turn late at the model provider). The provider therefore:

- advertises `supportedUrls: {}`, so the AI SDK downloads remote URLs to bytes before the provider sees them;
- converts bytes to `data:` URIs with the correct media type (the server trusts the URI's declared mediatype);
- warns and skips anything it cannot convert, instead of letting the turn fail late.

A `resolveFileToUri` hook lets you customize the conversion; it must return a `data:` URI (or `undefined` to skip).

```typescript
await generateText({
  model,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What color is this image?" },
        { type: "file", mediaType: "image/png", data: pngBytes },
      ],
    },
  ],
});
```

## Settings reference

### Provider settings (`createOpencode(...)`)

| Setting           | Type                                            | Notes                                                          |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `client`          | `OpencodeClient`                                | Caller-supplied v2 client; highest precedence, never disposed  |
| `clientManager`   | `OpencodeClientManager`                         | Caller-supplied manager; never disposed                        |
| `baseUrl`         | `string`                                        | Explicit server URL                                            |
| `service`         | `{ file?, version?, command?, env?, onStart? }` | Local-service discovery options                                |
| `autoStart`       | `boolean` (default `false`)                     | Spawn via `Service.ensure` when discovery finds nothing        |
| `clientOptions`   | `{ headers?, fetch? }`                          | Client construction passthrough for `baseUrl`/service backends |
| `defaultSettings` | `OpencodeSettings`                              | Defaults merged under per-model settings                       |

### Model settings (`opencode(modelId, {...})`)

| Setting                 | Type                                        | Notes                                                                                                                           |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`             | `string`                                    | Pin an existing session (shared-session caveat)                                                                                 |
| `sessionMode`           | `"ephemeral" \| "persistent" \| "existing"` | Default `"ephemeral"`                                                                                                           |
| `createNewSession`      | `boolean`                                   | Fresh session per ordinary call; approval continuations still reattach to the blocked session                                   |
| `sessionTitle`          | `string`                                    | Title for created sessions                                                                                                      |
| `agent`                 | `string`                                    | Session state, set at create                                                                                                    |
| `systemPrompt`          | `string`                                    | **Degraded**: prepended to the first user turn as a delimited block, with a warning — v2 has no per-prompt/session system field |
| `variant`               | `string`                                    | Model variant (requires a resolvable `providerID`)                                                                              |
| `location`              | `{ directory, workspaceID? }`               | Session location, bound at create (replaces v4 `directory`/`cwd`)                                                               |
| `directory`             | `string`                                    | Deprecated alias for `location.directory`                                                                                       |
| `delivery`              | `"queue" \| "steer"`                        | Busy-session delivery; provider default `"queue"`, sent explicitly                                                              |
| `resume`                | `boolean`                                   | v2 `resume` flag (semantics provisional upstream)                                                                               |
| `onForm` / `formPolicy` | see above                                   | Forms handling; policy default `"cancel"`                                                                                       |
| `resolveFileToUri`      | hook                                        | Custom file→`data:` URI resolution                                                                                              |
| `jsonRepair`            | `{ maxAttempts? }`                          | Opt-in client-side JSON validate/repair (non-streaming)                                                                         |
| `logger` / `verbose`    | `Logger \| false` / `boolean`               | Logging                                                                                                                         |

### Response metadata

`providerMetadata.opencode` carries: `sessionId`, `messageId`, `inboxId`, `approvalRequestId(s)`, `repliedApprovalIds`, `formIds`, native `finish`/`rawFinish`, `outcome` (`succeeded`/`failed`/`interrupted`), `interruptReason`, `cost` (USD), native `tokens` (incl. cache read/write), structured `error`, and `retry` info.

## Limitations (v2 network contract)

- **No custom tools** — AI SDK `tools`/`toolChoice` are ignored (warning). Tool availability is server/agent configuration.
- **No sampling parameters** — `temperature`, `topP`, `topK`, `maxOutputTokens`, etc. have no v2 prompt field; they are ignored with a warning.
- **System prompts are degraded** — delimited prepend on the first user turn, not a true system role.
- **No native structured output** — see above.
- **Assistant file outputs** — v2 assistant messages carry only text/reasoning/tool content; files surface only inside tool results.
- **Multi-turn AI SDK history** — on a fresh session, prior history is serialized into a delimited transcript in the first turn (OpenCode owns the real transcript; reuse one model instance instead where possible).
- **Steer delivery** — verified as mid-turn context injection: it does not interrupt or supersede the running turn and produces no dedicated answer of its own.
- **Shared sessions** — no inbox→execution correlation key; exclusivity is a documented caveat, not enforceable.

## Error handling

Errors are normalized to AI SDK error types (`APICallError` etc.) with phase-aware retryability: nothing is surfaced as retryable once a prompt has been dispatched (an SDK-level retry would enqueue duplicate work); post-dispatch failures are reconciled internally against the session's message store. Helpers:

```typescript
import {
  isAbortError,
  isClientError,
  getClientErrorStatus,
  extractErrorMessage,
} from "ai-sdk-provider-opencode-sdk";
```

## Cleanup

```typescript
await opencode.dispose();
```

`dispose()` releases provider-owned resources only: it never closes caller-supplied clients, never disposes injected managers, and never stops a shared registered service (stopping a service the provider spawned in owned mode is the exception). `provider.getClientManager().stopService()` is the explicit, user-invoked stop.

## Examples

All examples need a running beta-source server — see [`examples/env.ts`](examples/env.ts) for the environment variables (`OPENCODE_BETA_URL`, `OPENCODE_BETA_PASSWORD`, `OPENCODE_MODEL`, `OPENCODE_DIRECTORY`).

- [`examples/basic-usage.ts`](examples/basic-usage.ts) — minimal `generateText` (`npm run example:basic`)
- [`examples/streaming.ts`](examples/streaming.ts) — streaming deltas + final usage (`npm run example:streaming`)
- [`examples/form-handling.ts`](examples/form-handling.ts) — `onForm` wiring (`npm run example:form-handling`)
- [`examples/tool-approval.ts`](examples/tool-approval.ts) — two-phase approval round-trip (`npm run example:tool-approval`)
- [`examples/client-options.ts`](examples/client-options.ts) — backends, headers, custom fetch (`npm run example:client-options`)
- [`examples/abort-signal.ts`](examples/abort-signal.ts) — cancellation pre/mid-turn (`npm run example:abort`)

## Advanced exports

For power users and tooling: `OpencodeLanguageModel` (direct construction exposes timing knobs like `readinessTimeoutMs`, `silenceWatchdogMs`, `waitWatchdogGraceMs`), `createClientManager` / `createClientManagerFromSettings` / `createClientManagerFromPort`, the `OpencodeClientPort` facade (`asClientPort`), validation helpers, the v2 event reducer (`convertV2EventToStreamParts`, `createV2StreamState`, …), finish-reason mappers, error utilities, and re-exported beta client types (`V2Event`, `PermissionRequest`, form types). Most applications should stick to `createOpencode()`.

## License

MIT
