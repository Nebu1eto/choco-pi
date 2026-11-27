# Unified web search package rules

Unified package combining the session-scoped search router (`index.ts` + `src/`) and the web-access frontend (`extension.ts`, `tools/`, OpenAI/Exa/Kagi search transports, source checking, content extraction, and `/preferences` integration; see `VENDORED.md` for upstream `pi-web-access@0.24.1` license provenance).

## Hard constraints

- Keep `index.ts` and `src/` lightweight and provider-neutral: external adapters (`codex`, `google-antigravity`, `synthetic`, `agent-browser`, `xai-search`, `tool-search`) import `index.ts` and must never pull in content extraction dependencies (`unpdf`, `linkedom`, `turndown`) or top-level I/O.
- Keep the public core API in `index.ts` and document signature changes in `CONTRACT.md` before consumers adopt them.
- Implement only OpenAI, Exa, and Kagi search transports in this package; no Synthetic, Brave, Google, or xAI transport or credential code belongs here.
- Keep the OpenAI Codex-subscription credential path through Pi's model registry and `CODEX_RESPONSES_URL`; `OPENAI_API_KEY` remains fallback. Default OpenAI search provider order is `["openai", "openai-codex"]`.
- Keep Kagi credentials on `KAGI_API_KEY` / `kagiApiKey`, not browser cookies.
- Never add browser-popup curator UIs or auto-open OS browsers during `web_search`; configuration belongs in `web-search.json` and `/preferences`.
- Use Node-erasable TypeScript, explicit `.ts` relative imports, no build output (`dist/`), and validate adapter/tool boundaries with `@earendil-works/pi-schema` (`typebox` only in `schema-bridge.ts`). Never expose credentials in diagnostics.

## Verify

```bash
cd packages/choco-pi-web-search && npx tsc --noEmit
cd <repo-root> && node --test packages/choco-pi-web-search/tests/*.test.ts
```
