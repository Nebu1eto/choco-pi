# choco-pi-code-mode — working rules

First-party universal Code Mode package: the `exec`/`wait` programmatic tool host, the core nested tools (`apply_patch`, `exec_command`/`write_stdin`, local `view_image`), the patch and shell engines, and their renderers. It works with every Pi provider.

## Hard constraints

- **Provider-neutral.** Never import `@choco-pi/codex`, `profile/`, or OpenAI transport packages (`openai`, `undici`, ...). Providers contribute through the ports in `src/adapter/code-mode/ports.ts`. `tests/universal-layer-boundary.test.ts` and the root `tests/architecture-boundaries.test.ts` enforce this; `@choco-pi/shared` is the only first-party dependency.
- **One Code Mode owner per Pi runtime.** `src/host-slot.ts` coordinates through the shared `pi.events` bus (`choco-pi:code-mode-host/v1`). `src/extension.ts` registers the standalone Code Mode only when no owner answered. Do not rename the channel: it is a live cross-extension contract.
- **Layout is load-bearing.** `src/tools/code-mode/binary.ts` and `src/tools/native/binary.ts` resolve `code-mode/` and `src/tools/*/bin/` from this package root; keep the tree shape when moving files.
- `typebox` is imported only in `src/schema-bridge.ts`.
- Erasable Node 24+ TypeScript with explicit `.ts` relative imports and no new blocking `*Sync` calls.
- Consumers import through the explicit `exports` subpaths in `package.json`; add a subpath there rather than reaching into `src/` from another package.
- Record divergences in `VENDORED.md`.
