# Stage 5 — Provider factory + backends (client manager)

## Goal

Complete the public network-mode API: `createOpencode()` provider factory and the backend layer that produces the client-port the stage-4 model consumes via its `getPort` seam. After this stage the package is usable end-to-end (against a fake or future-compatible server).

## Context (read first)

- `docs/opencode-sdk-v2-analysis.md` §2.2 (client-manager + provider entries: the six-backend disposition, ownership rules, cache-key identity, manager API dispositions), §2.1 ownership row, §4 (entrypoints).
- Stage-4 summary contract: the model takes `OpencodeLanguageModelConfig` with `getPort`, `provider`, `readinessTimeoutMs`, `approvalIdleTimeoutMs`; the port now includes `model.list`.
- `docs/v2-spike-findings.md`: `opencode serve --service` broken in all published binaries; `Service.discover()` returns undefined (no registration file) — auto-start/service paths must degrade with actionable errors, and `autoStart` stays default-false (stage-1 decision).

## Deliverables (commits prefixed `stage-5:`)

1. **`src/opencode-client-manager.ts`** (new shape): backends per the design doc —
   (a) caller-supplied client (never disposed by us);
   (b) caller-supplied manager (retyped injection);
   (c) `baseUrl` → `OpenCode.make({baseUrl, fetch?, headers})`;
   (d) connect-without-start → `Service.discover({file?, version?})`, clear failure when nothing registered;
   (e) auto-start → `Service.ensure({file?, version?, command?, env?, onStart})` + `Service.headers(endpoint)` merged under user headers;
   (f) embedded: NOT in this stage — export the seam so a later `./embedded` entrypoint can inject a port; document.
   Ownership: disposal aborts our subscriptions and closes nothing we didn't create; `Service.stop` only when the manager was configured with a dedicated registration `file` (owned mode) or via an explicit `stopService()` the user calls. Manager registry keyed on full effective identity (baseUrl/registration file + headers + fetch). `getServerUrl()`/`isServerManaged()` per the design doc's dispositions.
2. **Preflight**: on first port acquisition, `health.get()` (version logged; gate behind `version` predicate option) and `migration.v1.status()` (warn on `required`/`running`/`error`; never block). Both failures degrade to warnings for caller-supplied clients.
3. **`src/opencode-provider.ts`**: `createOpencode(settings)` returning the `ProviderV4` callable (languageModel/chat aliases, NoSuchModelError for embedding/image, `dispose()`, `getClientManager()`); wires `mergeSettings` → model config via `getPort`; default `opencode` instance export. Keep `OpencodeModels` shortcuts (refresh model ids only if obviously stale — no invention).
4. **`src/index.ts`**: final public surface for network mode (factory, provider/model types, settings, form/permission types, error guards, client-port type, manager). Nothing envelope/question-era.
5. **Tests**: backend selection matrix (all six paths incl. precedence + conflict warnings), ownership/disposal (never closes supplied clients; owned-file service stop only), header merge order (user > service > client defaults; per-call over all), preflight warning paths, registry identity (two configs differing only in headers get distinct managers), factory behavior (model instance caching semantics documented — one instance per conversation rule surfaced in JSDoc).
6. **Deferred-item ledger**: append stage-4's deferred items (wait watchdog, `session.log` catch-up, `inbox.list` delivery-uncertainty reconciliation, JSON validate/repair loop) plus anything you defer here to `docs/briefs/deferred.md` so stage 6 picks them up explicitly.

## Checks

`npm run ci` green; `npm run build` (tsup) must produce a loadable ESM artifact — add a smoke test that imports the built `dist/index.js` in a subprocess and constructs a provider with a fake client (packed-artifact realism without publishing).
