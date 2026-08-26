# OpenCode v2 beta — Stage-0 live-spike findings

**Date:** 2026-08-26
**Layered on:** `docs/opencode-sdk-v2-analysis.md` (§5 open questions). That document is unchanged; this one records what a live spike confirmed, refuted, or could not test.

## Test matrix (what we actually ran against)

| Component                             | Version                                                                                                                                                  | Role                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@opencode-ai/client`                 | `0.0.0-beta-18286` (exact devDependency pin)                                                                                                             | The typed v2 network client the analysis is based on                                                          |
| `opencode-ai` (dev channel CLI)       | `0.0.0-dev-202608261632` (exact devDependency pin, run via `./node_modules/.bin/opencode`)                                                               | Only _live server_ available; started with `serve --port 14096` in an XDG-isolated sandbox (`spike/sandbox/`) |
| `opencode-ai` (beta channel CLI)      | `0.0.0-beta-202608110357` (installed under `spike/beta-cli/`, not a repo devDependency)                                                                  | Checked for a better client match — same partial surface as dev, older                                        |
| `@opencode-ai/sdk` (v2 embedded host) | `0.0.0-beta-18286` (devDependency under the npm alias **`opencode-sdk-v2-beta`**, so the production `@opencode-ai/sdk@^1.18.11` dependency is untouched) | Only implementation whose route surface matches the beta client                                               |
| Global `opencode`                     | 1.18.23 — untouched, per brief                                                                                                                           | —                                                                                                             |

Isolation: all servers/hosts ran with `XDG_{DATA,STATE,CONFIG,CACHE}_HOME` pointed at `spike/sandbox/` (verified via `opencode debug paths`), with `auth.json`/`account.json` copied in so the `opencode` zen provider's free models work. Generations used free models only (`opencode/nemotron-3.5-lightning-free`, `opencode/muse-spark-1.2-contributor-free`, cost 0). The sandbox is gitignored (it contains credentials).

Scripts: `spike/*.mjs` (run with `node`, except `02`/`03` which need `bun` — see finding 0.3). Raw captures: `spike/artifacts/*.json`.

---

## Finding 0 — the headline: there is no coherent "v2 beta server" to target yet

This reframes every §5 question and is the most important stage-0 output.

### 0.1 No published CLI serves the API that `@opencode-ai/client@beta-18286` speaks

- The dev CLI (`202608261632`, same publish day as the client) serves a **51-route partial v2 surface** (`spike/artifacts/doc-openapi.json`, from `GET /doc`) plus the full v1 API (111 routes). Missing entirely: `/api/server`, `/api/config`, `/api/model/default`, `/api/generate`, `/api/experimental/migration/v1`, all `form.*`, all `session.inbox.*`, all `session.instructions.*`, `session.log`, `message.list`, fork/import/export/compact-v2, workspaces, vcs, websearch.
- The beta-channel CLI (`202608110357`) has the **same** 51-route surface (`spike/artifacts/doc-openapi-beta-cli.json`) — no better.
- Unknown v2 routes don't 404: the server returns the **SPA HTML with 200** (`spike/artifacts/00-probe.json`: `server.get`, `migration.v1.status`, `model.default`, `config.get` all fail as `ClientError{reason:"UnsupportedContentType"}`). A provider cannot distinguish "route not implemented on this build" from "wrong content type" without probing `/doc`.
- Even _shared_ routes have incompatible bodies. `session.prompt`: client-18286 sends a flat `{id,text,files,...}` body; the dev server requires `{prompt:{text,files,agents}, delivery?, resume?, id?}` and rejects the client's shape with `InvalidRequestError: Missing key at ["prompt"]` (`spike/artifacts/01-baseline-cycle.json`). Event names differ too: client types say `session.text.delta` / `session.execution.*` / `session.inbox.*`; the dev server emits **`session.next.text.delta`**, **`session.next.prompt.admitted`**, and has **no execution or inbox events at all** (`spike/artifacts/04-dev-full-cycle.json`).
- `Service.ensure`'s default spawn command `opencode serve --service` does not work: the dev CLI's `serve` has **no `--service` flag** (yargs prints help and exits). Plain `serve` does not write the registration file (`$XDG_STATE_HOME/opencode/service.json` stayed absent), so `Service.discover()` finds nothing.

### 0.2 The embedded host (`@opencode-ai/sdk@beta-18286`) matches the types but is itself half-broken

Route-for-route it matches the client, and `health.get`, `server.get` (`{urls:[]}`), `migration.v1.status`, `session.create/get`, `session.inbox.list` (`[]`), and `session.log` (yields the `log.synced` sentinel `{type:"log.synced", aggregateID, seq:0}`) all work (`spike/artifacts/02-embedded-smoke.json`, `03-embedded-structural.json`). But `model.list`, `model.default`, `provider.list`, `session.prompt`, `session.wait`, `session.instructions.entry.put/list`, and `form.create/list` **all return empty-body HTTP 500s**, with nothing emitted through the host's own log hook even at `trace` level. No generation is possible on the embedded host at this beta.

### 0.3 Beta packaging/DX landmines (verify before building on them)

- `@opencode-ai/sdk@beta-18286` ships **extensionless relative ESM imports** (`import ... from "./promise"`), which Node 24 cannot resolve (`ERR_MODULE_NOT_FOUND`). It only runs under Bun. The planned `./embedded` entrypoint cannot support Node users until upstream fixes packaging.
- `ClientError` carries **no response body** — only `reason` and (for `UnexpectedStatus`) `cause.status`. Every embedded-host 500 was undiagnosable through the public client. (We temporarily patched the vendored `node_modules/@opencode-ai/client/.../client.js` to capture bodies during the spike — they were empty anyway. The patch lives only in `node_modules`, not in the repo.)
- Aborting `event.subscribe`'s `RequestOptions.signal` makes the iterator **throw** `ClientError{reason:"Transport", cause: AbortError}` rather than end cleanly (`01-baseline-cycle.json` → `collectorDone`). Consumers must treat abort-Transport as normal shutdown.
- Validation errors are precise and useful: `InvalidRequestError{kind:"Payload"}` messages include a JSONPath-ish locator (`at ["prompt"]["text"]`).

**Consequence for v5 sequencing:** the §4 plan ("develop against the beta now") holds, but _behavioral_ code must currently be validated against the dev server's `session.next.*` contract, while _types_ come from beta-18286 — and those two disagree. The internal client-port facade (§4 step 2) is not optional; it is the only place these can be reconciled. Everything below states which backend produced the evidence.

---

## Q1 (§5.6) — file URI schemes: **answered (dev server)**

`spike/05-file-uris.mjs` sent an 8×8 PNG five ways to `opencode/muse-spark-1.2-contributor-free` (image-capable, free), one session each (`spike/artifacts/05-file-uris.json`):

| `files[].uri`                                    | Accepted at prompt? | Stored user message             | Model outcome                                                                                                           |
| ------------------------------------------------ | ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `data:image/png;base64,…`                        | yes                 | `{uri, mime:"image/png", name}` | **Succeeded** — assistant answered about the image                                                                      |
| `file:///abs/path.png`                           | yes                 | raw uri stored                  | **Turn failed**: `finish:"error"`, `error:{type:"unknown", message:"OpenAI Responses media must contain valid base64"}` |
| relative `red-square.png` (in session directory) | yes                 | raw uri stored                  | same failure                                                                                                            |
| absolute `/abs/path.png`                         | yes                 | raw uri stored                  | same failure                                                                                                            |
| `https://…/favicon.png`                          | yes                 | raw uri stored                  | same failure                                                                                                            |

- **Confirmed:** `data:` URIs are the one scheme that works end-to-end. The server does **no inbound validation** (every scheme is admitted and stored) and **no fetching/normalization** of `file:`/path/`https:` URIs — the raw URI string is handed to the model provider as media and fails there. MIME is inferred from the file name, not the content.
- **Refuted (for this build):** the analysis's hypothesis that "base64 normalization happens server-side" for non-data URIs. Stored `PromptFileAttachment.data` normalization was not observed; the stored message keeps `{uri, mime, name}` as sent.
- **v5 decision input:** the current provider's base64-data-URL path survives as-is. Keep `supportedUrls: {}` so the AI SDK downloads remote URLs to bytes and the provider re-encodes as `data:`; do not pass `file:`/`https:` URIs through. A failing attachment does not reject the prompt — it **fails the whole turn later**, so preflight validation in the provider is worth it.

## Q2 (§5.2) — `session.wait`: **unimplemented everywhere; behavior untestable**

- Dev server: route is declared in its OpenAPI but returns **503 `ServiceUnavailableError {message:"Session wait is not available yet", service:"session.wait"}`** (`04-dev-full-cycle.json`). Note: unavailability is signaled with the same typed error the analysis mapped as "retryable" — a provider retry loop on `ServiceUnavailableError` would spin forever here.
- Embedded host: empty 500 (`03-embedded-structural.json`).
- **Inconclusive** on resolve-vs-reject/pending-form semantics. v5 must not depend on `wait` as the primary completion signal; on the dev contract the only turn-completion signals are step events (see Q4/Q7 — there are no execution events on this build).

## Q3 (§5.3) — delivery/busy/steer/resume: **mostly answered (dev server)**

Evidence: `06-delivery-steer-queue.mjs`, `06b-steer-retry.mjs`, `06c-steer-midtext.mjs`, `08-interrupt-resume.mjs` + artifacts.

- **Default `delivery` is `"steer"`**: a prompt with `delivery` omitted comes back in the receipt (and in the stored inbox events) as `delivery:"steer"` (`04`, every receipt).
- **Receipt shape (dev)**: `{admittedSeq, id:"msg_…", sessionID, prompt, delivery, timeCreated}` — not the client's `SessionInboxUser {type:"user", payload}` shape. `admittedSeq` is a per-session monotone admission counter. Prompt `id` is server-generated with `msg_` prefix; the dev OpenAPI still constrains a caller-supplied `id` to `pattern: "^msg_"` (answers §5.5's prefix question for this build).
- **`steer` does _not_ abort the in-flight step.** With text actively streaming, the steered prompt is admitted (`session.next.prompt.admitted`) mid-stream, the running step completes normally (`finish:"stop"`, full text preserved), and only then is the steered prompt delivered (`session.next.prompted`) (`06c`). With a multi-step turn, steer supersedes the **remainder of the turn** at the step boundary: turn A's tool step completed (assistant message closed with `finish:"tool-calls"`), A's follow-up text step never ran, and B took over (`06b`). No `interrupted`/`superseded` event of any kind was emitted — the superseded turn's last assistant message just ends `tool-calls`.
- **`queue` works as expected**: admitted while busy, delivered after the current turn fully completes, then runs (`06`: story finished with `finish:"stop"`, then "MANGO" answered).
- **`SessionBusyError` was never observed** on the prompt path; the dev OpenAPI declares 409/busy only on v1 routes (`message delete`, `shell`, `revert`). On this build prompting a busy session always admits (steer or queue). The client types still declare 409 on prompt — treat busy-handling as required but untriggerable today.
- **`interrupt`**: `POST /api/session/{id}/interrupt {continue:false}` returns **204 with no body** (client-18286 expects `{interrupted: boolean}` — another contract gap). Mid-stream effect: `session.next.text.ended` → **`session.next.step.failed`**; the partial assistant message is kept with `finish:"error"`, `error:{type:"unknown", message:"Provider turn interrupted"}` (`08`). `{continue:true}` behaved identically within an 8s observation window (no continuation step started) — **inconclusive** what `continue` is for.
- **`resume: true`** after an interrupt behaved exactly like a normal new prompt (fresh full answer; nothing visibly resumed) — **inconclusive** what `resume` resumes.
- One caution: in the first steer attempt (`06`, steer sent during the model's slow pre-step latency, before any step started), the session **stalled** — turn A never started a step, prompt B was admitted but never delivered, and no assistant message was ever produced. Possible dev-build race when steering before `step.started`; a provider should not steer into a session that has not yet emitted `step.started` for the previous prompt.

## Q4 (§5.1) — inbox→execution correlation: **answered for this build (dev server)**

Full capture in `04-dev-full-cycle.json`:

```
session.next.prompt.admitted   {messageID: <receipt.id>, prompt, delivery}
session.next.prompted          {messageID: <receipt.id>, …}          ← delivery into execution
session.next.step.started      {assistantMessageID, agent, model, snapshot}
session.next.text.started/delta/ended {assistantMessageID, textID: "text-0"}
session.next.step.ended        {assistantMessageID, finish, cost, tokens}
```

- **The receipt `id` IS the stored user message id** (`message.list` shows the user message with exactly that id), and it appears on the `prompt.admitted`/`prompted` events. Correlation chain: `receipt.id` → `prompted(messageID)` → next `step.started(assistantMessageID)` on that session.
- **No shared key on step events** links `assistantMessageID` back to the triggering `messageID` — correlation is still _ordering-based_ between `prompted` and `step.started`. On an exclusively-owned session this is deterministic; on a shared session it remains heuristic. The analysis's exclusivity caveat stands, but `prompted` is a much better anchor than the beta types suggested (the beta client has **no** `session.next.prompt.admitted`/`prompted` equivalents — its `session.inbox.enqueued`/`delivered` events presumably play this role; untestable, see Finding 0.2).
- There are **no `session.execution.*` events and no `session.idle`** on the dev build. Turn completion must be inferred from `step.ended` + no subsequent `prompted`/`step.started` (or from message state).

## Q5 (§5.11) — `session.instructions.entry.put` as system-prompt vehicle: **inconclusive (unimplemented)**

No instructions routes exist on the dev server; on the embedded host `put`/`list` return empty 500s (`03-embedded-structural.json`). The §2.1 fallback (delimited prepend into first-turn text + warning) remains the only working per-request system strategy.

## Q6/Q13/Q14 (§5.13–14) — forms: **refuted as a near-term reality; questions are alive and well**

- The dev server has **no `form.*` routes at all**. It has `/api/question/request`, `/api/session/{id}/question`, `…/question/{requestID}/reply|reject` — and its schemas define both `QuestionInfo` (v1) and **`QuestionV2Info` {question, header, options, multiple, custom}** with `QuestionV2Reply {answers: label-array-of-arrays}` — i.e., **still positional answers, not keyed forms** (`doc-openapi.json`).
- On the embedded host, `form.create`/`form.list` 500 (`03-embedded-structural.json`), so the form lifecycle could not be exercised even there.
- **Verdict on §5.14:** the `Question` schema in the v2 contracts is _not_ dead code — questions are the only interactive-input mechanism actually served today. v5 should design `onForm` per the beta types but keep the adapter thin enough to also drive QuestionV2 (or wait for upstream to converge). Do not invest in deep form-field logic yet.

## Q7 (§5.15) — event stream mechanics: **answered**

- **`server.connected` is emitted immediately on subscribe** on both the dev server and the embedded host — it works as the readiness handshake the migration design wants (`01`, `02`).
- **Live-only, no replay**: a second subscription opened after a session was created received only `server.connected` and subsequent live events; nothing was replayed (`01-baseline-cycle.json` → `replayCheck`). On the beta types, catch-up is `session.log`'s job (works on embedded; absent on dev).
- The stream is server-global (no filter argument; TUI/other-session noise arrives too). The dev server additionally exposes `GET /api/session/{sessionID}/event` — a **per-session SSE stream** the beta client doesn't have; worth watching upstream.
- Aborting the subscribe signal tears down the iterator with `ClientError{reason:"Transport"}` (see 0.3). After abort the server continued to serve other requests normally (no session damage observed).

## Q8 (§5.7–8) — usage semantics and message granularity: **answered (dev server)**

`07-multistep-usage.mjs` ran one turn = write-tool step + text step (`07-multistep-usage.json`):

- **One turn produced TWO assistant messages — one per step.** Step 1: assistant msg A, `content:[tool]`, `finish:"tool-calls"`. Step 2: assistant msg B, `content:[text]`, `finish:"stop"`. This **refutes the analysis's working assumption** (§1.5) of a self-contained assistant message per turn: on this build `finish:"tool-calls"` on a _message_ is an intermediate artifact, and text/tool content of one turn is split across messages. A v5 reducer keyed only on one `assistantMessageID` per turn would drop content.
- **`step.ended.tokens` are per-step increments, not cumulative**: step 1 `{input:1447, output:30, reasoning:62, cache.read:2176}`, step 2 `{input:3681, output:16, reasoning:21, cache.read:0}` (step 2 input grew with context — not a running total; output did not accumulate). Each assistant message's `tokens` equals **its own step's** tokens exactly.
- **`input` excludes `cache.read`** (step 1: 1447 input vs 2176 cached read — disjoint counts), matching the provider's current summing assumption.
- **`SessionInfo.tokens` (cumulative) stayed all-zero** after a completed turn on the dev build — do not trust session totals yet.
- Tool events (dev): `tool.input.started {callID, name}` → `tool.input.delta {callID, delta}` → `tool.input.ended {callID, text}` → `tool.called {callID, tool, input, provider}` → `tool.success {callID, structured, content, outputPaths, provider}`. **No `executed` flag** (beta types have it; dev has `provider` instead), and the beta's tool-content array shape could not be verified live.
- No usage events of any kind were observed (neither `session.usage.updated` nor `.recorded`).

## Q9 (§5.18) — `migration.v1.status` on a fresh v2 server: **answered (embedded host)**

Returns **`{status: "completed"}`** on a fresh, never-migrated database (`02-embedded-smoke.json`). So "completed" cannot be read as "a migration ran"; it doubles as "nothing to migrate". The dev server doesn't route it at all (SPA HTML fallback → `UnsupportedContentType`). Preflight logic should treat only `required`/`running`/`error` as actionable and any `UnsupportedContentType`/404 as "not a beta-18286-contract server".

---

## What this changes in the §2 migration plan (deltas only)

1. **Facade first is mandatory** (already planned §4.2): live behavior today comes from a `session.next.*`/nested-prompt contract that no published client speaks. Isolate every route/event name in one module.
2. **Completion detection**: build finish-detection on step events _and_ execution events, feature-detected — dev has only steps, beta types only make execution events trustworthy. `session.wait` is a watchdog at best (and its unavailability arrives as retryable-looking `ServiceUnavailableError` — special-case `service:"session.wait"`).
3. **Files**: `data:`-URI-only is the safe contract (Q1). Keep `supportedUrls {}`; preflight/convert everything else; surface a warning for non-convertible URIs instead of letting the turn fail late.
4. **Multi-message turns**: the reducer and doGenerate assembly must aggregate **all** assistant messages between `prompted` and turn-end, not one message (Q8). Usage = sum of per-step tokens; ignore session totals.
5. **Steer caution**: never send a steer/interrupt before `step.started` has been observed for the in-flight prompt (stall risk, Q3); prefer `delivery:"queue"` as provider default (matches the analysis's recommendation — now also empirically the least surprising).
6. **Forms**: keep the `onForm` surface thin; a QuestionV2 adapter may be needed at GA (Q6).
7. **Embedded entrypoint**: blocked for Node users by upstream packaging (0.3); revisit after upstream fixes ESM extensions.
8. **`serve --service` / `Service.ensure`**: broken end-to-end today; the auto-start backend cannot be validated until a CLI ships the service flag and registration writing.

## Reproduction

```sh
# server (leave global opencode alone)
SBOX=$PWD/spike/sandbox
mkdir -p $SBOX/{data,state,config,cache} $SBOX/workdir
cp ~/.local/share/opencode/auth.json $SBOX/data/opencode/auth.json   # for zen free models
cd $SBOX/workdir && env XDG_DATA_HOME=$SBOX/data XDG_STATE_HOME=$SBOX/state \
  XDG_CONFIG_HOME=$SBOX/config XDG_CACHE_HOME=$SBOX/cache \
  ../../../node_modules/.bin/opencode serve --port 14096

# experiments (repo root; 02/03 need bun)
node spike/00-probe.mjs
node spike/01-baseline-cycle.mjs
bun  spike/02-embedded-smoke.mjs
bun  spike/03-embedded-structural.mjs
node spike/04-dev-full-cycle.mjs
node spike/05-file-uris.mjs
node spike/06-delivery-steer-queue.mjs && node spike/06b-steer-retry.mjs && node spike/06c-steer-midtext.mjs
node spike/07-multistep-usage.mjs
node spike/08-interrupt-resume.mjs
```
