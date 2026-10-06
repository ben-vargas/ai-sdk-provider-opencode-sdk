# v2 has no schema-enforced structured output on the prompt path

**Status:** Known upstream issue — tracked locally, not filed.
**Last verified:** 2026-10-06, against `@opencode/cli@2.0.24` (same release as the pinned `@opencode/client`) — still present: the live `/openapi.json` has no hits, the prompt body is `{text, files, agents, skills}`, and `generate.text` is still `{prompt, model?}` → `{text}`. First verified 2026-08-27 on `opencode2 0.0.0-beta-18286`.
**How to re-check** (against a newer build — no hits means the issue stands):

```bash
OPENCODE_PASSWORD=pw npx -y @opencode/cli@latest serve --port 4099 & sleep 10; \
  curl -su opencode:pw http://127.0.0.1:4099/openapi.json | \
  grep -oE 'responseFormat|response_format|json_schema|outputSchema|structuredOutput' | sort -u; \
  kill %1
```

**Evidence:** `spike/artifacts/doc-openapi.json`, `spike/artifacts/14-opencode2-verification.json`; provider-side consequences in `docs/v2-spike-findings.md`.

## Problem

OpenCode v1 supported `session.prompt({ format: { type: "json_schema", schema } })`, giving callers server-enforced JSON output. In the v2 beta (`@opencode-ai/client@0.0.0-beta-18286`) there is no equivalent anywhere on the prompt path:

- `SessionPromptInput` is `{sessionID, text, files?, agents?, skills?, id?, metadata?, delivery?, resume?}` — no `format`/schema field.
- A grep of the full generated `.d.ts` shows `format` only as a form-field string format and a config formatter.
- `generate.text({prompt, model?})` and `session.generate({sessionID, prompt})` return `{text}` only.

Verified on the wire against the published `opencode2@0.0.0-beta-18286`, the exact build of the pinned client: its own `/openapi.json` (112 paths) declares the prompt body as `{id, text, files, agents, skills, metadata, delivery, resume}` — no format member — and the strings `responseFormat`, `response_format`, `json_schema`, `outputSchema` and `structuredOutput` do not occur **anywhere** in the document. So there is no structured-output surface on v2, hidden or otherwise.

## Why it matters to this provider

The AI SDK's `generateObject`/`streamObject`/`Output.object()` flows depend on `responseFormat: {type: "json", schema}` reaching the backend. On v1 we mapped this 1:1 to `format: json_schema` and it was one of the provider's most used features. On v2 the only fallback is prompt-engineering ("respond with JSON matching …") plus client-side parse/repair loops (`jsonRepair`) — strictly worse: no grammar constraint, wasted tokens on retries, and a documented behavioral regression for every downstream `generateObject` user.

## What would fix it upstream

1. An answer to whether structured output is intentionally removed in v2 or not yet implemented (if intentional, guidance on the blessed replacement).
2. An optional output contract on the prompt —

   ```ts
   session.prompt({
     sessionID,
     text,
     output?: { type: "json_schema"; schema: JsonSchema; strict?: boolean }
   })
   ```

   with the final assistant message carrying `content: [{type: "structured", value, raw}]` (or equivalent), and a typed `StructuredOutputError` when the model cannot satisfy the schema. Even a non-strict variant (server-side validation + auto-retry policy) would remove most of the client-side machinery.

3. If session history is the obstacle, schema support on `generate.text` / `session.generate` would also work — a two-pass "generate then extract" flow against the same session context.
