# choco-pi-subagents — working rules

Vendored fork of `@tintinweb/pi-subagents@0.17.1`. Read `VENDORED.md` before
changing anything under `src/`, and `ARCHITECTURE.md` before adding a feature.

## Hard constraints

- **Erasable syntax only.** No `enum`, `namespace`, decorators, or constructor
  parameter properties. Node's strip-only TypeScript mode must be able to load
  every file; `tests/subagent-config.test.ts` imports `src/` directly.
- **Relative imports carry an explicit `.ts` extension.** Not `.js`, not
  extensionless. Node resolves neither of those to a TypeScript file.
- **Do not rename `Symbol.for("pi-subagents:manager")` or any `subagents:*`
  event name.** They are a cross-extension interface matched by literal string;
  renaming them fails silently at runtime, not at compile time.
- **No build step.** Pi loads `src/index.ts` through jiti. Do not add a `dist/`.
- **Runtime dependencies are vendored and exactly pinned** under
  `node_modules/`. Adding one means copying the package in and pinning the exact
  version; do not rely on the repository-root `node_modules`.

## Before finishing a change

```bash
cd .pi/packages/choco-pi-subagents && npx tsc --noEmit
cd <repo root> && node --test tests/subagent-config.test.ts
```

Any change to `src/index.ts`, `src/agent-manager.ts` or `src/agent-runner.ts`
also needs a real pi session to be trusted: their behavior only exists against a
live extension host, and neither check above starts one.

## Upstream drift

Record every divergence from the base tarball in `VENDORED.md` as you make it,
not afterwards. A resync diffs this tree against a fresh `npm pack`, and an
undocumented edit is indistinguishable from an upstream change at that point.
