# Repository policy

## Commit policy

When a task/task-inline/task-hotfix workflow completes and the user has not excluded a commit, the orchestrator commits locally per `.pi/skills/commit/SKILL.md` (sign, trailer, never push).

## Vendored dependencies

Untracked `.pi/packages/*/node_modules` trees are load-bearing and enforced by install profiles. Record each package divergence in `VENDORED.md` with the change.

## Model guidance

`.pi/model-guidance.md` owns model routing and model-specific policy. Before changes, read each complete applicable source guide and update provenance. Provider-neutral wording may use current references; apply provider advice only to its model.

Cached recollection, summaries, excerpts, metadata, and navigation-only pages do not count as a refreshed guide.

## Source rules

- Read the closest `AGENTS.md` and `VENDORED.md`; use Node-erasable TypeScript and explicit `.ts` relative imports.
- Use the host `typebox` alias at `^1.3.29`; add no schema library or build output.
- Never edit generated dependencies. After adding a package to `.pi/settings.json`, run `pnpm install:profile`.
- ACP/editor-context require Node 24+; ACP runs `bin/choco-pi-acp.ts` without build output or a manifest entry.

## Mandatory implementation constraints

- Never bypass lint findings. Do not add suppression directives, disable or weaken rules, exclude files, or evade a rule; fix its cause.
- Never ignore type errors. Do not use `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, unchecked casts, `any`, or placeholder types; validate external data accurately.
- New or rewritten first-party executable code must be Node-erasable TypeScript, not JavaScript; migrate changed legacy logic.
- Use non-blocking Node.js APIs whenever an asynchronous equivalent exists. Blocking filesystem and child-process APIs, including `*Sync` variants, are prohibited in new or rewritten code.
- Required lint and typecheck gates must finish with zero errors. Pre-existing failures are not an exemption; report the blocker and request that scope rather than suppressing the failure.

## Lifecycle and verification

- Before the first `await` or dynamic import, snapshot scalars and an owner/generation; invalidate synchronously and recheck after each await before host objects.
- Settle lifecycle callbacks exactly once; contain only stale-context errors and rethrow unrelated failures.
- Root code changes require `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, and `pnpm test` before completion.
- Prefer subagents for delegated work; spawn a dedicated Pi session or process only when the user explicitly asks.
