# Unified web search core rules

- This package is provider-neutral. Never import a search backend or another extension entrypoint.
- Keep the public API in `index.ts` and document signature changes in `CONTRACT.md` before consumers adopt them.
- Use Node-erasable TypeScript, explicit `.ts` relative imports, and host-provided peer dependencies only.
- The extension marks the shared event-bus scope and owns session lifecycle; it does not register `web_search`.
- Validate adapter data at the core boundary with TypeBox. Never expose credentials in diagnostics.

## Verify

```bash
cd .pi/packages/choco-pi-web-search && npx tsc --noEmit
cd <repo-root> && node --test .pi/packages/choco-pi-web-search/tests/*.test.ts
```
