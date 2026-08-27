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

Scripts: `spike/*.mjs` (run with `node`, except `02`/`03`/`10`/`11` which need `bun` — see finding 0.3). Raw captures: `spike/artifacts/*.json`. Exact CLI versions are captured, not just inferred from install pins: `09-service-and-stream.json` records `--version` output for both CLIs (`0.0.0-dev-202608261632`, `0.0.0-beta-202608110357`); the `/doc` artifacts only report a generic `info.version: "1.0.0"`.

---

## Finding 0 — the headline: there is no coherent "v2 beta server" to target yet

This reframes every §5 question and is the most important stage-0 output.

### 0.1 No published CLI serves the API that `@opencode-ai/client@beta-18286` speaks

- The dev CLI (`202608261632`, same publish day as the client) serves a **51-route partial v2 surface** (`spike/artifacts/doc-openapi.json`, from `GET /doc`) plus the full v1 API (111 routes). Missing entirely: `/api/server`, `/api/config`, `/api/model/default`, `/api/generate`, `/api/experimental/migration/v1`, all `form.*`, all `session.inbox.*`, all `session.instructions.*`, `session.log`, v2 fork/import/export, workspaces-v2, vcs-v2, websearch. **Present** (correcting an earlier draft of this list): `message.list` — `/api/session/{sessionID}/message` (operationId `v2.session.messages`) returns the `{data, cursor}` envelope and is what `01` and every polling script use successfully — and `session.compact` — `/api/session/{sessionID}/compact` exists but is contract-incompatible: dev declares/returns **204 no-content** where client-18286 expects a `SessionInboxCompaction` receipt body.
- The beta-channel CLI (`202608110357`) has the **same** 51-route surface (`spike/artifacts/doc-openapi-beta-cli.json`) — no better.
- Unknown v2 routes don't 404: the server returns the **SPA HTML with 200** (`spike/artifacts/00-probe.json`: `server.get`, `migration.v1.status`, `model.default`, `config.get` all fail as `ClientError{reason:"UnsupportedContentType"}`). A provider cannot distinguish "route not implemented on this build" from "wrong content type" without probing `/doc`.
- Even _shared_ routes have incompatible bodies. `session.prompt`: client-18286 sends a flat `{id,text,files,...}` body; the dev server requires `{prompt:{text,files,agents}, delivery?, resume?, id?}` and rejects the client's shape with `InvalidRequestError: Missing key at ["prompt"]` (`spike/artifacts/01-baseline-cycle.json`). Event names differ too: client types say `session.text.delta` / `session.execution.*` / `session.inbox.*`; the dev server emits **`session.next.text.delta`**, **`session.next.prompt.admitted`**, and has **no execution or inbox events at all** (`spike/artifacts/04-dev-full-cycle.json`).
- `Service.ensure`'s default spawn command `opencode serve --service` does not work: the dev CLI's `serve` has **no `--service` flag** (exit 1, yargs prints the `serve` help; `--help` confirms the flag list). Plain `serve` does not write the registration file (`$XDG_STATE_HOME/opencode/service.json` absent while the :14096 server was live), so `Service.discover()` returns `undefined`. All three captured in `spike/artifacts/09-service-and-stream.json` (`serveService`, `serveHelp`, `registrationFile`, `discover`).

### 0.2 The embedded host (`@opencode-ai/sdk@beta-18286`) matches the types but is itself half-broken

Route-for-route it matches the client, and `health.get`, `server.get` (`{urls:[]}`), `migration.v1.status`, `session.create/get`, `session.inbox.list` (`[]`), and `session.log` (yields the `log.synced` sentinel `{type:"log.synced", aggregateID, seq:0}`) all work (`spike/artifacts/02-embedded-smoke.json`, `03-embedded-structural.json`). But `model.list`, `model.default`, `provider.list`, `session.prompt`, `session.wait`, `session.instructions.entry.put/list`, and `form.create/list` **all return empty-body HTTP 500s** (`03-embedded-structural.json`; `provider.list`, `model.list`, and `session.prompt` re-witnessed with `cause: {status: 500, body: ""}` in `10-embedded-gaps.json`). The host's `log.emit` hook at level `trace` does work — it emits lifecycle entries (`database schema bootstrap`, `spawning process`, all `info`) — but **nothing at all is logged for the failing calls** (`10-embedded-gaps.json` → `logEntries`), so the 500s are undiagnosable from the outside. No generation is possible on the embedded host at this beta.

### 0.3 Beta packaging/DX landmines (verify before building on them)

- `@opencode-ai/sdk@beta-18286` ships **extensionless relative ESM imports** (`import ... from "./promise"`), which Node 24 cannot resolve (`ERR_MODULE_NOT_FOUND`). It only runs under Bun. The planned `./embedded` entrypoint cannot support Node users until upstream fixes packaging.
- `ClientError` carries **no response body** — only `reason` and (for `UnexpectedStatus`) `cause.status`. Every embedded-host 500 was undiagnosable through the public client. (We temporarily patched the vendored `node_modules/@opencode-ai/client/.../client.js` to capture bodies during the spike — they were empty anyway. The patch lives only in `node_modules`, not in the repo.)
- Aborting `event.subscribe`'s `RequestOptions.signal` makes the iterator **throw** `ClientError{reason:"Transport", cause: AbortError}` rather than end cleanly (`01-baseline-cycle.json` → `collectorDone`). Consumers must treat abort-Transport as normal shutdown.
- Validation errors are precise and useful: `InvalidRequestError{kind:"Payload"}` messages include a JSONPath-ish locator (`at ["prompt"]["text"]`).

**Consequence for v5 sequencing:** the §4 plan ("develop against the beta now") holds, but _behavioral_ code must currently be validated against the dev server's `session.next.*` contract, while _types_ come from beta-18286 — and those two disagree. The internal client-port facade (§4 step 2) is not optional; it is the only place these can be reconciled. Everything below states which backend produced the evidence.

---

## Q1 (§5.6) — file URI schemes: **answered (dev server, two zen adapters)**

`spike/05-file-uris.mjs` sent an 8×8 red PNG five ways to `opencode/muse-spark-1.2-contributor-free` (image-capable, free), one session each (`spike/artifacts/05-file-uris.json`); `spike/05b-file-uris-controls.mjs` (`05b-file-uris-controls.json`) added the controls a review pass demanded — ingestion verification, a second model/adapter, and MIME-provenance cases:

| `files[].uri`                                    | Accepted at prompt? | Stored user message             | Model outcome                                                                                                           |
| ------------------------------------------------ | ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `data:image/png;base64,…`                        | yes                 | `{uri, mime:"image/png", name}` | **Succeeded** — see ingestion note below                                                                                |
| `file:///abs/path.png`                           | yes                 | raw uri stored                  | **Turn failed**: `finish:"error"`, `error:{type:"unknown", message:"OpenAI Responses media must contain valid base64"}` |
| relative `red-square.png` (in session directory) | yes                 | raw uri stored                  | same failure                                                                                                            |
| absolute `/abs/path.png`                         | yes                 | raw uri stored                  | same failure                                                                                                            |
| `https://…/favicon.png`                          | yes                 | raw uri stored                  | same failure                                                                                                            |

- **Ingestion is real, not just request completion.** The original 8×8 `data:` run "succeeded" but answered "White" for a red PNG — completion-only evidence. Controls (`05b`): with a 64×64 solid-red PNG via `data:`, **both** `muse-spark-1.2` and `mimo-v2.5-free` answered **"Red"**; a no-attachment baseline on the same model+prompt instead replied that no image came through. So `data:` media genuinely reaches the model; tiny 8×8 images just get misread.
- **Non-`data:` rejection is not one adapter, but is also not proven universal.** muse-spark fails via an "OpenAI Responses" adapter; `mimo-v2.5-free` fails identically via an "OpenAI **Chat**" adapter (`error: "OpenAI Chat media must contain valid base64"`, `05b` → `mimo-file-uri`). Two distinct zen adapters both receive the raw URI and reject it; per-provider error shape will vary.
- **Confirmed:** `data:` URIs are the one scheme that works end-to-end. The server does **no inbound validation** (every scheme is admitted and stored) and **no fetching/normalization** of `file:`/path/`https:` URIs — the raw URI string is handed to the model provider as media and fails there.
- **MIME provenance (corrected — the first draft claimed name-derived):** for `data:` URIs the stored `mime` comes from the **URI's declared mediatype, not the file name**: `data:application/octet-stream;…` named `red-square.png` stored `mime:"application/octet-stream"` and then failed with "OpenAI Responses does not support media type application/octet-stream"; `data:image/png` named `red-square.jpg` or extensionless `attachment` stored `image/png` and succeeded (`05b` → `mime-*` cases). Content sniffing is ruled out for `data:` (the octet-stream payload was a valid PNG). For `file:`/path/`https:` URIs the stored `mime` was `image/png` but every uri **and** name ended `.png`, so name-vs-uri-extension attribution there remains untested — moot for v5 since only `data:` works.
- **Refuted (for this build):** the analysis's hypothesis that "base64 normalization happens server-side" for non-data URIs. Stored `PromptFileAttachment.data` normalization was not observed; the stored message keeps `{uri, mime, name}` as sent.
- **v5 decision input:** the current provider's base64-data-URL path survives as-is. Keep `supportedUrls: {}` so the AI SDK downloads remote URLs to bytes and the provider re-encodes as `data:` **with a correct mediatype in the data URI** (the URI mediatype is what the server trusts); do not pass `file:`/`https:` URIs through. A failing attachment does not reject the prompt — it **fails the whole turn later**, so preflight validation in the provider is worth it.

## Q2 (§5.2) — `session.wait`: **unimplemented everywhere; behavior untestable**

- Dev server: route is declared in its OpenAPI but returns **503 `ServiceUnavailableError {message:"Session wait is not available yet", service:"session.wait"}`** (`04-dev-full-cycle.json`). Note: unavailability is signaled with the same typed error the analysis mapped as "retryable" — a provider retry loop on `ServiceUnavailableError` would spin forever here.
- Embedded host: empty 500 (`03-embedded-structural.json`).
- **Inconclusive** on resolve-vs-reject/pending-form semantics. v5 must not depend on `wait` as the primary completion signal; on the dev contract the only turn-completion signals **we observed** are step events (see Q4/Q7 — no execution events on this build; `session.idle` is declared in the dev OpenAPI event union but never fired in our cycles).

## Q3 (§5.3) — delivery/busy/steer/resume: **mostly answered (dev server)**

Evidence: `06-delivery-steer-queue.mjs`, `06b-steer-retry.mjs`, `06c-steer-midtext.mjs`, `08-interrupt-resume.mjs` + artifacts.

- **Default `delivery` is `"steer"`**: a prompt with `delivery` omitted comes back in the receipt (and in the stored inbox events) as `delivery:"steer"` (`04`, every receipt).
- **Receipt shape (dev)**: `{admittedSeq, id:"msg_…", sessionID, prompt, delivery, timeCreated}` — not the client's `SessionInboxUser {type:"user", payload}` shape. `admittedSeq` is a per-session monotone admission counter. Prompt `id` is server-generated with `msg_` prefix; the dev OpenAPI still constrains a caller-supplied `id` to `pattern: "^msg_"` (answers §5.5's prefix question for this build).
- **`steer` does _not_ abort the in-flight step.** With text actively streaming, the steered prompt is admitted (`session.next.prompt.admitted`) mid-stream, the running step completes normally (`finish:"stop"`, full text preserved), and only then is the steered prompt delivered (`session.next.prompted`) (`06c`). With a multi-step turn, steer supersedes the **remainder of the turn** at the step boundary: turn A's tool step completed (assistant message closed with `finish:"tool-calls"`), A's follow-up text step never ran, and B took over (`06b`). No `interrupted`/`superseded` event of any kind was emitted — the superseded turn's last assistant message just ends `tool-calls`.
- **`queue` works as expected**: admitted while busy, delivered after the current turn fully completes, then runs (`06`: story finished with `finish:"stop"`, then "MANGO" answered).
- **`SessionBusyError` was never observed** on the prompt path. The dev OpenAPI **does declare 409 `ConflictError` on `v2.session.prompt` itself** (plus v1 `message delete`/`shell`/`revert`/`unrevert`) — a first draft of this doc wrongly said v1-only — but on this build prompting a busy session always admits (steer or queue); the 409 never fired. Treat busy-handling as required but untriggerable today.
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
- There are **no `session.execution.*` events** on the dev build (absent from its OpenAPI event union too). `EventSessionIdle`/`session.idle` **is declared** in the dev OpenAPI union but was never emitted in any captured cycle (`01`, `04`, `06*`, `07`, `08`) — treat idle as declared-but-unobserved, not nonexistent. In practice turn completion must be inferred from `step.ended` + no subsequent `prompted`/`step.started` (or from message state), with idle as a bonus signal if it ever fires.

## Q5 (§5.11) — `session.instructions.entry.put` as system-prompt vehicle: **inconclusive (unimplemented)**

No instructions routes exist on the dev server; on the embedded host `put`/`list` return empty 500s (`03-embedded-structural.json`). The §2.1 fallback (delimited prepend into first-turn text + warning) remains the only working per-request system strategy.

## Q6/Q13/Q14 (§5.13–14) — forms: **inconclusive (unexercisable on any available backend); questions are alive and well**

- The dev server has **no `form.*` routes at all**. It has `/api/question/request`, `/api/session/{id}/question`, `…/question/{requestID}/reply|reject` — and its schemas define both `QuestionInfo` (v1) and **`QuestionV2Info` {question, header, options, multiple, custom}** with `QuestionV2Reply {answers: label-array-of-arrays}` — i.e., **still positional answers, not keyed forms** (`doc-openapi.json`).
- On the embedded host, `form.create`/`form.list` 500 (`03-embedded-structural.json`), so the form lifecycle could not be exercised even there. The brief's actual behavioral questions — does execution block on a pending form, what does `form.cancel` do to the turn — therefore remain **untested**; nothing here refutes the beta Forms design itself.
- **Verdict on §5.14:** the `Question` schema in the v2 contracts is _not_ dead code — questions are the only interactive-input mechanism actually served today, and the dev server's `QuestionV2` is a **different contract** from beta Forms, not evidence about Forms. v5 should design `onForm` per the beta types but keep the adapter thin enough to also drive QuestionV2 (a compatibility hypothesis until either surface is live end-to-end). Do not invest in deep form-field logic yet.

## Q7 (§5.15) — event stream mechanics: **answered**

- **`server.connected` is emitted immediately on subscribe** on both the dev server and the embedded host — it works as the readiness handshake the migration design wants (`01`, `02`).
- **Live-only, no replay**: a second subscription opened after a session was created received only `server.connected` and subsequent live events; nothing was replayed (`01-baseline-cycle.json` → `replayCheck`). On the beta types, catch-up is `session.log`'s job (works on embedded; absent on dev).
- The stream is server-global (no filter argument; TUI/other-session noise arrives too). The dev server additionally exposes `GET /api/session/{sessionID}/event` — a **per-session SSE stream** the beta client doesn't have; worth watching upstream.
- The brief asked about **breaking the `for await` loop**; the `01` test actually exercised the **abort-signal** path (`collector.stop()` calls `AbortController.abort()`), which tears down the iterator with `ClientError{reason:"Transport"}` (see 0.3). The plain-`break` path was captured separately: consume one event, `break` with no signal — the loop exits in ~20 ms, the process ends without leaked handles, and the server stays healthy (`/api/health` 200 immediately after) (`09-service-and-stream.json` → `loopBreak`). After either teardown the server continued to serve other requests normally (no session damage observed).

## Q8 (§5.7–8) — usage semantics and message granularity: **answered (dev server)**

`07-multistep-usage.mjs` ran one turn = write-tool step + text step (`07-multistep-usage.json`):

- **One turn produced TWO assistant messages — one per step.** Step 1: assistant msg A, `content:[tool]`, `finish:"tool-calls"`. Step 2: assistant msg B, `content:[text]`, `finish:"stop"`. This **refutes the analysis's working assumption** (§1.5) of a self-contained assistant message per turn: on this build `finish:"tool-calls"` on a _message_ is an intermediate artifact, and text/tool content of one turn is split across messages. A v5 reducer keyed only on one `assistantMessageID` per turn would drop content.
- **`step.ended.tokens` are per-step increments, not cumulative**: step 1 `{input:1447, output:30, reasoning:62, cache.read:2176}`, step 2 `{input:3681, output:16, reasoning:21, cache.read:0}` (step 2 input grew with context — not a running total; output did not accumulate). Each assistant message's `tokens` equals **its own step's** tokens exactly.
- **`input` excludes `cache.read`** (step 1: 1447 input vs 2176 cached read — disjoint counts), matching the provider's current summing assumption.
- **`SessionInfo.tokens` (cumulative) stayed all-zero** after a completed turn on the dev build — do not trust session totals yet.
- Tool events (dev): `tool.input.started {callID, name}` → `tool.input.delta {callID, delta}` → `tool.input.ended {callID, text}` → `tool.called {callID, tool, input, provider}` → `tool.success {callID, structured, content, outputPaths, provider}`. **No `executed` flag** (beta types have it; dev has `provider` instead), and the beta's tool-content array shape could not be verified live.
- No usage events of any kind were observed (neither `session.usage.updated` nor `.recorded`).

## Q9 (§5.18) — `migration.v1.status` on a fresh v2 server: **answered (embedded host)**

Returns **`{status: "completed"}`** on a demonstrably fresh, never-migrated store: `spike/11-migration-fresh.mjs` wipes and recreates dedicated XDG homes (`spike/sandbox/fresh-migration/`, `preexistingEntries` captured as empty) before creating the embedded host (`11-migration-fresh.json`). The earlier `02-embedded-smoke.json` run had reported the same value but against the reused `spike/sandbox` homes (which had already hosted CLI checks), so it only established "completed on an isolated store", not "fresh". Conclusion (now properly grounded): "completed" cannot be read as "a migration ran"; it doubles as "nothing to migrate". The dev server doesn't route it at all (SPA HTML fallback → `UnsupportedContentType`). Preflight logic should treat only `required`/`running`/`error` as actionable and any `UnsupportedContentType`/404 as "not a beta-18286-contract server".

---

## What this changes in the §2 migration plan (deltas only)

1. **Facade first is mandatory** (already planned §4.2): live behavior today comes from a `session.next.*`/nested-prompt contract that no published client speaks. Isolate every route/event name in one module.
2. **Completion detection**: build finish-detection on step events _and_ execution events, feature-detected — dev emitted only steps in our cycles (its OpenAPI also declares `session.idle`, never observed — treat as bonus, not primary), beta types only make execution events trustworthy. `session.wait` is a watchdog at best (and its unavailability arrives as retryable-looking `ServiceUnavailableError` — special-case `service:"session.wait"`).
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
node spike/05-file-uris.mjs && node spike/05b-file-uris-controls.mjs
node spike/06-delivery-steer-queue.mjs && node spike/06b-steer-retry.mjs && node spike/06c-steer-midtext.mjs
node spike/07-multistep-usage.mjs
node spike/08-interrupt-resume.mjs
node spike/09-service-and-stream.mjs   # needs the :14096 server up
bun  spike/10-embedded-gaps.mjs
bun  spike/11-migration-fresh.mjs
```

---

# Beta-source server verification (stage 6)

**Date:** 2026-08-26
**Server:** `anomalyco/opencode` branch `beta` **built from source** at commit
`f4a9b930` (the commit matching our pinned `@opencode-ai/client@0.0.0-beta-18286`),
run via `bun run --cwd packages/cli --conditions=browser src/index.ts serve`
with isolated XDG homes, a fake HOME (`HOME` + `OPENCODE_TEST_HOME`), a
minimal allowlisted environment, and a tmp-rooted sandbox workdir
(`$TMPDIR/opencode-beta-sandbox`). The sandbox must live outside the real
home: the server's config discovery walks upward from the session directory
to the filesystem root looking for `.opencode`/`.claude`/`.agents`, and loads
`$HOME/.claude` + `$HOME/.agents` directly, so both a fake home and a
home-free workdir ancestry are required for isolation.
This is the first live server that actually speaks the pinned client's
contract — every stage-0 answer that came from the mismatched dev CLI is
re-examined below. Evidence: `spike/artifacts/12-beta-src-verification.json`,
`spike/artifacts/12b-beta-src-file-uris.json` (both artifacts embed a
`provenance` block binding the capture to source commit `f4a9b930`, the
serve build's health `{version, pid}`, and pinned client
`0.0.0-beta-18286`), and the gated integration suite
(`npm run test:integration`), which passes 11/11 against this server
(round-trip incl. doGenerate reconciliation and session pinning, abort
pre/post delivery, busy+queue, `data:` attach, a real two-phase approval
round-trip, contract snapshot, service backend; stage 7 adds the
wait-watchdog and steer-supersession experiments — see the stage-7
addendum below).

Headline: **the beta-source server speaks the pinned contract verbatim** —
flat `session.prompt` bodies, `session.inbox.*`/`session.execution.*`/
`session.text.delta` event names, form/inbox/log routes present, Basic-auth
password required on every route (`OPENCODE_PASSWORD`; the harness generates
one and sends `Authorization: Basic opencode:<pw>`). The dev CLI's
`session.next.*` contract is a different, older generation and is now dead to
this provider.

## Verdict table

| Stage-0 finding (dev-CLI evidence)                                        | Beta-source verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Shipped default affected?                                                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server default `delivery` is `"steer"` when omitted                       | **Confirmed** — receipt and stored inbox item say `delivery:"steer"` (`12` → `simpleTurn`)                                                                                                                                                                                                                                                                                                                                                                                                                                             | No — provider keeps sending explicit `"queue"`                                                                                                                                     |
| Busy prompt never 409s (`SessionBusyError` untriggerable)                 | **Confirmed** — prompting a busy session with delivery omitted (admitted as steer) or `queue` always succeeds; no `ConflictError`/`SessionBusyError` observed (`12` → `busy`, integration `busy-queue.test.ts`)                                                                                                                                                                                                                                                                                                                        | No — busy-retry path stays as defensive code                                                                                                                                       |
| Receipt `id` = stored user message id; correlation is ordering-based      | **Confirmed** — `receipt.id` is the stored user message id; `step.started` payloads carry only `{sessionID, assistantMessageID, agent, model}` — still no key linking back to the inbox id (`12` → `simpleTurn.events`)                                                                                                                                                                                                                                                                                                                | No — exclusive-session caveat stands                                                                                                                                               |
| `session.wait` unimplemented (503/500)                                    | **Changed** — implemented: resolves ~instantly on an idle session; on a busy long turn (execution confirmed started before the call) it resolved **within event-stream latency of `session.execution.succeeded`** (two captures: 8317 ms vs 8320 ms, 21229 ms vs 21229 ms) — i.e. it tracks turn completion on this build. An earlier capture suggesting mid-turn resolution (~2.8 s) had no terminal-event correlation and was a measurement artifact (`12` → `waitIdle`, `waitBusy.waitResolvedDeltaMs`/`executionSucceededDeltaMs`) | No shipped change (wait was never wired in); the deferred watchdog may use `wait` as a completion backstop, but its semantics under steer/queue/error paths stay unpinned upstream |
| `server.connected` emitted immediately on subscribe; live-only, no replay | **Confirmed** (`12` → `serverConnected`; readiness handshake works in every integration test)                                                                                                                                                                                                                                                                                                                                                                                                                                          | No                                                                                                                                                                                 |
| One turn = one assistant message refuted; per-step token increments       | **Confirmed** — a bash-tool turn produced 2 assistant messages (`finish:"tool-calls"` then `"stop"`), each carrying exactly its own step's tokens (`12` → `multiStep`)                                                                                                                                                                                                                                                                                                                                                                 | No — reducer already aggregates all messages of a turn                                                                                                                             |
| `SessionInfo.tokens` cumulative stays all-zero                            | **Changed** — now populated and cumulative across the session (12220/33/88 after two steps of 6061+6159/24+9/47+41); `session.usage.updated` events fire and are **cumulative session totals**, not per-turn deltas (`12` → `multiStep.usage`)                                                                                                                                                                                                                                                                                         | No — provider sums per-step `step.ended` tokens, which remains the correct per-turn number                                                                                         |
| `interrupt` returns 204/no body (contract gap vs client)                  | **Fixed upstream** — returns `{interrupted: true}` exactly as the client types expect; emits `session.execution.interrupted`; the partial assistant message keeps `finish:"error"` with `error:{type:"aborted", message:"Step interrupted"}` (`12` → `interrupt`)                                                                                                                                                                                                                                                                      | No — provider already handles `execution.interrupted` and structured `aborted` errors                                                                                              |
| Steer does not abort the in-flight step                                   | **Confirmed** (single-step case) — with text streaming, the steered prompt was admitted mid-turn, the running turn completed fully (`finish:"stop"`, full story), then the steered prompt ran (`12` → `busy`). Multi-step supersession re-tested stage 7: **refuted** — the turn runs to completion; see the stage-7 addendum below (`13-steer-supersede.json`)                                                                                                                                                                        | No                                                                                                                                                                                 |
| Files: `data:` only; server stores any URI raw, no validation/fetching    | **Refuted for beta** — the server now validates and ingests attachments at prompt time: `data:` works (stored `source:{type:"inline"}`); **readable `file:` URIs are read server-side** and normalized to base64+mime (model answered "Red"); unreadable `file:`, `https:`, and relative paths **reject the prompt** with a typed message instead of failing the turn later (`12b`)                                                                                                                                                    | No — converting everything to `data:` (`supportedUrls: {}`) remains correct and transport-independent; see deferred ledger for the optional `file:` passthrough                    |
| `migration.v1.status` = "completed" doubles as "nothing to migrate"       | **Consistent** — "completed" on the (used, never-migrated) harness store (`12` → `migration`)                                                                                                                                                                                                                                                                                                                                                                                                                                          | No                                                                                                                                                                                 |
| `session.log` works (embedded host yielded the `log.synced` sentinel)     | **Changed nuance** — the route works but yields **only** the `log.synced` sentinel (with the session's latest `seq`) even with `after: 0` on a session holding 16 durable events; historical item replay is unimplemented (`12` → `sessionLog`)                                                                                                                                                                                                                                                                                        | No shipped change (log catch-up was deferred); SSE-drop recovery must keep using the message store, not the durable log                                                            |
| Abort of `event.subscribe` throws `ClientError{reason:"Transport"}`       | **Confirmed** — same teardown behavior on the beta server (every integration run)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No                                                                                                                                                                                 |

New beta-only observations:

- **Auth is mandatory**: every route (including `/api/health`) is behind Basic
  auth `opencode:<password>`. In `serve` (default mode) the password comes from
  `OPENCODE_PASSWORD` or is generated and printed; in `--service` mode it is
  persisted into the service registration. Providers hitting a beta server via
  `baseUrl` need `clientOptions.headers.Authorization`.
- **Permissions work end-to-end**: with `OPENCODE_CONFIG_CONTENT=
'{"permission":{"bash":"ask"}}'` a bash tool call emits a real
  `permission.asked`, execution blocks, `permission.reply` (`"once"`) resumes
  it. The provider's two-phase approval flow passes against this live server
  (`integration/approval.test.ts`).
- **OpenAPI lives at `/openapi.json`** (`GET /doc` 500s); the document
  carries 112 paths / 133 operations, and every operation the pinned client
  generation speaks (130 method+path pairs over 110 unique paths) is present
  at commit `f4a9b930` (integration `contract.test.ts` asserts
  client-operations ⊆ server-spec with segment-wise template matching, and
  reports server-only operations per method). The event payload union is
  **not** described in the spec — `data` is an opaque `V2EventEncoded` JSON
  string, so event-name compatibility cannot be checked from the document.
- **`session.prompt` has no `model` field** on this contract: model is session
  state (`session.create`'s `model: {id, providerID}` or `switchModel`), which
  matches the provider's session-establishment design.
- `session.idle` was never observed (the `execution.*` terminal events are
  authoritative), and the reasoning stream is extremely chatty
  (`reasoning.started`/`ended` pairs per token burst) — the reducer's
  tolerant handling absorbs both.
- **`serve --service` works** (stage-0 finding 0.1 refuted for the beta
  source): the flag exists, the server writes a channel-suffixed
  registration (`$XDG_STATE_HOME/opencode/service-local.json` for the
  from-source "local" channel) containing `{id, version, url, pid,
password}`, and `Service.discover({file})` resolves it — including the
  Basic-auth credential the provider's manager merges automatically. The
  full provider service-discovery backend generates end-to-end against it
  (`integration/service-backend.test.ts`). Caveats: the registration's
  `version` is the literal string `"local"` on source builds (a semver
  `service.version` predicate would reject it), and `--service` binds a
  fixed per-channel default port unless the service config
  (`$XDG_CONFIG_HOME/opencode/service-<channel>.json` → `{port}`) overrides
  it. Published CLIs still lack a working `--service`, so the provider's
  `autoStart: false` default stands.

## Stage-7 addendum — steer multi-step supersession (deferred-ledger #10)

Evidence: `spike/artifacts/13-steer-supersede.json` (two independent live
runs, fresh server + sandbox each, source commit `f4a9b930`, pinned client
`0.0.0-beta-18286`, model `opencode/nemotron-3.5-lightning-free`), captured
by `integration/steer-supersede.test.ts`: a multi-step bash turn (sleep-
widened first step) is steered after the first tool call is observed
in-flight.

Verdict — **stage-0's dev-CLI supersession finding is refuted for the
beta source**:

- **The remainder of the turn is NOT dropped.** All three steps ran to
  completion in both runs (both bash steps' markers plus the final
  `ALL-STEPS-DONE` text; assistant messages finished
  `tool-calls`/`tool-calls`/`stop`), and the single execution ended with
  `session.execution.succeeded`.
- **No superseded event exists on this path** (consistent with stage-0's
  "no event" half): `session.execution.interrupted` never fired, with any
  reason.
- **Steer is mid-turn context injection, not turn replacement.** The
  steered prompt was admitted (`delivery:"steer"`), `session.inbox.
delivered` fired for it mid-turn, and the pending inbox was empty
  afterward — but **no separate execution ever started for it and no
  assistant message answered it**. Whether the model honors the injected
  instruction is model behavior; this model ignored it and finished its
  original plan in both runs.
- **Honest failure record:** the first draft of the experiment asserted
  "the steered prompt is eventually answered" — believed to hold under
  either supersession semantics — and failed by 240 s timeout against the
  live server, twice. That assumption is what the capture refuted (there
  is no dedicated answer by design on this build); the committed test
  asserts the delivery-level structure the server actually guarantees
  (steered item delivered — no inbox stall, turn reaches a terminal) and
  records `steeredAnswered` as evidence rather than asserting it.

Provider impact: none shipped — the provider's exclusive-session contract
never steers into a busy session, and it keeps sending explicit
`delivery:"queue"`. Any future steer-dependent feature must treat steer as
context injection with no supersession and no dedicated answer.

## Reproduction

```sh
# harness (idempotent clone+install+serve, isolated XDG homes + fake HOME):
npm run test:integration
# or manually (env -i + fake HOME/OPENCODE_TEST_HOME + tmp sandbox are all
# required for isolation from real user configuration):
SBOX=$TMPDIR/opencode-beta-sandbox
mkdir -p $SBOX/{data,state,config,cache,home,workdir}
cd $SBOX/workdir && env -i PATH="$PATH" HOME=$SBOX/home \
  OPENCODE_TEST_HOME=$SBOX/home TMPDIR=$TMPDIR \
  XDG_DATA_HOME=$SBOX/data XDG_STATE_HOME=$SBOX/state \
  XDG_CONFIG_HOME=$SBOX/config XDG_CACHE_HOME=$SBOX/cache \
  OPENCODE_PASSWORD=pw OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}' \
  bun run --cwd ~/.cache/opencode-beta-src/packages/cli --conditions=browser \
    src/index.ts serve --port 14196

BETA_SRC_URL=http://127.0.0.1:14196 BETA_SRC_PASSWORD=pw \
  BETA_SRC_WORKDIR=$TMPDIR/opencode-beta-sandbox/workdir \
  BETA_SRC_DIR=$HOME/.cache/opencode-beta-src \
  node spike/12-beta-src-verification.mjs
# same env:
node spike/12b-beta-src-file-uris.mjs
```

## Stage-8 addendum — model-catalog contamination (deferred-ledger #7)

The stage-8 model-shortcut refresh read `model.list` off the isolated
beta-source harness and shipped everything it returned. Two of the eight
IDs — `ollama/glm-5.2:cloud` and `ollama/kimi-k3:cloud` — were **artifacts
of the capture host**, not of the OpenCode catalog. Removed in the stage-8
fix phase.

**Why the harness's isolation did not catch it.** The harness allowlists a
minimal environment and redirects `HOME`/`XDG_*` into a sandbox (see
`integration/harness/beta-server.ts`), which blocks _file-based_ config
leaks. It cannot block a **localhost HTTP** channel. The pinned beta source
ships a built-in ollama provider plugin
(`packages/core/src/plugin/provider/ollama.ts` @ `f4a9b930`) that, with no
configuration at all, polls `http://127.0.0.1:11434/api/tags` every 30 s
and writes every model the local daemon reports into the catalog under
providerID `ollama`, keeping the daemon's tag verbatim as the model ID.
This machine's ollama daemon serves exactly `kimi-k3:cloud` and
`glm-5.2:cloud`.

**Control experiment (decisive).** Same sandbox, same source build, same
copied zen auth — only `providers.ollama.settings.baseURL` redirected to a
dead port via `OPENCODE_CONFIG_CONTENT`, so the local daemon is
unreachable:

| Run                       | Catalog providers                     |
| ------------------------- | ------------------------------------- |
| Harness as shipped        | `opencode` ×6, **`ollama` ×2**        |
| Ollama origin → dead port | `opencode` ×6, **no ollama provider** |

The two IDs vanish entirely. They exist only for a host running that
daemon with those exact tags pulled.

**Corroborating catalog evidence.** Neither the models-dev snapshot
bundled in the pinned source
(`packages/core/src/models-dev/snapshot.txt`) nor the live
`https://models.dev/api.json` contains a plain `ollama` provider at all.
Both name the cloud provider **`ollama-cloud`**, with **unsuffixed** model
IDs (`glm-5.2`, `kimi-k3`). So a genuine catalog entry would read
`ollama-cloud/glm-5.2` — never `ollama/glm-5.2:cloud`.

**A second, distinct leak, also excluded.** `ollama-cloud` is env-gated on
`OLLAMA_API_KEY` in models.dev. The stage-0 probe
(`spike/artifacts/00-probe.json`) captured 20 `ollama-cloud/*` models —
the full models.dev roster — because that probe ran from a shell exporting
`OLLAMA_API_KEY`. The integration harness's env allowlist does not forward
it, which is why the harness catalog shows no `ollama-cloud`. So neither
`ollama/*` nor `ollama-cloud/*` is shippable as a shortcut.

**The six `opencode/*` shortcuts stand.** All six are present in the live
models.dev `opencode` provider (five are also in the bundled snapshot;
`muse-spark-1.2-contributor-free` postdates it), and a 8-round poll of the
harness catalog over ~90 s returned the identical six every time. An
earlier round on a cold sandbox returned a different nine-model set before
the zen roster settled, so a single cold-start `model.list` is not by
itself sufficient evidence.

**Standard going forward:** a live `model.list` is necessary but not
sufficient. Every shipped ID must also be attributable to a source
independent of the capture host — the models-dev catalog, or the pinned
source's bundled snapshot.

---

# opencode2 verification (stage 9)

**Date:** 2026-08-27
**Server:** the **published** `@opencode-ai/cli@0.0.0-beta-18286` binary
(`opencode2 serve`), run with the same isolation rules as the stage-6
source-build harness (isolated XDG homes, fake `HOME`/`OPENCODE_TEST_HOME`,
minimal allowlisted environment, tmp-rooted sandbox workdir, Basic auth).
Evidence: `spike/artifacts/14-opencode2-verification.json`,
`spike/artifacts/14b-instruction-entries.json`.

## The headline correction: a published server has existed all along

Stage 0 concluded, and stages 1–8 repeated, that **no published binary serves
the pinned client's contract**. That was wrong. The conclusion came from
probing **`opencode-ai`** — the _v1_ package name, whose `latest` is
`1.18.23` and whose `beta`/`dev` tags publish a partial 51-route v2 surface
of an older protocol generation.

The v2 CLI is published as **`@opencode-ai/cli`**, binary **`opencode2`**.
`@opencode-ai/cli@0.0.0-beta-18286` is the exact build of the pinned
`@opencode-ai/client@0.0.0-beta-18286`, and one build number spans binary,
client and running server (`14` → `v1Provenance.allThreeMatch: true`,
`health.get()` → `{healthy: true, version: "0.0.0-beta-18286"}`).

**The provider source needed no rework.** `src/` never referenced a CLI or a
source build — it was written contract-first against the pinned client types,
which is precisely what `opencode2` serves. What changed in stage 9 is the
_harness_ (now spawns the published binary; the source build survives as an
opt-in fallback behind `OPENCODE_BETA_SRC_DIR`) and the _claims_ in the docs.

Residual, verified packaging problems are written up in
`docs/upstream-issues/client-cli-version-skew.md`: `@opencode-ai/cli`'s
`latest`/`next` point at `0.0.0-beta-17823`, **behind** its own `beta`
(`18314`); the same dist-tag does not pair across packages (`client@beta` is
`18371` while `cli@beta` is `18314`); and no documented rule says the build
numbers must match, though in practice they must. `/api/doc` 404s on this
build, but the OpenAPI document **is** served at `/openapi.json` (which the
contract test already uses).

Two operational facts worth stating plainly:

- `serve` requires HTTP Basic auth on **every** route including
  `/api/health`; the username is `opencode`.
- `serve` honours `OPENCODE_PASSWORD`. With it set, no password line is
  printed; without it, `serve` generates one and prints
  `server password <...>`. The harness injects a random password rather than
  racing stdout, and keeps the parse as a fallback.

## Behavioural re-verification: confirms / contradicts

Every row was re-run against `opencode2`; the "previous evidence" column says
where the earlier answer came from.

| Behaviour                                        | Previous evidence            | opencode2 verdict                                                                                                         | Shipped default affected?                                 |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Binary/client/server build pairing               | n/a (new)                    | **Confirmed** — all three read `0.0.0-beta-18286`                                                                         | No                                                        |
| Server default `delivery` when omitted           | dev CLI, then source         | **Confirmed** — receipt says `delivery:"steer"`                                                                           | No — provider sends explicit `"queue"`                    |
| `receipt.id` equals the stored user message id   | source build                 | **Confirmed** — `userMessageIdEqualsReceiptId: true`                                                                      | No — correlation logic unchanged                          |
| `session.wait` on an **idle** session            | source build                 | **Confirmed** — resolves immediately                                                                                      | No                                                        |
| `session.wait` on a **busy** session             | source build                 | **Confirmed with a correction** — resolves _coincident with_ turn completion, not reliably before or after it (see below) | No — wait stays a watchdog, not a turn-completion signal  |
| Prompting a busy session with delivery omitted   | dev CLI, then source         | **Confirmed** — accepted, receipt `delivery:"steer"`                                                                      | No                                                        |
| Prompting a busy session with `delivery:"queue"` | dev CLI, then source         | **Confirmed** — accepted; all three turns drain                                                                           | No                                                        |
| `migration.v1.status`                            | embedded host                | **Confirmed** — `{status: "completed"}`                                                                                   | No                                                        |
| `session.log` catch-up from `after: 0`           | source build                 | **Confirmed** — yields the `log.synced` sentinel only                                                                     | No                                                        |
| File ingestion: `data:` URI                      | dev CLI, then source         | **Confirmed** — model answers "Red"; receipt stores `source: {type: "inline"}`                                            | No                                                        |
| File ingestion: `file:` URI                      | source build                 | **Confirmed** — model answers "Red"; the server reads the file and stores `source: {type: "uri", uri}` with bytes inlined | No — the `data:`-only preflight is deliberate (ledger #9) |
| File ingestion: bare absolute path               | source build                 | **Confirmed** — rejected **at prompt time**: `Invalid attachment URI: /…/red-square.png`                                  | No                                                        |
| `session.instructions.entry.*`                   | **unimplemented** everywhere | **Contradicted — the route works.** See below; this one _did_ change a shipped default                                    | **Yes** — real system prompts shipped                     |

### `session.wait` on a busy session: coincident, not ordered

The stage-6 source-build capture recorded
`waitResolvedBeforeExecutionSucceeded: false`, and stage 9's first run agreed
— but stage 9's second run reported `true`. The deltas explain it: wait
resolved at 39958 ms and `session.execution.succeeded` was observed at
39961 ms, a **3 ms** gap. That flag measures which of two near-simultaneous
things our _subscription_ saw first, not a server ordering guarantee. The
honest statement is that `session.wait` resolves coincident with turn
completion; nothing here supports treating its resolution as either a strict
before or a strict after signal.

This changes no shipped behaviour — the provider already treats
`session.wait` as a watchdog raced against event-driven completion rather
than as the completion signal (deferred-ledger item 1). It does mean the
earlier `false` should not have been recorded as a property.

### `serve --service` works, and the registration filename moved

`opencode2 serve --service` writes a registration — the _v1_ `opencode-ai`
CLI's missing `--service` flag was the basis of stage-0 finding 0.1's claim
that no published CLI supports it. On the published binary it writes
`$XDG_STATE_HOME/opencode/service.json`:

```json
{
  "id": "…",
  "version": "0.0.0-beta-18286",
  "url": "http://127.0.0.1:49374",
  "pid": 28022,
  "password": "…"
}
```

and mirrors the generated password into
`$XDG_CONFIG_HOME/opencode/service.json`.

Two differences from the source build caught the integration test, which had
been written against it:

- the registration is `service.json`, **not** `service-local.json` — and
  `service.json` is the only name the client's own `Service` module knows
  (its fallback is `<state>/opencode/service.json`), so the published binary
  is the one that matches the client here;
- a `service-local.json` port override in the config home is **ignored** —
  the published build binds an ephemeral port regardless.

`integration/service-backend.test.ts` now accepts either filename (the
source fallback keeps working) and notes that the port pre-seed exists only
for that fallback: an ephemeral port cannot collide by construction.

### A probe that had to be thrown away

The first stage-9 run of the file-ingestion check used the server's default
model, `opencode/nemotron-3.5-lightning-free`, which declares
`capabilities.input: ["text"]`. A text-only model answers "I cannot view
images" for _every_ URI scheme, which reads as a uniform failure and proves
nothing about ingestion. The probe was re-run against
`opencode/muse-spark-1.2-contributor-free` (`input` includes `image`), and
the artifact now records the probe model's declared capabilities alongside
the results so its validity is checkable from the artifact itself.

## Q5 revisited — `session.instructions.entry` works, and it changed what we ship

Stage 0 recorded Q5 as **inconclusive (unimplemented)**: no instructions
routes on the dev CLI, empty-body 500s on the embedded host. Against
`opencode2` the mechanism works end to end, and the provider now uses it as
its real system-prompt channel (`src/system-instruction.ts`,
`OpencodeLanguageModel.applySystemInstruction`). Evidence:
`spike/artifacts/14b-instruction-entries.json`.

| Probe                                                   | Result                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| E1 `entry.put` / `list` / `remove` round-trip           | Works; `list` reflects the put, and is empty after the remove                                                                         |
| E2 Entry set before the first prompt reaches the model  | Yes — the model returns the planted codeword                                                                                          |
| E3 Still applies on turn 2 of the same session          | Yes                                                                                                                                   |
| E4 Entry put **mid-session** applies from the next turn | Yes — turn 1 (no entry) does not know the codeword; turn 2 does                                                                       |
| E4 A mid-session put announces a durable message        | Yes — one `system` message, text `<context key="ai-sdk.system">…</context>`, `description: "Instructions updated: api/ai-sdk.system"` |
| E5 `remove` stops the instruction applying              | Yes — **no transcript confound** (see below)                                                                                          |
| E6 Key grammar                                          | `^[a-z0-9][a-z0-9._-]*$`; `AI-SDK`, `ai-sdk.System`, `_leading`, `.dot` and `""` rejected                                             |
| E6 Value cap                                            | 8192 bytes measured on the **JSON encoding** (see below)                                                                              |
| E6 Non-string values                                    | Accepted — `value` is a `JsonValue`, not just a string                                                                                |
| E7 Precedence vs the agent prompt                       | An entry instruction overrode default agent formatting behaviour                                                                      |
| E9 Unknown session                                      | Clean `Session not found: <id>`                                                                                                       |

### Two probe designs worth keeping

**E3 nearly produced a false positive.** The first version of the `ask`
helper returned "the last completed assistant message", which on turn 2+ is
the _previous_ turn's answer — so a cross-turn survival test would have
passed without a second turn ever running. The helper now takes a baseline
assistant count before prompting and waits for a _new_ completed assistant.
The first run's E3 "pass" was discarded.

**E5 nearly produced a false negative, twice.** Asking the model to confirm a
removal is confounded: once the codeword has appeared in the transcript, the
model can parrot it with the entry long gone. The decisive probe therefore
puts _and removes_ the entry **before the session is ever prompted**, so the
value cannot be in the history at all — the model does not produce it. A
separate, deliberately weaker after-exposure probe is recorded next to it and
labelled as non-evidence. Separately, the first conclusive-looking E5 result
was actually a turn **timeout**, and a regex missing over the literal string
`"<timeout>"` was being read as "the instruction was absent"; the probe now
retries a timed-out turn once and records a `conclusive` flag.

### The size cap is charged on the JSON encoding

`InstructionEntryValueTooLargeError` reports `actualBytes`/`maxBytes`, and
the bytes it counts are those of `JSON.stringify(value)`, not of the raw
string:

| Raw value        | Charged bytes | Accepted |
| ---------------- | ------------- | -------- |
| 8189 ASCII chars | 8191          | yes      |
| 8190 ASCII chars | 8192          | yes      |
| 8191 ASCII chars | 8193          | **no**   |
| 8192 ASCII chars | 8194          | **no**   |
| 4095 × `é`       | 8192          | yes      |

So the two quote characters count, multi-byte characters are charged their
UTF-8 length, and JSON-escaped characters their escaped length.
`instructionValueBytes()` reproduces this exactly; a caller budgeting against
"8 KiB of text" would overshoot by two bytes and more with non-ASCII content.

### What shipped as a result

- `settings.systemPrompt` and AI SDK `system:` messages are joined (setting
  first) and written to the session entry `ai-sdk.system` — namespaced so a
  caller's own entries on a pinned session are never clobbered.
- **This removed a real limitation**: the v4-era delimited prepend only ever
  reached a session's _first_ prompt, so a system prompt silently stopped
  applying on reused sessions. The entry is re-rendered every turn.
- Writes are reconciled, not blind. An unchanged value skips the request (a
  redundant put announces another durable system message); a call that drops
  its system content **removes** the entry rather than leaking a previous
  call's system prompt into later turns. So does a call that cannot write
  its own value (over the cap, or a failed put): leaving the old value there
  would keep a stale, higher-priority system prompt governing the session
  while the new content only reached the model as prepended user text.
  `remove` is idempotent on this build (removing an absent key succeeds),
  which is what makes the reconciling clear cheap enough to always attempt.
- The fallback is feature-detected, not assumed: a port without the route, a
  value over the cap, or a failed write degrades to the delimited prepend and
  emits an `unsupported` warning naming the actual reason. Only an explicit
  404/405/501 sticks; a transient failure is retried on the next turn rather
  than downgrading the whole conversation.

What remains undocumented upstream — precedence guarantees, **compaction
survival**, key-namespacing conventions, whether a no-op put is suppressed
server-side — is written up in `docs/upstream-issues/per-prompt-system.md`,
which is now a docs request rather than the API-change request it was.

## Reproduction (stage 9)

```bash
# server: the PUBLISHED v2 binary — package @opencode-ai/cli, binary opencode2.
# (npm i -g opencode-ai gives you the *v1* CLI; that is the trap.)
npm install -D @opencode-ai/cli@0.0.0-beta-18286

SB=/tmp/oc2-verify
mkdir -p $SB/{home,data/opencode,state,config,cache,workdir}
cp ~/.local/share/opencode/auth.json $SB/data/opencode/    # zen creds
PW=$(openssl rand -base64 24 | tr -d '=+/')

# env -i + fake HOME/OPENCODE_TEST_HOME + a tmp-rooted workdir are all
# required: config discovery walks upward from the session directory to the
# filesystem root and reads $HOME/.claude and $HOME/.agents directly.
cd $SB/workdir && env -i PATH="$PATH" HOME=$SB/home \
  OPENCODE_TEST_HOME=$SB/home TMPDIR=/tmp \
  XDG_DATA_HOME=$SB/data XDG_STATE_HOME=$SB/state \
  XDG_CONFIG_HOME=$SB/config XDG_CACHE_HOME=$SB/cache \
  OPENCODE_PASSWORD="$PW" \
  OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"ask"}}' \
  ./node_modules/.bin/opencode2 serve --port 14396

# experiments (repo root)
OC2_URL=http://127.0.0.1:14396 OC2_PASSWORD="$PW" \
  OC2_WORKDIR=$SB/workdir node spike/14-opencode2-verification.mjs
OC2_URL=http://127.0.0.1:14396 OC2_PASSWORD="$PW" \
  OC2_WORKDIR=$SB/workdir node spike/14b-instruction-entries.mjs

# gated integration suite (starts its own opencode2 in its own sandbox)
npm run test:integration
```
