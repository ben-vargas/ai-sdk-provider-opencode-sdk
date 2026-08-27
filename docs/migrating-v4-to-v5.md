# Migrating from 4.x to 5.x

5.0.0 targets **OpenCode v2** via `@opencode-ai/client` (pinned to
`0.0.0-beta-18286`). OpenCode v2 is a new backend, not an SDK bump: the
client package, result shapes, prompt contract, streaming events, questions,
permissions, structured output, and server lifecycle all changed. 4.x remains
the line for OpenCode 1.18.x servers.

Every table below is sourced from the shipped 5.0.0-beta code
(`src/types.ts` is authoritative); divergences from the original design
analysis are called out where they exist.

## Requirements

|                 | 4.x                                            | 5.x                                                                                                                                      |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| AI SDK          | v7 (`LanguageModelV4`)                         | v7 (unchanged)                                                                                                                           |
| OpenCode server | 1.18.x published CLI                           | v2 beta contract — **no published binary yet**; upstream `anomalyco/opencode` `beta` branch built from source (see README status banner) |
| SDK dependency  | `@opencode-ai/sdk@^1.18.11` (`/v2` entrypoint) | `@opencode-ai/client@0.0.0-beta-18286` (exact pin)                                                                                       |
| Node            | >= 22                                          | >= 22 (unchanged)                                                                                                                        |

## Provider settings (`createOpencode`)

| v4 setting         | v5 disposition                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`, `port` | **Removed.** v2 has no port-probing; use `baseUrl` for an explicit endpoint, or the service-discovery backend.                                                                                                                                                                                                          |
| `autoStartServer`  | **Removed.** Replaced by `autoStart` (default **`false`**) on the service backend — v2 servers are shared registered services (`Service.discover`/`ensure`), not child processes the provider owns. Note: no published CLI supports `serve --service` yet, so auto-start only works against source builds.              |
| `serverTimeout`    | **Removed** (no spawn-and-probe loop to bound).                                                                                                                                                                                                                                                                         |
| `baseUrl`          | Kept. Beta servers require Basic auth: pass `clientOptions.headers.Authorization`.                                                                                                                                                                                                                                      |
| `client`           | Kept, **retyped**: now an `OpenCode.make(...)` v2 client, not `createOpencodeClient()`. Still never disposed by the provider.                                                                                                                                                                                           |
| `clientManager`    | Kept, retyped to the new `OpencodeClientManager` interface (`getPort()`-based). The v4 singleton (`OpencodeClientManager.createInstance` / `resetInstance`) is gone — managers are plain per-provider values; build one with `createClientManager` / `createClientManagerFromSettings` / `createClientManagerFromPort`. |
| `clientOptions`    | Kept, **collapsed to `{ headers?, fetch? }`** — v2 client construction accepts nothing else. Gone: `auth`, `responseStyle`, `throwOnError`, serializers, validators, interceptors, `RequestInit` fields.                                                                                                                |
| `defaultSettings`  | Kept (merged under per-model settings).                                                                                                                                                                                                                                                                                 |
| —                  | **New:** `service` (`{ file?, version?, command?, env?, onStart? }`) for discovery/ensure, `autoStart`.                                                                                                                                                                                                                 |

Before / after:

```typescript
// v4
const opencode = createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  autoStartServer: true,
  serverTimeout: 10000,
});

// v5 — explicit endpoint (beta servers need Basic auth)
const opencode = createOpencode({
  baseUrl: "http://127.0.0.1:14196",
  clientOptions: {
    headers: { Authorization: "Basic " + btoa("opencode:" + password) },
  },
});

// v5 — or local-service discovery (registration file; auth merged for you)
const opencode = createOpencode({
  service: { file: "/path/to/service-local.json" },
  autoStart: false,
});
```

## Model settings (`opencode(modelId, {...})`)

| v4 setting                          | v5 disposition                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`                         | Kept: pins an existing v2 session (implies `sessionMode: "existing"`). Validated via `session.get` before use. **Shared-session caveat:** the beta has no inbox→execution correlation key, so another client's activity on the session can be misattributed.                              |
| `createNewSession`                  | Kept, **semantics change**: still forces a fresh session per ordinary generation call, but tool-approval continuation calls always reattach to the blocked session regardless (v2 approvals resume a pinned session — a documented deviation from v4).                                    |
| `sessionTitle`                      | Kept.                                                                                                                                                                                                                                                                                     |
| `agent`                             | Kept — but agent is now **session state** (set at `session.create`), not a per-prompt field.                                                                                                                                                                                              |
| `systemPrompt`                      | Kept, **degraded**: v2 has no per-prompt/per-session system field. The provider prepends a delimited system block to the first user turn and emits a warning (system-role priority is lost).                                                                                              |
| `tools` (`Record<string, boolean>`) | **Removed.** No v2 per-request field exists. Tool availability is server/agent configuration. (AI SDK-level `tools`/`toolChoice` are likewise ignored with a warning.)                                                                                                                    |
| `permission` (per-session ruleset)  | **Removed.** `session.create` has no permission field in v2; rules live on agents and server config (e.g. `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}'`) and project-saved permissions.                                                                                       |
| `variant`                           | Kept — rides the session's `ModelRef`. New constraint: a bare model ID (no `providerID/`) combined with `variant` must resolve a provider via the catalog, else the call rejects.                                                                                                         |
| `directory`                         | **Deprecated alias** for `location.directory` (warns; ignored when `location` is set).                                                                                                                                                                                                    |
| `cwd`                               | **Removed.** Use `location: { directory }`.                                                                                                                                                                                                                                               |
| `outputFormatRetryCount`            | **Removed** — it retried v1's native `json_schema`, which no longer exists (see Structured output below). Closest v5 analog: `jsonRepair`.                                                                                                                                                |
| `onQuestion` / `questionPolicy`     | **Removed.** v2 replaces questions with **forms**: `onForm` receives typed, keyed fields and returns a keyed answer record (not positional `string[][]`); `formPolicy` (`"cancel"`/`"wait"`) replaces `questionPolicy` (`"reject"`/`"wait"`), with cancel as the non-deadlocking default. |
| `logger`, `verbose`                 | Kept.                                                                                                                                                                                                                                                                                     |
| —                                   | **New:** `sessionMode` (`"ephemeral"` default / `"persistent"` / `"existing"`), `location`, `delivery` (`"queue"` default, sent explicitly), `resume`, `onForm`, `formPolicy`, `resolveFileToUri`, `jsonRepair`.                                                                          |

Questions → forms, before / after:

```typescript
// v4 — positional answers
const model = opencode("openai/gpt-5.1", {
  onQuestion: (request) => ({
    type: "answer",
    answers: request.questions.map((q) => [q.options[0]?.label ?? ""]),
  }),
  questionPolicy: "reject",
});

// v5 — keyed answers
const model = opencode("opencode/big-pickle", {
  onForm: (form) => ({
    type: "answer",
    answer: { environment: "staging", confirm: true }, // { [fieldKey]: value }
  }),
  formPolicy: "cancel",
});
```

## Session behavior

- **Default binding changed.** v4 implicitly reused one session forever. v5
  defaults to `sessionMode: "ephemeral"`: a provider-owned session per
  conversation, where **one model instance = one conversation** (the session
  survives approval round-trips within it). The v4 behavior is
  `sessionMode: "persistent"`.
- `providerOptions.opencode.messageID` → **`providerOptions.opencode.id`**
  (the v2 prompt's user-message ID). New: `providerOptions.opencode.sessionId`
  as a per-call session escape hatch.
- `model.getSessionId()` still returns the pinned session ID.
- Multi-turn AI SDK history: on a reused session only the newest user text is
  sent (OpenCode owns the transcript); on a fresh session, prior history is
  serialized into a delimited transcript block in the first turn.

## Structured output

v1's native `format: json_schema` and the `StructuredOutput` tool **do not
exist in v2**. In v5, `responseFormat: { type: "json" }`:

- appends a prompt-engineered JSON instruction (schema included when given)
  and emits an unsupported-format warning — no server-side enforcement;
- optionally (opt-in `jsonRepair: { maxAttempts }`, non-streaming only)
  validates the final text client-side and asks the server's session-less
  `generate.text` route to repair invalid output. The original turn is never
  replayed.

If you used `Output.object()` / `generateObject` with v4's two-step fallback
pattern, keep the validate-and-retry pattern at the application level; do not
expect native enforcement.

## Files

- v4 accepted base64/data-URL image input and passed it through the v1 parts
  array. v5 must send `files: [{ uri }]`, and **`data:` URIs are the only
  scheme verified to work across server builds** — the provider converts
  bytes to `data:` URIs (correct media type encoded in the URI) and warns and
  skips anything unconvertible. `supportedUrls` stays `{}`, so the AI SDK
  downloads remote URLs to bytes first.
- **Assistant file outputs are gone in v2**: assistant messages carry only
  text/reasoning/tool content, so standalone assistant `file` parts no longer
  appear; files surface only inside tool results (as `file`/`source` parts).

## Errors

- v1's named error classes (`MessageAbortedError`, `ProviderAuthError`,
  `StructuredOutputError`, …) and the `{ data, error }` fields-style results
  are gone. v2 throws tagged errors (`_tag` discriminants) plus transport
  `ClientError`s; the provider normalizes both into AI SDK error types.
- v4 helper exports `isAuthenticationError` / `isTimeoutError` /
  `createAPICallError` / `createEmptyResponseDataError` are **removed**. v5
  exports `isAbortError`, `isClientError`, `isTaggedError`,
  `getClientErrorStatus`, `extractErrorMessage`, `normalizeStructuredError`,
  `wrapError`, `needsSessionReconciliation`.
- Retryability is **phase-aware**: once a prompt (or permission reply) has
  been dispatched, no error surfaces as retryable — the provider reconciles
  internally against the session instead, so the AI SDK can never re-enqueue
  a duplicate prompt.

## Lifecycle / disposal

- v4 spawned `createOpencodeServer` and killed it on dispose (with process
  signal handlers). v5 never owns a shared server: `dispose()` releases
  provider resources only, never stops a registered service (unless the
  provider spawned it in owned mode: dedicated `service.file` +
  `autoStart`), and never closes caller-supplied clients or managers.
  Explicit stop: `provider.getClientManager().stopService()`.
- Process signal handlers are gone — your application owns termination.

## Metadata

`providerMetadata.opencode` expanded: alongside `sessionId`/`messageId` it
now reports `inboxId`, `approvalRequestId(s)`, `repliedApprovalIds`,
`formIds`, native `finish`/`rawFinish`, `outcome`, `interruptReason`,
`cost` (USD), native `tokens` (with cache read/write), structured `error`,
and `retry` info.

## Divergences from the design analysis (code wins)

- `createNewSession` was **kept** (the analysis offered keep-or-remove);
  the approval-continuation deviation is documented above.
- The provider always sends `delivery: "queue"` explicitly because the live
  server default was verified to be `"steer"` (the analysis assumed the
  recommendation and the server default might match).
- Steer was verified (stage 7) to be **mid-turn context injection** — it
  does not supersede or interrupt the running turn and produces no dedicated
  answer; earlier supersession language in the analysis is obsolete.
- `session.log` catch-up recovery was designed but is **not wired** —
  historical replay is unimplemented upstream; SSE-drop recovery uses the
  message store.
- The optional `./embedded` entrypoint did not ship (the beta embedded host
  is non-functional for generation and Node-incompatible);
  `createClientManagerFromPort` is the supported injection seam.
