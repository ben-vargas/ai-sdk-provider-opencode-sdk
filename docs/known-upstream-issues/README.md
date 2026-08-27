# Known upstream issues (tracked locally)

Limitations of the OpenCode v2 beta that this provider works around, kept as
a local register to re-check against newer upstream builds. **These are
deliberately not filed upstream** — the decision (2026-08-27) was to track
them here instead of opening issues on `anomalyco/opencode`.

Every file carries the same header: a status line, the build it was last
verified against (`opencode2 0.0.0-beta-18286`), a re-check recipe, and
evidence pointers into `spike/artifacts/`. When bumping the pinned
client/CLI build, run each file's re-check; anything upstream has fixed can
be retired here and its provider workaround revisited.

| File                                                             | One-line summary                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [structured-output.md](structured-output.md)                     | No schema-enforced structured output on the v2 prompt path (`generateObject` degrades to prompting) |
| [inbox-execution-correlation.md](inbox-execution-correlation.md) | Execution/step events carry no key back to the prompt receipt; live attribution is ordering-based   |
| [client-cli-version-skew.md](client-cli-version-skew.md)         | v2 CLI package is hard to discover; dist-tags trail `beta` and do not pair across client/CLI        |
| [per-prompt-system.md](per-prompt-system.md)                     | Instruction-entry precedence vs the agent prompt and compaction survival are undocumented           |

A fifth draft, `file-ingestion.md`, was **withdrawn and deleted** (stage 10):
it described dev-CLI behavior the real `opencode2` server does not have —
the published build handles `data:` and `file:` URIs correctly and rejects
bad attachments at prompt time (see `docs/v2-spike-findings.md`).
