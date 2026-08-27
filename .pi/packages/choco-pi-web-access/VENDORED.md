# Vendored: choco-pi-web-access

This directory is a vendored, renamed fork of the upstream open-source package `pi-web-access`.

- Original source: https://github.com/nicobailon/pi-web-access
- Base commit: `8a1748f106acb20626ace32806fc726bb0858859`
- Base version: `0.24.1`
- Forked on: 2026-08-22
- License: MIT (upstream `LICENSE` copied verbatim)

The fork exists so choco-pi can keep its web access extension in-tree while exposing only the search providers the harness uses.

## What was taken

The fork keeps the root-flat TypeScript implementation for OpenAI, Exa, and Kagi search; readable extraction and `fetch_content`; `get_search_content`; `source_check`; curator review UI/server; PDF extraction through Datalab or local unpdf; GitHub extraction; storage; authentication; cookie-backed authenticated fetch; SSRF controls; and supporting utilities. Upstream relative imports already used explicit `.ts` extensions and remain that way.

A focused subset of upstream tests was copied into `tests/`, renamed from `.test.mjs` to `.test.ts`, marked `@ts-nocheck` because the upstream JavaScript fixtures are not strict TypeScript, and trimmed to retained behavior.

## Divergences from upstream

### Identity and package wiring

- Renamed `pi-web-access` to private package `choco-pi-web-access`, version `0.24.1-choco.0`.
- Added `chocoPi.supersedes: ["pi-web-access"]`; retained direct Pi loading from `./index.ts`; removed publish metadata, media metadata, keywords, upstream scripts, and the build/publish surface.
- Added the fork `AGENTS.md`, this provenance file, and a root-extending `tsconfig.json`.
- Replaced the upstream fetch user-agent string, which named a removed provider client, with `choco-pi-web-access/0.24.1`.

### Search providers removed

Deleted these search-provider modules and all imports, routing branches, availability state, curator controls, schemas, config keys, commands, status lines, and help text that served them:

- `anysearch.ts`, `bocha.ts`, `brave.ts`, `brightdata.ts`, `duckduckgo.ts`, `firecrawl.ts`, `jina-search.ts`, `ollama.ts`, `parallel.ts`, `parallel-mcp.ts`, `perplexity.ts`, `querit.ts`, `search1api.ts`, `searchinfinity.ts`, `searxng.ts`, `serpbase.ts`, `serpdive.ts`, `serper.ts`, `tavily.ts`, `tinyfish.ts`, `valyu.ts`, and `xai-search.ts`.
- Deleted Gemini search transport modules `gemini-api.ts`, `gemini-web.ts`, and the search-related `gemini-url-context.ts` path.
- Trimmed the confusingly named `gemini-search.ts` (which is the generic provider router, not a Gemini-only module) to OpenAI, Exa, and Kagi. `SEARCH_PROVIDERS` is now exactly `auto`, `all`, `openai`, `exa`, and `kagi`.
- Added `search-types.ts` and moved the shared `SearchResult`, `SearchResponse`, and `SearchOptions` declarations there because upstream housed them in deleted `perplexity.ts`.

### Content extraction reduced

- Deleted `brightdata-unlocker.ts` and removed the Firecrawl, Jina, TinyFish, Search1API, Querit, Ollama, Parallel, Parallel MCP, Bright Data, and Gemini fetch backends. `FETCH_PROVIDERS` is now exactly `http` and `kagi`.
- Deleted `youtube-extract.ts` and `video-extract.ts`, which hard-depended on Gemini, and removed their fetch handoffs, parameters, rendering, commands, and help text.
- Deleted `gemini-pdf-extract.ts`; PDF provider values are now `auto`, `datalab`, and `unpdf`. Auto tries Datalab when configured, then local unpdf.
- Kept `gemini-web-config.ts` because its `isBrowserCookieAccessAllowed` export is the generic browser-cookie opt-in consumed by `chrome-cookies.ts`; it does not provide Gemini search. Removed its orphaned top-level `chromeProfile` parsing (`normalizeChromeProfile` and `getChromeProfileFromConfig`); authenticated fetch profiles own their live `authFetch.<name>.chromeProfile` setting.
- Removed the orphaned Google-cookie wrapper from `chrome-cookies.ts`: `getGoogleCookies`, `getLastGoogleCookieDiagnostic`, `GOOGLE_ORIGINS`, the Google cookie-name allowlist, and Gemini-specific diagnostics. The retained generic `getBrowserCookiesForHosts` and `getLastBrowserCookieDiagnostic` path still serves authenticated `fetch_content`; cookie decryption, profile selection, preflight, filtering, and password caching tests now call that generic API with neutral hosts and cookie names.
- Removed additional test-only or dead-chain exports found in the same sweep: `hasExaApiKey`, `canAttachImages`, `loadSsrfAllowRanges`, and the unused `ResearchProvider`/`ResearchSearch*` abstractions. Their retained behavior is covered through live provider, image, SSRF-config, and source-check entry points.
- Removed remaining video-only metadata and utilities missed in the first cut: `VideoFrame`, `FrameData`, `FrameResult`, `ExtractedContent.frames`/`duration`, fetch rendering and cache metadata for those fields, plus `formatSeconds`, `readExecError`, `isTimeoutError`, `trimErrorText`, and `mapFfmpegError`.

### Erasable TypeScript

- Replaced the declaration-merging `namespace` in `promise-try.d.ts` with a callable interface so the fork contains no TypeScript namespace syntax.
- No enum, decorator, or constructor parameter property required desugaring in retained runtime source.

### Dependencies

- Vendored and exactly pinned `@mozilla/readability@0.6.0`, `linkedom@0.16.11`, `turndown@7.2.4`, `p-limit@6.2.0`, `unpdf@1.8.0`, and `promise.try@2.0.1`, plus their installed transitive dependency trees, under committed `node_modules/`.
- Kept `@types/turndown` as a development dependency and added a minimal in-tree `turndown.d.ts` fallback so package-local typecheck does not depend on installing development packages.
- Moved `typebox` to peer dependencies because Pi's extension loader aliases it to the host copy. `@earendil-works/*` dependencies also remain peers.
- Dropped `undici`; upstream imported it only from deleted `gemini-web.ts`.

### Upstream files not carried

- Dropped upstream `test/` after porting the retained subset to `tests/`.
- Dropped `evidence/`, `banner.png`, `pi-web-fetch-demo.mp4`, `package-lock.json`, `.gitignore`, `README.md`, `CHANGELOG.md`, and `SECURITY.md` as upstream project, media, lock, or publication scaffolding.

### Curator lifecycle hardening

- The curator server now owns every in-flight query-rewrite abort controller until its callback settles. Completing or closing the curator synchronously aborts all rewrites; aborted or otherwise late callbacks can return only a bounded cancellation response while the HTTP response remains writable. Independent rewrites remain concurrent while the curator is open.

### Anti-slop type hardening

- Brought the vendored TypeScript to the harness standard of zero `oxlint` findings at any severity, without a single suppression: 616 anti-slop errors plus the residual `eslint`/`unicorn` warnings. No `oxlint-disable` comment, ignore pattern, or `any` was introduced, and no test assertion was relaxed. The work was split across three disjoint file partitions (search core, curator/storage/summary, fetch/extract/security) plus a warning sweep.
- The changes are type-only and behavior-preserving. Third-party JSON — search API responses, PDF and GitHub payloads, config files, cookie records, persisted results — is now parsed at its boundary into named domain types, replacing scattered representation checks, `unknown` parameters, broad dictionaries, and unjustified assertions. Every retained assertion carries a safety comment stating the invariant that makes it sound.
- The OpenAI Codex-subscription path is unchanged: `CODEX_RESPONSES_URL`, the `["openai-codex", "openai"]` provider priority, and the `OPENAI_API_KEY` fallback all behave as upstream. `credential-source.ts` gained typebox-checked string and command-failure predicates in place of inline representation checks; its credential resolution order and failure categories are unchanged.
- `credential-source.ts` control-character rejection moved from `/[\0-\x1f\x7f]/` to `/[\p{Cc}&&\p{ASCII}]/v`. The matched set was verified identical by exhaustive comparison over `U+0000`–`U+10FFFF`: exactly `U+0000`–`U+001F` plus `U+007F`, 33 code points.
- `ssrf-protection.ts` keeps its allow-range parsing, address validation, and IPv4/IPv6 blocklists. Enforcement was re-verified empirically after hardening: loopback, `localhost`, link-local cloud metadata (`169.254.169.254`), RFC1918 ranges, `0.0.0.0`, IPv6 loopback, and IPv6 ULA are all rejected while public hosts resolve. The 34 SSRF assertions pass unchanged.
- `storage.ts` persisted record format, the curator HTTP route and payload contract, and the `web_search`/`source_check` provider enum (`auto | all | openai | exa | kagi`) are unchanged. Conditional properties are still constructed by explicit statements so omission semantics survive JSON serialization.
- Removed dead state the linter surfaced: `currentProvider` in `index.ts` was declared and reassigned but never read, upstream included; `currentSearchProvider` is the value actually consumed, and the curator page keeps its own client-side copy. The `thumbnail` omission idiom was preserved by renaming the binding rather than deleting it.
