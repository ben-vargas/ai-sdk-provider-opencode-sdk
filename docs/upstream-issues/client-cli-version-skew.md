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

## Use case

We maintain `ai-sdk-provider-opencode-sdk` (Vercel AI SDK provider). We develop against the typed beta client (the analysis-recommended path) but can only validate behavior against a live server — and today every live server speaks a different contract generation than the client we ship against. We had to build our reducer/fixtures purely from the generated types because captured live streams are not valid fixtures for the beta contract. Users hitting the skew see opaque `InvalidRequestError`/`UnsupportedContentType` failures with no hint that the problem is client↔server generation mismatch.

## Ask

1. **Paired publishes**: when a `@opencode-ai/client` build is published to a dist-tag, publish an `opencode-ai` CLI build of the same contract generation to the matching dist-tag (or gate the client publish on one existing).
2. Failing that, a **documented compatibility matrix**: which client builds speak to which CLI/server builds, and which dist-tags are expected to interoperate.
3. Expose a **contract-generation identifier** at runtime (e.g. in `health.get()`/`server.get()` or `/doc` `info.version`) so clients can fail fast with an actionable version-skew message instead of a route-level 4xx/`UnsupportedContentType`.

Raw captures for all of the above are available (spike artifacts cited inline) and we're happy to attach them.
