# [DRAFT — do not post yet] v2: no schema-enforced structured output on the prompt path

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, api, feature

## Problem

OpenCode v1 supported `session.prompt({ format: { type: "json_schema", schema } })`, giving callers server-enforced JSON output. In the v2 beta (`@opencode-ai/client@0.0.0-beta-18286`) there is no equivalent anywhere on the prompt path:

- `SessionPromptInput` is `{sessionID, text, files?, agents?, skills?, id?, metadata?, delivery?, resume?}` — no `format`/schema field.
- A grep of the full generated `.d.ts` shows `format` only as a form-field string format and a config formatter.
- `generate.text({prompt, model?})` and `session.generate({sessionID, prompt})` return `{text}` only.

We could not verify a hidden/server-side variant either: on the embedded host (`@opencode-ai/sdk@0.0.0-beta-18286`) the prompt route itself currently 500s, and the dev-channel CLI (`0.0.0-dev-202608261632`) exposes a `{prompt: {text, files, agents}}` body with no format member in its own OpenAPI (`GET /doc`, `PromptInput` schema — captured 2026-08-26).

## Use case

We maintain `ai-sdk-provider-opencode-sdk`, a Vercel AI SDK provider backed by OpenCode. The AI SDK's `generateObject`/`streamObject`/`Output.object()` flows depend on `responseFormat: {type: "json", schema}` reaching the backend. On v1 we map this 1:1 to `format: json_schema` and it is one of the provider's most used features. On v2 our only fallback is prompt-engineering ("respond with JSON matching …") plus client-side parse/repair loops — strictly worse: no grammar constraint, wasted tokens on retries, and a documented behavioral regression for every downstream `generateObject` user.

## Ask

1. Is structured output intentionally removed in v2, or not yet implemented? (If intentional, guidance on the blessed replacement would help.)
2. Concrete suggestion: accept an optional output contract on the prompt —

   ```ts
   session.prompt({
     sessionID,
     text,
     output?: { type: "json_schema"; schema: JsonSchema; strict?: boolean }
   })
   ```

   with the final assistant message carrying `content: [{type: "structured", value, raw}]` (or equivalent), and a typed `StructuredOutputError` when the model cannot satisfy the schema. Even a non-strict variant (server-side validation + auto-retry policy) would remove most of the client-side machinery.

3. If session history is the obstacle, an accepted alternative would be schema support on `generate.text` / `session.generate` — we can then run a two-pass "generate then extract" flow against the same session context.
