# Known upstream issues (tracked locally)

Limitations of OpenCode v2 (the betas and 2.x) that this provider works around, kept as
a local register to re-check against newer upstream builds. **These are
deliberately not filed upstream** — the decision (2026-08-27) was to track
them here instead of opening issues on `anomalyco/opencode`.

Every file carries the same header: a status line, the build it was last
verified against (re-checked against OpenCode **2.0.24** on 2026-10-06; first
verified on `opencode2 0.0.0-beta-18286`), a re-check recipe, and evidence
pointers into `spike/artifacts/`. When bumping the pinned
client/CLI build, run each file's re-check; anything upstream has fixed can
be retired here and its provider workaround revisited.

| File                                                             | One-line summary                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [structured-output.md](structured-output.md)                     | No schema-enforced structured output on the v2 prompt path (`generateObject` degrades to prompting)             |
| [inbox-execution-correlation.md](inbox-execution-correlation.md) | Execution/step events carry no key back to the prompt receipt; live attribution is ordering-based               |
| [client-cli-version-skew.md](client-cli-version-skew.md)         | Largely resolved in 2.0 (`@opencode/*`, paired tags); `opencode-ai` is still the v1 CLI                         |
| [per-prompt-system.md](per-prompt-system.md)                     | Instruction-entry precedence and compaction survival: answered from 2.0.24 source, still undocumented           |
| [decline-interrupt-reason.md](decline-interrupt-reason.md)       | An approval rejected without feedback, or a cancelled question form, ends the turn as `interrupted: "shutdown"` |

A fifth draft, `file-ingestion.md`, was **withdrawn and deleted** (stage 10):
it described dev-CLI behavior the real `opencode2` server does not have —
the published build handles `data:` and `file:` URIs correctly and rejects
bad attachments at prompt time (see `docs/v2-spike-findings.md`).
