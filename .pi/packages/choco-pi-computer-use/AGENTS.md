# choco-pi-computer-use — working rules

Vendored fork of `@injaneity/pi-computer-use@0.5.0`. Read `VENDORED.md` before changing this package.

## Hard constraints

- Use erasable TypeScript only: no enums, namespaces, decorators, or constructor parameter properties.
- Every relative TypeScript import must use an explicit `.ts` suffix. Keep the deliberate `helper-path.mjs` and `helper-source.mjs` imports (shared with the plain-JavaScript installer); never use `.js` or an extensionless relative specifier.
- Do not rename any tool (`find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for`, `launch_browser`, `navigate_browser`, `evaluate_browser`) or change its schema without explicit authority.
- No build step and no `dist/`. Pi loads `extensions/computer-use.ts` directly.
- `typebox` and `@earendil-works/*` are host-provided peer dependencies. Exactly pin and vendor any other runtime dependency under this package's `node_modules/`.
- Native helper installation is supported only on macOS. Keep Linux and Windows TypeScript backends dispatch-guarded; do not restore their native crates or build paths without an explicit support decision.
- Keep `native/macos/*.swift`; no binaries are tracked. The installer compiles the helper for the host architecture on every install; never commit a built `bridge` or `prebuilt/` tree.
- Record every upstream divergence in `VENDORED.md` when making it.

## Verification

Static checks must not run the helper installer, codesign, register an app, install into `/Applications` or `~/Applications`, or trigger Accessibility/TCC prompts.

```bash
cd .pi/packages/choco-pi-computer-use && npx tsc --noEmit
cd <repo root> && node --test .pi/packages/choco-pi-computer-use/tests/load.test.ts
```

To prove the build recipe without installing or signing anything, compile into a scratch directory:

```bash
cd .pi/packages/choco-pi-computer-use
node scripts/setup-helper.mjs --build-only --out /tmp/choco-pi/<scratch>
```

For an explicitly authorized manual installation on macOS only:

```bash
cd .pi/packages/choco-pi-computer-use
node scripts/setup-helper.mjs
```

That command changes machine state and is not part of routine verification.
