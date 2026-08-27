# [WITHDRAWN — do not post] v2: `files[].uri` accepts every scheme but only `data:` works

**Status:** withdrawn 2026-08-27. Every complaint in this draft was already
fixed in the build we ship against; the original evidence came from the wrong
server. Kept as a record, not as a draft to post.

## Why it is withdrawn

The draft was written from dev-CLI captures (`opencode-ai@0.0.0-dev-…`, the
**v1** package's dev tag). It reported that `session.prompt` accepted every
URI scheme at the API boundary, that only `data:` actually reached the model,
and that anything else killed the turn *after* dispatch with a
provider-internal error that never mentioned the file.

On the server this provider actually targets — `@opencode-ai/cli@0.0.0-beta-18286`
(`opencode2`), the published build of the pinned client — none of that holds.
Verified on the source build at stage 6
(`spike/artifacts/12b-beta-src-file-uris.json`) and re-verified on the
published binary at stage 9 (`spike/artifacts/14-opencode2-verification.json`,
`v6Files`), using an image-capable model:

| URI form                    | Behaviour on `opencode2@0.0.0-beta-18286`                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `data:image/png;base64,…`   | Works — model answers "Red"; stored as `source: {type: "inline"}`                                      |
| `file:///…` (readable)      | **Works** — the server reads the file and stores `source: {type: "uri", uri}` with the bytes inlined   |
| `file:///…` (missing)       | Rejected **at prompt time**: `Unable to read attachment: file:///…`                                    |
| `https://…`                 | Rejected **at prompt time**: `Unsupported attachment URI: https://…`                                   |
| Bare absolute path          | Rejected **at prompt time**: `Invalid attachment URI: /…`                                              |
| Relative path               | Rejected **at prompt time**: `Invalid attachment URI: red-square.png`                                  |

That is the draft's ask #2 — "validate at prompt time; reject unsupported
schemes instead of failing the turn later" — already implemented, with
precise, caller-actionable messages. Ask #1 (document the supported schemes)
is the only fragment with any life left in it, and it is too thin to open an
issue over on its own; it is folded into the docs asks in
`client-cli-version-skew.md`.

## Note for this repo (not upstream)

The provider's own `data:`-only preflight is **not** a workaround for the
behaviour described above — it stays deliberately, because the provider
cannot tell which build a caller's `baseUrl` points at, and on the v1-lineage
builds a non-`data:` URI still fails late and opaquely. See deferred-ledger
item 9 for the current reasoning.
