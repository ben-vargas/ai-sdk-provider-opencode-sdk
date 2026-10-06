<p align="center">
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/v/ai-sdk-provider-opencode-sdk?color=00A79E" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/unpacked-size/ai-sdk-provider-opencode-sdk?color=00A79E" alt="install size" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/dy/ai-sdk-provider-opencode-sdk.svg?color=00A79E" alt="npm downloads" /></a>
  <a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/badge/node-%3E%3D22-00A79E" alt="Node.js ≥ 22" /></a>
  <a href="https://www.npmjs.com/package/ai-sdk-provider-opencode-sdk"><img src="https://img.shields.io/npm/l/ai-sdk-provider-opencode-sdk?color=00A79E" alt="License: MIT" /></a>
</p>

# AI SDK Provider for OpenCode

> **5.x targets OpenCode 2.x.** Still running an OpenCode 1.x server? Use the 4.x line: `npm install ai-sdk-provider-opencode-sdk@opencode-v1`. Not sure which you have? See [Which version do I need?](#which-version-do-i-need)

A community provider for the [Vercel AI SDK](https://sdk.vercel.ai/docs) (v7) that runs generations through an [OpenCode](https://opencode.ai) **2.x** server via `@opencode/client`. OpenCode is an AI coding agent: it owns the model catalog, executes tools server-side, and manages sessions; this provider maps that onto `generateText()` / `streamText()` with tool observation, two-phase tool approvals, interactive forms, and native usage/cost metadata.

## Which version do I need?

Two things decide it: your **AI SDK** major version and your **OpenCode server** major version.

|               | OpenCode 2.x                                   | OpenCode 1.x                                                  |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| **AI SDK v7** | **5.x** — `npm i ai-sdk-provider-opencode-sdk` | 4.x — `npm i ai-sdk-provider-opencode-sdk@opencode-v1`        |
| **AI SDK v6** | not supported                                  | 3.x (legacy) — `npm i ai-sdk-provider-opencode-sdk@ai-sdk-v6` |
| **AI SDK v5** | not supported                                  | 0.x (legacy) — `npm i ai-sdk-provider-opencode-sdk@ai-sdk-v5` |

**Which OpenCode do I have?** `opencode --version` prints `opencode v2.x.y` on OpenCode 2 and a bare `1.x.y` on OpenCode 1. A running 2.x server also answers `GET /api/info` with its version; a 1.x server has no such route. Note that the npm package **`opencode-ai` is OpenCode 1.x** — OpenCode 2.x is published as **`@opencode/cli`**.

## Version compatibility

| Provider | AI SDK | OpenCode server                              | npm tag       | Branch                                                                                       | Status      |
| -------- | ------ | -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- | ----------- |
| 5.x      | v7     | 2.x (`@opencode/cli`; tested against 2.0.24) | `latest`      | `main`                                                                                       | Active      |
| 4.x      | v7     | 1.x (`opencode-ai`)                          | `opencode-v1` | [`opencode-v1`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/opencode-v1) | Maintenance |
| 3.x      | v6     | 1.x                                          | `ai-sdk-v6`   | [`ai-sdk-v6`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/ai-sdk-v6)     | Legacy      |
| 2.x, 1.x | v6     | 1.x                                          | —             | historical                                                                                   | Legacy      |
| 0.x      | v5     | 1.x                                          | `ai-sdk-v5`   | [`ai-sdk-v5`](https://github.com/ben-vargas/ai-sdk-provider-opencode-sdk/tree/ai-sdk-v5)     | Legacy      |

**Maintenance** lines get bug fixes; **Legacy** lines stay installable but receive no further releases.

**Upgrading from 4.x?** OpenCode 2.x is a new backend, not an SDK bump, and most settings changed — see **[docs/migrating-v4-to-v5.md](docs/migrating-v4-to-v5.md)** and the [CHANGELOG](CHANGELOG.md).

## Server

5.x pins `@opencode/client@2.0.24`. Run the matching server from the published **`@opencode/cli`** (binary `opencode`, also exposed as `opencode2`), or use the `opencode` 2.x binary from the official installer:

```bash
OPENCODE_PASSWORD=<password> npx @opencode/cli@2.0.24 serve --port 4096
```

`serve` requires HTTP Basic auth on every route: username `opencode`, password from `OPENCODE_PASSWORD` or printed at startup as `server password <...>`. A server without the 2.x `/api/info` route (OpenCode 1.x, or the pre-2.0 beta builds) is reported as incompatible on first use.

## Requirements

- Node.js >= 22
- An OpenCode 2.x server — `npx @opencode/cli@2.0.24 serve` (note the package is `@opencode/cli`, **not** `opencode-ai`)
- Credentials on that server for the providers you want to use. The OpenCode zen free tier works without credentials on 2.x.

```bash
npm install ai-sdk-provider-opencode-sdk ai@^7.0.0
```

## Quick start

The 2.x server requires Basic auth (`opencode:<password>`) on every route:

```typescript
import { generateText } from "ai";
import { createOpencode } from "ai-sdk-provider-opencode-sdk";

// the password the server was started with (`OPENCODE_PASSWORD`)
const password = process.env.OPENCODE_PASSWORD ?? "";

const opencode = createOpencode({
  baseUrl: "http://127.0.0.1:4096",
  clientOptions: {
    headers: {
      Authorization:
        "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
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
   import { OpenCode } from "@opencode/client";
   const client = OpenCode.make({ baseUrl, headers });
   const opencode = createOpencode({ client });
   ```

2. **`clientManager`** — a caller-supplied manager (advanced injection seam; see `createClientManagerFromPort`). Never disposed by the provider.

3. **`baseUrl`** — the provider constructs the client with `clientOptions` (`headers`, `fetch`).

4. **Service discovery** — `Service.discover()` via the local registration file, with the registered endpoint's auth merged automatically. `opencode serve --service` writes `$XDG_STATE_HOME/opencode/service.json` (`{id, version, url, pid, password}`) and binds a fixed port (49374). `autoStart: true` additionally spawns one via `Service.ensure`, whose default command is `opencode serve --service` — that `opencode` must be the 2.x binary (a v1 `opencode` from `opencode-ai` has no `--service` flag), or pass `service.command` explicitly. Auto-start is opt-in because it leaves a long-lived background service running. The zero-config default provider (`import { opencode }`) works once a registered service exists.

Every backend runs a connection preflight (`server.info` + `migration.v1.status`) on first use; a server without `/api/info` is reported as an incompatible pre-2.0 build.

### Model IDs

Models are `providerID/modelID` strings from your server's catalog (`model.list`); a bare `modelID` omits the model at session create so the server default applies. `OpencodeModels` exports shortcuts for three OpenCode zen free-tier IDs, each present in a live 2.0.24 catalog and in the upstream models.dev catalog (no credentials needed on 2.x; the free tier churns and catalogs are server-dependent, so any ID your own catalog lists works — the shortcuts are a convenience, not a limit):

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

Session state is **model-instance-local**: the instance creates or pins a session on first use and reuses it for every later call on that instance. Nothing outlives the instance — no session ID is persisted, and each `opencode(...)` call builds a new model. `sessionMode` selects which session that is:

- `"ephemeral"` (default) — the provider creates a session on first use and owns it exclusively (it survives tool-approval round-trips).
- `"existing"` — pin the session given by `sessionId` (implied when `sessionId` is set without a mode). **Shared-session caveat:** OpenCode 2.x has no inbox→execution correlation key, so events from other clients on the same session (e.g. a TUI) can be misattributed to your call. Use exclusively-owned sessions unless you accept that.

For a fresh session on every ordinary call, use `createNewSession: true` (approval continuations still reattach to the blocked session).

Per call, `providerOptions.opencode.sessionId` targets an existing session for that one request, and `providerOptions.opencode.id` sets the prompt's user-message ID (a `msg_`-prefixed id; when omitted the provider generates one, which it uses to correlate the turn's own events):

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

When the server's permission config requires approval (e.g. `permission: { shell: "ask" }` — the 2.x shell tool is named `shell`), the flow is two-phase:

1. The call finishes with a `tool-approval-request` content part; the session stays pinned on the model instance.
2. Call the **same model instance** again with the prior history plus a `tool-approval-response` part (`{ approvalId, approved }`). The provider sends `permission.reply` and resumes the **original** blocked execution — no new prompt is sent.

Pending/replied approval IDs are reported under `providerMetadata.opencode`. See [`examples/tool-approval.ts`](examples/tool-approval.ts) for the full round-trip.

Rejecting depends on whether you give a reason. With `{ approved: false, reason: "…" }` the reason reaches the model as tool feedback and the turn continues (typically finishing `stop`). With no reason, OpenCode 2.0.24 ends the execution as interrupted with reason `"shutdown"` — the same label as a real server shutdown — so phase 2 finishes with `error` (raw `interrupted:shutdown`); the session stays usable for the next prompt. The provider cannot tell those two shutdowns apart (`repliedApprovalIds` lists approvals and rejections alike), so keep your own record of the decision if you need it — see [`docs/known-upstream-issues/decline-interrupt-reason.md`](docs/known-upstream-issues/decline-interrupt-reason.md).

## Interactive forms (`onForm`)

Forms are v2's replacement for v1 questions: typed, keyed fields answered with a keyed record (not positional arrays).

```typescript
const model = opencode("opencode/big-pickle", {
  onForm: (form) => ({
    type: "answer",
    answer: { environment: "staging", confirm: true },
  }),
  formPolicy: "cancel", // applies when NO handler is set: "cancel" (default) settles the form, "wait" leaves it pending for an external client
});
```

Return `{ type: "cancel" }` to decline. A configured handler that **throws** is not covered by `formPolicy` — that form is always cancelled, under either policy. Handled form IDs appear in `providerMetadata.opencode.formIds`.

Form lifecycle, per the OpenCode source (`packages/core/src/form.ts` @ `v2.0.24`): a tool that asks a form suspends on it until the form is replied to or cancelled, and both outcomes resolve that wait — so cancelling does unblock the tool, though the tool may then fail its call (the built-in websearch tool does).

The built-in `question` tool asks through a form (one `string` or `multiselect` field per question, keyed `q0`, `q1`, …, options from the model's choices), so asking the model to use it is the most reliable way to trigger one (it is still the model's choice). Verified live against 2.0.24 with [`examples/form-handling.ts`](examples/form-handling.ts): an answer resumes the turn and the model uses it. Cancelling a `question` form — returning `{ type: "cancel" }`, the default `formPolicy` with no handler, or a throwing handler — ends the turn the same way a reasonless rejection does (`error`, raw `interrupted:shutdown`). `formIds` lists every form surfaced in the call, answered or cancelled, so it is correlation context, not proof that a cancel caused the interrupt.

## Structured output: honest status

**OpenCode v2 has no server-side structured output.** The v1 `json_schema` format is gone from the prompt contract, so this provider cannot enforce a schema. What it does instead:

- `responseFormat: { type: "json" }` appends a prompt-engineered JSON instruction (schema included when provided) and emits an unsupported-format **warning** — the model may still deviate.
- Opt-in `jsonRepair: { maxAttempts }` (non-streaming only): the final text is validated client-side (`JSON.parse` + structural check against the schema); on failure the server's session-less `generate.text` route is asked to repair the output, bounded by `maxAttempts`. The original turn is never replayed, so tool side effects cannot repeat.

Always validate the result yourself (the AI SDK's object helpers re-validate — expect failures to surface there). Never assume enforcement.

## Files and images

The v2 prompt accepts files only as URIs, and **`data:` URIs are the only portable scheme**: 2.x also reads `file:` URIs, but from the _server's_ filesystem, and rejects other schemes at prompt time. The provider therefore:

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

| Setting                 | Type                          | Notes                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`             | `string`                      | Pin an existing session (shared-session caveat)                                                                                                                                                                                                                                         |
| `sessionMode`           | `"ephemeral" \| "existing"`   | Default `"ephemeral"` (see above)                                                                                                                                                                                                                                                       |
| `createNewSession`      | `boolean`                     | Fresh session per ordinary call; approval continuations still reattach to the blocked session                                                                                                                                                                                           |
| `sessionTitle`          | `string`                      | Title for created sessions                                                                                                                                                                                                                                                              |
| `agent`                 | `string`                      | Session state, set at create                                                                                                                                                                                                                                                            |
| `systemPrompt`          | `string`                      | Written as a session instruction entry (`ai-sdk.system`) — stays in effect for later turns until replaced or cleared. AI SDK `system:` messages are joined after it. Falls back to a delimited prepend + warning when the route is absent or the value exceeds the server's 256 KiB cap |
| `variant`               | `string`                      | Model variant (requires a resolvable `providerID`)                                                                                                                                                                                                                                      |
| `location`              | `{ directory }`               | Session location, bound at create (replaces v4 `directory`/`cwd`)                                                                                                                                                                                                                       |
| `directory`             | `string`                      | Deprecated alias for `location.directory`                                                                                                                                                                                                                                               |
| `delivery`              | `"queue" \| "steer"`          | Busy-session delivery; provider default `"queue"`, sent explicitly                                                                                                                                                                                                                      |
| `resume`                | `boolean`                     | v2 `resume` flag (semantics provisional upstream)                                                                                                                                                                                                                                       |
| `onForm` / `formPolicy` | see above                     | Forms handling; policy default `"cancel"`                                                                                                                                                                                                                                               |
| `resolveFileToUri`      | hook                          | Custom file→`data:` URI resolution                                                                                                                                                                                                                                                      |
| `jsonRepair`            | `{ maxAttempts? }`            | Opt-in client-side JSON validate/repair (non-streaming)                                                                                                                                                                                                                                 |
| `logger` / `verbose`    | `Logger \| false` / `boolean` | Logging                                                                                                                                                                                                                                                                                 |

### Response metadata

`providerMetadata.opencode` carries: `sessionId`, `messageId`, `inboxId`, `approvalRequestId(s)`, `repliedApprovalIds`, `formIds`, native `finish`/`rawFinish`, `outcome` (`succeeded`/`failed`/`interrupted`), `interruptReason`, `cost` (USD), native `tokens` (incl. cache read/write), structured `error`, and `retry` info.

## Limitations (v2 network contract)

- **No custom tools** — AI SDK `tools`/`toolChoice` are ignored (warning). Tool availability is server/agent configuration.
- **No sampling parameters** — `temperature`, `topP`, `topK`, `maxOutputTokens`, etc. have no v2 prompt field; they are ignored with a warning.
- **System prompts have no per-prompt channel** — `systemPrompt` and `system:` messages are delivered as a session instruction entry (`ai-sdk.system`) that applies to the whole session, not per call: changing the system text mid-conversation rewrites the entry (announced as a durable system message) rather than scoping it to one turn. Servers without the entry route, or values over the 256 KiB cap, fall back to the delimited prepend with a warning.
- **Event-stream headers** — `@opencode/client` 2.x shares one SSE connection per client and drops per-request headers on the event subscription; only client-level headers (`clientOptions.headers`, service auth) reach `/api/event`. Per-call `headers` still apply to every other request.
- **No native structured output** — see above.
- **Assistant file outputs** — v2 assistant messages carry only text/reasoning/tool content; files surface only inside tool results.
- **Multi-turn AI SDK history** — on a fresh session, prior history is serialized into a delimited transcript in the first turn (OpenCode owns the real transcript; reuse one model instance instead where possible).
- **Steer delivery** — verified as mid-turn context injection: it does not interrupt or supersede the running turn and produces no dedicated answer of its own.
- **Shared sessions** — no inbox→execution correlation key; exclusivity is a documented caveat, not enforceable.

## Error handling

Errors are normalized to AI SDK error types (`APICallError` etc.) with phase-aware retryability: **nothing is surfaced as retryable once a prompt has been dispatched** (an SDK-level retry would enqueue duplicate work). Post-dispatch failures of the transient class — a dropped event stream, where the turn may still be running server-side — additionally attempt internal reconciliation against the session's message store; every other post-dispatch failure, and a reconciliation that recovers nothing, surfaces as an `error` part plus an error finish. Non-retryable is the guarantee; reconciliation is best-effort on top of it. Helpers:

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

`dispose()` releases provider-owned resources only: it never closes caller-supplied clients, never disposes injected managers, and never stops a registered service — with one exception, a service the provider itself spawned in owned mode (a dedicated `service.file` + `autoStart`, where `Service.ensure` actually started the process rather than reusing one already registered there). `provider.getClientManager().stopService()` is the explicit, user-invoked stop.

## Examples

All examples need a running OpenCode 2.x server — see [`examples/env.ts`](examples/env.ts) for the environment variables (`OPENCODE_URL`, `OPENCODE_PASSWORD`, `OPENCODE_MODEL`, `OPENCODE_DIRECTORY`).

- [`examples/basic-usage.ts`](examples/basic-usage.ts) — minimal `generateText` (`npm run example:basic`)
- [`examples/streaming.ts`](examples/streaming.ts) — streaming deltas + final usage (`npm run example:streaming`)
- [`examples/form-handling.ts`](examples/form-handling.ts) — `onForm` wiring (`npm run example:form-handling`)
- [`examples/tool-approval.ts`](examples/tool-approval.ts) — two-phase approval round-trip (`npm run example:tool-approval`)
- [`examples/client-options.ts`](examples/client-options.ts) — backends, headers, custom fetch (`npm run example:client-options`)
- [`examples/abort-signal.ts`](examples/abort-signal.ts) — cancellation pre/mid-turn (`npm run example:abort`)

## Advanced exports

For power users and tooling: `OpencodeLanguageModel` (direct construction exposes timing knobs like `readinessTimeoutMs`, `silenceWatchdogMs`, `waitWatchdogGraceMs`, `catalogSettleMs`), `createClientManager` / `createClientManagerFromSettings` / `createClientManagerFromPort`, the `OpencodeClientPort` facade (`asClientPort`), validation helpers, the v2 event reducer (`convertV2EventToStreamParts`, `createV2StreamState`, …), finish-reason mappers, error utilities, and re-exported client types (`V2Event`, `PermissionRequest`, form types). Most applications should stick to `createOpencode()`.

## License

MIT
