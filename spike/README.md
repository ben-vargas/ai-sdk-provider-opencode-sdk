# Spike scripts (archival)

These scripts produced the evidence in `spike/artifacts/` and
`docs/v2-spike-findings.md` while the provider was developed against the
**OpenCode v2 betas** (`@opencode-ai/client` / `@opencode-ai/cli` /
`@opencode-ai/sdk` at `0.0.0-beta-18286`, upstream commit `f4a9b930`).

They are kept as a record and are **not maintained**: they import the
pre-release `@opencode-ai/*` packages, which are no longer devDependencies.
The provider now targets the released OpenCode 2.x packages (`@opencode/*`);
its live verification is the integration suite (`npm run test:integration`).
