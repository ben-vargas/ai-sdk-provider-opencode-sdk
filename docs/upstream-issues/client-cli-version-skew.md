# [DRAFT — do not post yet] v2: the CLI that serves the v2 contract is undiscoverable, and its dist-tags do not pair with the client's

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, packaging, dx, docs

> **Correction note (2026-08-27).** An earlier revision of this draft claimed
> _no published CLI serves the v2 contract_. That was **wrong**, and the
> mistake is itself the point of this issue: we had been probing
> `opencode-ai`, the **v1** package name. The v2 CLI is published as
> **`@opencode-ai/cli`**, its binary is **`opencode2`**, and
> `@opencode-ai/cli@0.0.0-beta-18286` serves the pinned
> `@opencode-ai/client@0.0.0-beta-18286` contract correctly. Everything below
> is the residual, verified problem: nothing in the docs, package metadata or
> dist-tags leads you there.

## Problem

### 1. The package name is a trap

`opencode-ai` is the **v1** CLI. Its `latest` is `1.18.23` — a real v1
release — and its `beta`/`dev` tags (`0.0.0-beta-202608110357`,
`0.0.0-dev-202608261632`) publish a **partial 51-route v2 surface** with a
different protocol generation: nested `{prompt: {...}}` bodies (the v2
client's flat body is rejected with `InvalidRequestError: Missing key at
["prompt"]`), `session.next.*` event names, and no execution/inbox/form/log
routes at all (`spike/artifacts/01-baseline-cycle.json`,
`spike/artifacts/04-dev-full-cycle.json`, `spike/artifacts/doc-openapi.json`,
`spike/artifacts/doc-openapi-beta-cli.json`).

Meanwhile the v2 CLI lives at **`@opencode-ai/cli`** with binary
**`opencode2`**. A consumer who reads "install the OpenCode CLI", reaches for
`opencode-ai`, and pairs it with `@opencode-ai/client` gets a
protocol-mismatched pair and opaque `InvalidRequestError` /
`UnsupportedContentType` failures. Nothing in either package's metadata says
"this is v1" or "the v2 CLI is elsewhere".

We lost real time to exactly this, and concluded in writing that no published
v2 server existed. It did.

### 2. `@opencode-ai/cli`'s own dist-tags are misleading

Observed 2026-08-27:

| Package               | `latest`           | `next`             | `beta`             | `dev`             |
| --------------------- | ------------------ | ------------------ | ------------------ | ----------------- |
| `@opencode-ai/cli`    | `0.0.0-beta-17823` | `0.0.0-beta-17823` | `0.0.0-beta-18314` | `0.0.0-dev-18370` |
| `@opencode-ai/client` | `0.0.0`            | `0.0.0-next-17444` | `0.0.0-beta-18371` | `0.0.0-dev-18372` |

Two independent problems:

- **`latest`/`next` point at an older build than `beta`.** `npm i
@opencode-ai/cli` installs `0.0.0-beta-17823`, which is _behind_
  the `beta` tag's `18314`. `latest` normally means newest-stable; here it
  means neither newest nor stable.
- **The same dist-tag does not pair across packages.** Today `cli@beta` is
  `18314` while `client@beta` is `18371` — installing both at `beta` yields a
  **57-build skew**, and `client@latest` is literally `0.0.0`. There is no
  documented rule saying build numbers must match, yet in practice they must:
  we pin `client` and `cli` to the _same_ build (`0.0.0-beta-18286`)
  and that pair works verbatim.

### 3. Nothing at runtime tells you whether a client and a server are compatible

`health.get()` returns `{healthy, version, pid}` where `version` is the build
number (`0.0.0-beta-18286`) — which is usable, but there is no documented
statement that "client build X requires server build X", so a client cannot
know what to assert. `/api/doc` does not exist on this build (404 when
authenticated). The OpenAPI document _is_ served, at **`/openapi.json`** —
useful, but undocumented and not where the v1 CLI put it.

Compounding it: unknown routes on `/api/...` do not 404 cleanly on the older
builds — they return **SPA HTML with 200**, so a client cannot distinguish
"route not implemented on this build" from "wrong content type".

## What does work (for the record)

`@opencode-ai/cli@0.0.0-beta-18286` (`opencode2 serve`) serves
`@opencode-ai/client@0.0.0-beta-18286` correctly. We run a full gated
integration suite against it — prompt→stream→finish, abort, queue/steer
delivery, approvals, file ingestion, `session.wait`, `session.log`,
`migration.v1.status`, and session instruction entries — and assert
client-operations ⊆ `/openapi.json`. Captures:
`spike/artifacts/14-opencode2-verification.json`,
`spike/artifacts/14b-instruction-entries.json`.

One runtime requirement worth documenting: `serve` requires HTTP Basic auth
(`opencode:<password>`) on **every** route including `/api/health`. It reads
`OPENCODE_PASSWORD`, or generates one and prints `server password <...>` to
stdout.

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). We ship
against the typed v2 client and must tell our users how to run a compatible
server. Right now the honest instruction is "install `@opencode-ai/cli` at
the _exact same build number_ as your `@opencode-ai/client`, and do not use
`latest`" — which is not something a user could derive from the published
metadata.

## Ask

1. **Say what the v2 CLI is.** A note in `opencode-ai`'s README/description
   ("this is OpenCode v1; for v2 use `@opencode-ai/cli`, binary `opencode2`")
   would have saved this entirely.
2. **Fix `@opencode-ai/cli`'s `latest`/`next`** so they do not point behind
   `beta`, or document what they are meant to track.
3. **Publish client and CLI in pairs**, or state the pairing rule explicitly
   ("`@opencode-ai/client@X` requires `@opencode-ai/cli@X`"). Build numbers
   already encode it; only the guarantee is missing.
4. **Document `/openapi.json`** as the v2 spec location, and expose the
   contract generation somewhere a client can assert on so version skew fails
   fast with an actionable message.

Raw captures for all of the above are available (spike artifacts cited
inline) and we're happy to attach them.
