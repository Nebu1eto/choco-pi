# Authentication

[한국어](../ko/authentication.md)

Sign in to a model provider from a Pi session with `/login`:

```text
/login openai
/login anthropic
/login synthetic
/login xai
```

Pi stores credentials outside the repository. Do not copy credential files into Git.

Pi has built-in logins for Anthropic, OpenAI, and xAI. choco-pi adds a Synthetic provider and discovers Callstack Apex models from [`apex-provider.json`](../../profile/extensions/apex-provider.json).

`/login openai` is Pi's "Sign in with ChatGPT" for the provider `openai` (api.openai.com). The legacy `openai-codex` provider, which uses the chatgpt.com backend, is still available if you opt in with `/login openai-codex`. With an `openai` sign-in:

- Fast mode is accepted but has no effect; it is never sent.
- Daybreak is unavailable.
- Server-side compaction is never attempted; local compaction runs instead.
- Native `web_run` search is unavailable; web search goes through `choco-pi-web-access`.
- `imagegen` and `view_image` resolve `openai` credentials, but neither has been verified against the live service.

Pi's built-in `xai` provider (Grok) signs in with `/login xai`, using a SuperGrok or X Premium subscription, or reads the `XAI_API_KEY` environment variable. Fast mode applies only to `xai/grok-4.7` on api.x.ai.
