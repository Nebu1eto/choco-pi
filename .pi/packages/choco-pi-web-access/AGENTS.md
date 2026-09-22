# choco-pi-web-access working rules

Vendored fork of `pi-web-access@0.24.1`. Read `VENDORED.md` before changing source files.

## Hard constraints

- This package implements only OpenAI, Exa, and Kagi search transports. Its shared-router schema and curator may name or delegate the Synthetic and Brave logical provider families, but no Synthetic or Brave transport, credential, or provider-specific configuration belongs here.
- Keep the OpenAI Codex-subscription credential path through Pi's model registry and `CODEX_RESPONSES_URL`; `OPENAI_API_KEY` remains only its fallback.
- Keep Kagi credentials on `KAGI_API_KEY` / `kagiApiKey`, not browser cookies.
- Use erasable TypeScript only: no enums, namespaces, decorators, or constructor parameter properties.
- Every relative import uses an explicit `.ts` extension.
- Pi loads `index.ts` directly. Do not add a build step or `dist/`.
- Runtime dependencies are committed and exactly pinned under `node_modules/`. `typebox` and `@earendil-works/*` remain host-provided peer dependencies.
- Record every upstream divergence in `VENDORED.md` as it is made.

## Verify

```bash
cd .pi/packages/choco-pi-web-access && npx tsc --noEmit
cd <repo root> && node --test .pi/packages/choco-pi-web-access/tests/*.test.ts
cd .pi/packages/choco-pi-web-access && node -e 'import("./index.ts").then(()=>console.log("ok"))'
```

Do not run paid-provider network searches as validation.
