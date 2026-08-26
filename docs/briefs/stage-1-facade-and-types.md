# Stage 1 — Client-port facade + public types

## Goal

Lay the v5 foundation: the internal client-port facade that isolates all `@opencode-ai/client` beta churn in one place, and the new public settings/types surface. No language-model logic yet.

## Context (read first)

- `docs/opencode-sdk-v2-analysis.md` — §2.2 (types.ts, client-manager entries), the §2.1 gaps table, and the v4→v5 session-setting table are the contract.
- `docs/v2-spike-findings.md` — where the spike confirmed/refuted a provisional decision, the spike wins; note each such resolution in code comments only where the constraint is non-obvious.
- Ground-truth v2 types: `node_modules/@opencode-ai/client` after you add the dependency (exact pin `0.0.0-beta-18286`, no caret), cross-checked against `/Users/ben/.flowition/workflows/ai-sdk-provider-opencode-sdk/context/client-beta/package/dist/`.

## Deliverables (commits prefixed `stage-1:`)

1. **package.json**: remove `@opencode-ai/sdk`; add `@opencode-ai/client@0.0.0-beta-18286` exact. Version `5.0.0-beta.0` (do not publish). Keep Node >=22, ESM-only. Do NOT add `@opencode-ai/sdk@beta` (embedded comes in a later stage as an optional peer).
2. **`src/client-port.ts`** (new): a narrow internal interface covering only what the provider needs — session (create/get/prompt/wait/interrupt/switchModel/switchAgent/message/context), message.list, event.subscribe, permission (list/get/reply), form (list/state/reply/cancel), health.get, migration.v1.status — with `RequestOptions {signal?, headers?}` on every method. `OpenCode.make(...)`'s client must satisfy it structurally (add a compile-time assertion test). Types come from `@opencode-ai/client`; do not hand-copy shapes the package exports.
3. **`src/types.ts`** rewrite per the analysis: new `OpencodeSettings`/`OpencodeProviderSettings` (remove `tools`, `outputFormatRetryCount`, `cwd`, `onQuestion`/`questionPolicy`, session-create `permission`; keep `systemPrompt` marked degraded; add `location {directory, workspaceID?}`, `delivery`, `resume`, `onForm`/`formPolicy` (default `"cancel"`), session mode, service options `{file?, version?, command?}`, `resolveFileToUri` hook, backend selection `{client | baseUrl | service | autoStart}`); `OpencodeProviderOptions` with `id` (was messageID — no `msg_` assertion) and `sessionId` escape hatch; expanded `OpencodeProviderMetadata`. Form request/answer types derived from the client package.
4. **`src/validation.ts`** updated to the new settings (drop removed-setting rules; enforce backend exclusivity; validate form answers by field key shape).
5. **`src/index.ts`** exports updated (drop question/envelope-era exports; export form types, client-port type, new settings).
6. Delete now-orphaned v1-only code ONLY where it blocks compilation; files that later stages rewrite (converters, language model, client manager) may temporarily hold `// @ts-expect-error` shims or be excluded — prefer making `npm run typecheck` pass by stubbing the old client type imports minimally. Keep the test suite compiling: tests for removed settings get removed with the settings they tested.

## Checks

`npm run typecheck` and `npm run lint` must pass. `npm run test` should pass for everything still compiled (removing tests of removed features is expected; do not weaken remaining assertions). State clearly in your summary which files are stubbed/excluded for later stages.
