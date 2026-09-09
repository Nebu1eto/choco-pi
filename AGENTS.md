# Repository policy

This file contains only repository-specific requirements absent from `.pi/SYSTEM.md` and the authoritative workflow skills.

## Model guidance

`.pi/model-guidance.md` owns model routing and the reviewed source references for model-specific policy. Before adding or changing
model-specific policy, or migrating a model, refresh and read from start to finish each complete applicable guide and update its
review provenance there. A provider-neutral wording-only edit may rely on the current reviewed references without refreshing every
model guide. Cached recollection, summaries, excerpts, metadata, and navigation-only pages do not count as a refreshed guide. Apply
model-specific advice only to the matching model; runtime, user, and project instruction precedence remains authoritative.

## Source rules

- Read the closest `AGENTS.md` and `VENDORED.md`; record every vendored-package divergence in `VENDORED.md` in the same change.
- Use Node-erasable TypeScript and explicit `.ts` suffixes for relative TypeScript imports and exports.
- Packages use the host-provided `typebox` alias, aligned repo-wide to `^1.3.29`; no package vendors a schema-validation library. Add no build output unless allowed.
- `.pi/packages/choco-pi-acp` and `.pi/packages/choco-pi-editor-context` require Node 24 or newer. The Zed ACP adapter is executed
  from TypeScript source through `bin/choco-pi-acp.ts` and ships no build output; it is not a Pi extension and has no manifest entry.
- After adding a package to `.pi/settings.json`, re-run `pnpm install:profile`. Pi loads the package only after that run.

## Lifecycle and verification

- Before the first `await` or dynamic import, snapshot scalars and a generation or owner. Invalidate it synchronously on shutdown,
  keep command cancellation separate, and recheck after every `await` before using `ctx`, `pi`, UI, or another host-owned object.
- Settle lifecycle callbacks exactly once. Contain only the canonical stale-context error; rethrow unrelated failures.
- Root code changes require `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, and `pnpm test` before completion; readiness and
  acceptance-selected focused validation may run earlier without an unconditional pre-edit full-gate pass.
- When explicitly selected as acceptance evidence, run extension-host and TUI checks through the real path in a fresh, separate Pi
  process. Keep real-Pi test suites opt-in.
- Prefer subagents for delegated work; spawn a dedicated Pi session or process only when the user explicitly asks.

## Post-task session audit

- Once per user task, the root orchestrator audits the current task lineage from a recorded cutoff; leaf and workflow agents do not
  repeat the audit. A historical sweep requires an explicit request and must be bounded and incremental. Exclude audit workers
  created after the cutoff so the audit cannot recurse.
- Report coverage limits, recurring failures or retries, repeated review findings, and only new durable lessons. Never expose secrets or
  mutate, delete, steer, compact, or annotate sessions; report unavailable records instead of inventing coverage.
