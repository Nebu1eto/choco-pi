# google-antigravity provider rules

- First-party package (no VENDORED.md). Never copy code from pi-antigravity or agy; derive behavior from captures and descriptors.
- Node-erasable TypeScript with explicit `.ts` relative imports; peer dependencies only (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-schema`).
- Validate every external payload with `@earendil-works/pi-schema`; no casts, `any`, suppressions, `typeof` narrowing or `*Sync` APIs.
- Credentials go only through Pi's credential store (the returned `OAuthCredentials`). Never write auth.json or a side file; never persist env or config secrets.
- Never commit a real OAuth client id or secret, token or account identifier. Tests use the obviously fake values in `tests/helpers.ts`.
- Never invent a project id. Never rewrite prompts to evade classifiers.
- Error messages come only from `formatAntigravityErrorMessage`; keep its wording consistent with Pi's retry and overflow predicates (tests/errors.test.ts).
- No test may contact a Google host.

## Verify

```bash
cd packages/choco-pi-provider-google-antigravity && npx tsc --noEmit
cd <repo-root> && node --test packages/choco-pi-provider-google-antigravity/tests/*.test.ts
```
