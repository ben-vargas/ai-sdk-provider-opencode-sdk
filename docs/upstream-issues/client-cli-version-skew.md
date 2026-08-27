# [DRAFT — do not post yet] v2: no published CLI/server matches the contract generation of `@opencode-ai/client@beta`

**Repo:** anomalyco/opencode
**Labels (suggested):** v2, packaging, dx

## Problem

The published packages that make up a working v2 setup are not release-paired, and as of 2026-08-26 no installable CLI serves the API that the current `@opencode-ai/client@beta` speaks:

- `@opencode-ai/client@beta` resolves to `0.0.0-beta-18286` (beta branch). Its generated contract expects flat `session.prompt` bodies, `session.execution.*` / `session.inbox.*` / `session.text.delta` events, `form.*`, `session.log`, `/api/experimental/migration/v1`, etc.
- `opencode-ai@dev` (`0.0.0-dev-202608261632`, published the same day as the client build) serves a 51-route partial v2 surface from the dev branch with an **older/different protocol**: nested `{prompt: {...}}` bodies (the beta client's flat body is rejected with `InvalidRequestError: Missing key at ["prompt"]`), `session.next.*` event names, and no execution/inbox/form/log routes at all (`spike/artifacts/01-baseline-cycle.json`, `spike/artifacts/04-dev-full-cycle.json`, `spike/artifacts/doc-openapi.json`).
- `opencode-ai@beta` (`0.0.0-beta-202608110357`, Aug 11 build) has the **same** partial 51-route surface, only older (`spike/artifacts/doc-openapi-beta-cli.json`) — the beta dist-tag on the CLI does not track the beta dist-tag on the client.
- Even shared routes diverge in contract: dev's `session.compact` and `session.interrupt` return 204/no-body where client-18286 expects receipt/`{interrupted}` bodies (`spike/artifacts/08-interrupt-resume.json`).

So "install the beta client + install a CLI" currently cannot produce a working pair, and nothing in the version strings reveals that: all three artifacts use `0.0.0-*` builds with a generic `info.version: "1.0.0"` in `/doc`, and `client.health.get()` version gating has nothing documented to gate on.

## Stage-6 addendum: source build is the only compatible server; embedded host is Bun-only

Verified 2026-08-26 against the `beta` branch **built from source** at
`f4a9b930` (the commit matching client build `0.0.0-beta-18286`, via
`bun install` + `bun run --cwd packages/cli --conditions=browser src/index.ts
serve`):

- The source-built server speaks the pinned client's contract **verbatim**:
  flat `session.prompt` bodies, `session.inbox.*`/`session.execution.*`/
  `session.text.delta` events, `{interrupted}` interrupt body, form/inbox
  routes, `/openapi.json` covering every operation the client generation
  expects — 130 method+path pairs over 110 unique paths, against a server
  document of 112 paths / 133 operations
  (our integration suite asserts client-operations ⊆ server-spec and passes a
  full prompt→stream→finish/abort/queue/approval matrix against it). So the
  contract itself is fine — **the only way to obtain a matching server today
  is building the beta branch from source with bun**, which no downstream
  consumer of the published npm packages can be expected to do.
- The embedded-host alternative is closed off for Node consumers:
  `@opencode-ai/sdk@0.0.0-beta-18286` ships extensionless relative ESM
  imports (`import ... from "./promise"`), which Node cannot resolve
  (`ERR_MODULE_NOT_FOUND`); it only runs under Bun. A provider package
  cannot ship a `./embedded` entrypoint for Node users until the beta sdk
  publishes Node-resolvable ESM (file extensions or an exports map).
- Additional runtime requirement worth documenting: the beta server requires
  HTTP Basic auth (`opencode:<password>`) on every route including
  `/api/health`; foreground `serve` reads `OPENCODE_PASSWORD` or generates
  and prints one. Clients pointed at a `baseUrl` need the credential — one
  more thing `health.get()` gating cannot discover by itself today.

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). We develop against the typed beta client (the analysis-recommended path) but can only validate behavior against a live server — and today every live server speaks a different contract generation than the client we ship against. We had to build our reducer/fixtures purely from the generated types because captured live streams are not valid fixtures for the beta contract. Users hitting the skew see opaque `InvalidRequestError`/`UnsupportedContentType` failures with no hint that the problem is client↔server generation mismatch.

## Ask

1. **Paired publishes**: when a `@opencode-ai/client` build is published to a dist-tag, publish an `opencode-ai` CLI build of the same contract generation to the matching dist-tag (or gate the client publish on one existing).
2. Failing that, a **documented compatibility matrix**: which client builds speak to which CLI/server builds, and which dist-tags are expected to interoperate.
3. Expose a **contract-generation identifier** at runtime (e.g. in `health.get()`/`server.get()` or `/doc` `info.version`) so clients can fail fast with an actionable version-skew message instead of a route-level 4xx/`UnsupportedContentType`.

Raw captures for all of the above are available (spike artifacts cited inline) and we're happy to attach them.
