# Authentication

[한국어](../ko/authentication.md)

Sign in to a model provider from a Pi session with `/login`:

```text
/login openai
/login anthropic
/login synthetic
/login xai
/login google
```

Pi stores credentials outside the repository. Do not copy credential files into Git.

Pi has built-in logins for Anthropic, OpenAI, and xAI. choco-pi adds a Synthetic provider, a [Google Antigravity](#google-antigravity) provider, and discovers Callstack Apex models from [`apex-provider.json`](../../profile/extensions/apex-provider.json).

`/login openai` is Pi's "Sign in with ChatGPT" for the provider `openai` (api.openai.com). The legacy `openai-codex` provider, which uses the chatgpt.com backend, is still available if you opt in with `/login openai-codex`. With an `openai` sign-in:

- Fast mode is accepted but has no effect; it is never sent.
- Daybreak is unavailable.
- Server-side compaction is never attempted; local compaction runs instead.
- Native `web_run` search is unavailable; web search goes through `choco-pi-web-access`.
- `imagegen` and `view_image` resolve `openai` credentials, but neither has been verified against the live service.

Pi's built-in `xai` provider (Grok) signs in with `/login xai`, using a SuperGrok or X Premium subscription, or reads the `XAI_API_KEY` environment variable. Fast mode applies only to `xai/grok-4.7` on api.x.ai.

## Google Antigravity

The `google` provider from [`@choco-pi/provider-google-antigravity`](../../packages/choco-pi-provider-google-antigravity) serves Google Antigravity models (Gemini, Claude, and GPT-OSS through Cloud Code Assist) on a consumer Google AI subscription. Sign in with the following command and choose **Google Antigravity**:

```text
/login google
```

**It replaces Pi's built-in `google` provider.** While this package is loaded, `google/<model>` names a Google Antigravity model and Pi's built-in Gemini API-key `google` provider and its models are gone. `GEMINI_API_KEY` is not used. `/login google` may still list Pi's API-key method next to Google Antigravity, but this provider accepts only the Google Antigravity OAuth sign-in: a stored API key, or `GEMINI_API_KEY` when nothing is stored, makes each request fail at once with an authentication error that names `/login google`, before any network request and without showing the key. `/usage`, Google search, and background token counting treat such a key as not signed in. A stored Google Antigravity sign-in always wins over `GEMINI_API_KEY`. To use a Gemini API key instead, remove this package from `packages` and restart.

A new install loads this package by default. Reinstalling (`pnpm install:profile`, `choco-pi self setup`, or `choco-pi self update`) keeps the package list you already have, so an existing install adds it once by hand: put the absolute path `<checkout>/packages/choco-pi-provider-google-antigravity` in `packages` in `settings.json` (`~/.choco-pi/agent/settings.json` for the standalone command), then restart choco-pi.

**Terms and account risk.** Google's Antigravity terms restrict third-party clients on consumer OAuth access, and Google has suspended accounts used this way. choco-pi is a third-party client, and its requests identify as the official agy CLI. The Google Antigravity login shows this warning and continues only after you accept it; declining ends the login before any network request. Use the provider only if you accept that risk for your account.

The repository ships no OAuth client id or secret. Login takes one from the first of these sources that is set:

1. The `CHOCO_PI_ANTIGRAVITY_CLIENT_ID` and `CHOCO_PI_ANTIGRAVITY_CLIENT_SECRET` environment variables.
2. `client_id` and `client_secret` in `<agent directory>/google-antigravity.json`. The same file can also set `project_id` (your own Cloud project) and `agy_path`.
3. Only when neither is set, and only after you agree at a second prompt: a local scan of an installed agy binary (`CHOCO_PI_ANTIGRAVITY_AGY_PATH`, then `agy_path`, then `agy` on `PATH`).

The browser step works like the official agy CLI's login. choco-pi opens a Google sign-in page; after you allow access, Google sends the browser to `https://antigravity.google/oauth-callback`, and that page shows an authorization code. Copy it and paste it at the prompt in choco-pi (the full address of that page works too). Nothing listens on your machine, and the code is never logged or shown. The login asks for these scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, and `aicode` (each under `https://www.googleapis.com/auth/`), plus `openid`. After sign-in, choco-pi reads your account email so that per-account data such as `/usage` stays keyed to the same account; the email is stored only in the credential and used only in hashed form. Credentials go only to Pi's credential store, and secrets from the environment or the config file are never copied there. Google assigns the Cloud Code Assist project; login fails with a message instead of inventing one.

With a Google Antigravity sign-in on `google`:

- `/usage` shows a Google row with the plan name, the AI credit balance when Google reports one, and a weekly and a 5-hour window for each model group (for example "Gemini Models weekly" and "Claude and GPT models 5h"), each with its used share and reset time. Google names both consumer Ultra plans "Google AI Ultra", so the row adds the size from the tier id: "Google AI Ultra (5x)" or "Google AI Ultra (20x)". A plan without a quota summary shows only a status line. Without that sign-in, including when only a Gemini API key is configured, Google is listed under "Not signed in".
- An exhausted quota stops the turn as a usage limit. Because usage data for this provider is not read back, the limit covers only the failed model, lasts until the reset Google reported (or 30 minutes when it reported none), and auto-resume stays off; switch with `/model`.
- Web search can use the `google` family, which is explicit-only: automatic routing never picks it because each search spends subscription quota. See [Google search (Antigravity)](web-search.md#google-search-antigravity).
- Background compaction keeps its token estimate. Set `CHOCO_PI_ANTIGRAVITY_COUNT_TOKENS=1` before starting choco-pi to count the summarization prompt with Cloud Code Assist `countTokens` instead; a session reads it when its compaction starts, so changing it later affects only new sessions.

Not supported yet: image generation, reading URLs through Antigravity, more than one signed-in account, enterprise (Workspace) routing, a toggle for spending AI credits once the quota is exhausted, entries for this provider in the model fallback table, and a quota indicator in the status bar.
