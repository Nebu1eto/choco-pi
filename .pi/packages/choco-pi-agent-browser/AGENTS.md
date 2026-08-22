# choco-pi-agent-browser — working rules

Vendored fork of `pi-agent-browser-native@0.5.0`. Read `VENDORED.md` before changing vendored code.

## Hard constraints

- Use erasable TypeScript syntax only: no `enum`, `namespace`, decorators, or constructor parameter properties. Node strip-types must load every module.
- Every relative TypeScript import or export must use an explicit `.ts` specifier. Keep the runtime import of `scripts/agent-browser-target.mjs` as `.mjs`.
- Do not add a build step or compiled output. Pi loads `extensions/agent-browser/index.ts` directly.
- Keep `agent-browser` as an external executable on `PATH`. Never vendor, bundle, install, or launch the CLI from package code.
- Preserve `TARGET_AGENT_BROWSER_VERSION` and the startup version gate. Update the target metadata deliberately when the supported CLI changes.
- Keep the existing tool names, including `agent_browser` and `agent_browser_web_search`.
- Keep `typebox` and all `@earendil-works/*` imports as host-provided peer dependencies.
- Import TypeBox only as `typebox`, `typebox/compile`, or `typebox/value`. Pi's loader aliases only those three specifiers; any other subpath breaks extension loading.
- Record every difference from upstream in `VENDORED.md` when making it.

## Operator commands

Run the read-only doctor manually with `node scripts/doctor.mjs`. Manage package configuration manually with `node scripts/config.mjs`; this private local package exposes no npm bin links.

## Verification

```bash
cd .pi/packages/choco-pi-agent-browser && npx tsc --noEmit
cd <repo-root> && node --test .pi/packages/choco-pi-agent-browser/tests/*.test.ts
```

Also prove that relative `.js` specifiers are absent, `lib/upstream-version.ts` still resolves `scripts/agent-browser-target.mjs`, and the entrypoint imports under Node strip-types. Do not launch a browser or the external CLI for static package changes.
