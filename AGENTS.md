# Repository policy

This file contains only repository-specific requirements absent from `.pi/SYSTEM.md` and the authoritative workflow skills.

## Model guidance

Before writing or revising `.pi/SYSTEM.md`, `AGENTS.md`, `.pi/agents/*`, skills, prompt templates, tool descriptions, or any other
model-facing instruction, read from start to finish the entire current contents of all three documents:

- <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5>
- <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5>
- <https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices>

Cached recollection, summaries, excerpts, metadata, and navigation-only pages do not count. Apply model-specific advice only to the
matching model; runtime, user, and project instruction precedence remains authoritative.

## Source rules

- Read the closest `AGENTS.md` and `VENDORED.md`; record every vendored-package divergence in `VENDORED.md` in the same change.
- Use Node-erasable TypeScript and explicit `.ts` suffixes for relative TypeScript imports and exports.
- Use host TypeBox aliases only where package policy allows; never override vendored `@sinclair/typebox`. Add no build output unless allowed.

## Lifecycle and verification

- Before the first `await` or dynamic import, snapshot scalars and a generation or owner. Invalidate it synchronously on shutdown,
  keep command cancellation separate, and recheck after every `await` before using `ctx`, `pi`, UI, or another host-owned object.
- Settle lifecycle callbacks exactly once. Contain only the canonical stale-context error; rethrow unrelated failures.
- Root gates are `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, and `pnpm test`.
- Run extension-host and TUI checks through the real path in a fresh, separate Pi process.

## Post-task session audit

- Once per user task, the root orchestrator audits all available persisted project sessions from a recorded cutoff; leaf and workflow
  agents do not repeat the audit. Exclude audit workers created after the cutoff so the audit cannot recurse.
- Report coverage limits, recurring failures or retries, repeated review findings, and only new durable lessons. Never expose secrets or
  mutate, delete, steer, compact, or annotate sessions; report unavailable records instead of inventing coverage.
