# Repository policy

## Commit policy

When a task/task-inline/task-dynamic/task-hotfix workflow completes and the user has not excluded a commit, the orchestrator commits locally per `profile/skills/commit/SKILL.md` (sign, trailer, never push).

## Dependencies and vendored packages

The repository is one pnpm workspace (`packages/*`) with one lockfile, the root `pnpm-lock.yaml`; no package has its own lockfile or workspace file. `pnpm install --frozen-lockfile` at the root generates the untracked, load-bearing `node_modules` trees. Dependency build scripts stay disabled: each dependency that has one is listed as `false` under `allowBuilds` in `pnpm-workspace.yaml`. Record each package divergence in that package's `VENDORED.md` with the change.

The root `mise.toml` pins Node.js and pnpm (locked in `mise.lock`). Its pnpm moves together with `package.json` `packageManager` and `scripts/standalone/runtime-pins.txt`; its Node.js is the newest release and must not be older than the runtime pins' `node_version`, the Node.js 24 floor the standalone installer ships, so code must keep running on Node.js 24. `tests/workspace-policy.test.ts` enforces both. Run installs and gates under that toolchain: `mise install`, then an activated shell or `mise exec --`.

## Model guidance

`profile/model-guidance.md` owns model routing and model-specific policy. Before changes, read each complete applicable source guide and append provenance to `docs/model-guidance-history.md`, a history-only record that is never routing input. Provider-neutral wording may use current references; apply provider advice only to its model.

Cached recollection, summaries, excerpts, metadata, and navigation-only pages do not count as a refreshed guide.

## Source rules

- Read the closest `AGENTS.md` and `VENDORED.md`; use Node-erasable TypeScript and explicit `.ts` relative imports.
- Validate with pi-schema (`@earendil-works/pi-schema`); import `typebox` (host alias, `^1.3.29`) only inside a package's `schema-bridge.ts` for the `registerTool` boundary. Add no other schema library or build output.
- Never edit generated dependencies. Bundled packages live in `packages/`. After adding one to `packages` in the agent directory's `settings.json` (`~/.pi/agent`, or `$CHOCO_PI_HOME/agent` for the standalone `choco-pi` launcher; the checkout ships no `.pi/settings.json`), run `pnpm install:profile` (standalone: `choco-pi self setup`).
- ACP/editor-context require Node 24+; ACP runs `packages/choco-pi-acp/bin/choco-pi-acp.ts` (standalone: `choco-pi self acp`) without build output or a manifest entry.
- Tool inputs and outputs use snake_case keys and option values, with no camelCase aliases; convert at the tool boundary and keep internal names. Tool names and pass-through external data are exempt. `tests/tool-io-naming.test.ts` enforces parameter schemas.

## Mandatory implementation constraints

- Never bypass lint findings. Do not add suppression directives, disable or weaken rules, exclude files, or evade a rule; fix its cause.
- Never ignore type errors. Do not use `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, unchecked casts, `any`, or placeholder types; validate external data accurately.
- New or rewritten first-party executable code must be Node-erasable TypeScript, not JavaScript; migrate changed legacy logic.
- Use non-blocking Node.js APIs whenever an asynchronous equivalent exists. Blocking filesystem and child-process APIs, including `*Sync` variants, are prohibited in new or rewritten code.
- Required lint and typecheck gates must finish with zero errors. Pre-existing failures are not an exemption; report the blocker and request that scope rather than suppressing the failure.

## Lifecycle and verification

- Before the first `await` or dynamic import, snapshot scalars and an owner/generation; invalidate synchronously and recheck after each await before host objects.
- Settle lifecycle callbacks exactly once; contain only stale-context errors and rethrow unrelated failures.
- Root code changes require `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` (the root and each package with a `tsconfig.json`), and `pnpm test` (`tests/` and `packages/*/tests/`) on the final state before completion; while working, run focused checks instead.
- `pnpm test` does not run the formal validation tests in `tests/formal/`; `pnpm test --formal` adds them. Run them only for a change to `formal/`, `profile/skills/formal-verify/`, or `tests/formal/`. Run a model check (`check-all.ts`) only for a model whose files changed or that `drift.ts affected` names.
- Prefer subagents for delegated work; spawn a dedicated Pi session or process only when the user explicitly asks.
