# [DRAFT — do not post yet] v2: `files[].uri` accepts every scheme but only `data:` works — late, opaque failures

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, api, bug/docs

## Problem

v2's `session.prompt` file input is URI-only (`files: [{uri, name?, description?, …}]` — no mime, no bytes). Nothing documents which schemes are supported, and the observed behavior (dev CLI `0.0.0-dev-202608261632`, 2026-08-26) is a trap:

- **Every scheme is accepted at the API boundary** — `data:`, `file://`, `https://`, absolute and workspace-relative paths were all admitted and stored on the user message verbatim (mime inferred from the _file name_, not content).
- **Only `data:` URIs actually work.** For all other schemes the raw URI string is passed through to the model provider as media and the _turn_ later fails with `finish:"error"`, `error:{type:"unknown", message:"OpenAI Responses media must contain valid base64"}`.
- So an invalid attachment does not reject the prompt (where the caller could handle it) — it kills the whole generation afterward, with a provider-internal error message that never mentions the file.

Repro: send a small PNG as each URI form to an image-capable model, then read `message.list`. We have captured request/response/event JSON for all five cases and can attach it.

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). AI SDK file parts arrive as bytes or URLs; we must decide per scheme whether to pass through or download-and-inline, and we need prompt-time errors to surface attachment problems to the caller. Today we can only support `data:` and must treat everything else as caller error — but the API shape suggests (and silently accepts) much more.

## Ask

1. Document the supported `uri` schemes for `files[].uri` (and keep `data:` supported — it is currently the only working path and our primary integration).
2. **Validate at prompt time**: reject unsupported schemes with `InvalidRequestError` (the validation layer already produces excellent path-anchored messages) instead of failing the turn later with an opaque provider error.
3. Clarify intent for `file://`/workspace-relative paths (should the server read them from the session `location`?) and `https:` (does the server fetch? under whose credentials/SSRF policy?). If server-side fetching is planned, an allowlist + size cap would be expected.
4. If bytes-upload is the long-term answer, consider an explicit upload API returning an opaque URI; we would adopt it immediately.
