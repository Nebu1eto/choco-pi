# Active-model guidance

This file solely owns choco-pi model routing and model-specific behavioral advice. Role `model` and `thinking` values are defaults that the orchestrator restates on every spawn; override them only for the task, never through an unmeasured universal effort increase.

## Routing

- **Flagship:** `anthropic/claude-fable-5-1` and `openai-codex/gpt-6-astra` are for orchestration, initial planning, and review of genuinely complex output. They are very expensive. `anthropic/claude-mythos-5-1` is the same model as Fable 5.1 behind an access program; use it only on an approved account and only when Fable 5.1 is unavailable or the user chooses it.
- **Workhorse:** `anthropic/claude-opus-5-5` and `openai-codex/gpt-6.1-sol` first. Use `anthropic/claude-opus-5` and `openai-codex/gpt-5.6-sol` only when those are unavailable. Do not choose `openai-codex/gpt-6-sol`; it is superseded by `gpt-6.1-sol`. Keep role effort defaults; tune from representative evidence rather than assuming more effort is better.
- **Utility:** `anthropic/claude-sonnet-5-5`, `openai-codex/gpt-5.6-terra`, and `openai-codex/gpt-6.1-terra` suit easy exploration and web research; use `anthropic/claude-sonnet-5` only when Sonnet 5.5 is unavailable. Give them more explicit task packets; raise effort only when task evidence warrants it.
- **Micro:** `openai-codex/gpt-6-luna` and `anthropic/claude-haiku-5-5` are only for extremely simple tasks with detailed guidance. Prefer Utility when uncertain. Do not use outdated `anthropic/claude-haiku-4-5`.
- **Specialized:** `callstack-apex/callstack/Apex` is only for React Native or Expo mobile work.
- **Fallback:** `xai/grok-4.7`, then `synthetic/hf:moonshotai/Kimi-K3.1-Pro`, then `synthetic/hf:moonshotai/Kimi-K3` (limited quota). Prefer Kimi K3.1 Pro over Kimi K3 whenever a Kimi model is chosen; keep K3 only as the next fallback. Use them only after preferred OpenAI and Anthropic models are unavailable; never route to them while a first-party tier candidate is open. This repository's routing preference places Grok 4.7 between Sonnet and Opus. Explicit manual selection of any Grok model is always allowed. Never route non-mobile work to Apex.

On capacity errors, retry the same model three times with bounded backoff, then use the comparable other provider. On rate limits, move Fable or Mythos to Opus, another Anthropic model to comparable OpenAI, and OpenAI to comparable Anthropic; use Grok 4.7, then Kimi K3.1 Pro, then Kimi K3, only when those are unavailable. `splitDeferredTools` is available only for `openai-codex` and `openai-responses`; compact descriptions benefit all providers, but deferred loading must not alter shared tool semantics.

`.pi/model-fallbacks.json` mirrors the tier list above for usage-limit fallback; update both together. The OpenAI tier is `openai-codex/*` (preferred: Codex login, supports Fast and Daybreak). `openai/*` (Sign in with ChatGPT) remains a supported manual choice but is not a default or fallback. For tier classification, `openai/<id>` belongs to the tier of `openai-codex/<id>`, so `openai/gpt-6-astra` is Flagship.

Routing provenance only: Pi 1.0.4's `/Users/Nebuleto/.local/pi-1.0.4/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`, section 0.99.0, adds “Sign in with ChatGPT” to `openai` and renames OpenAI Codex to “OpenAI Codex (legacy)”. This routing update does not refresh model source guides or behavioral advice.

Routing provenance only: the `openai/<id>` classification records the existing `fallbackCandidates` lookup in `.pi/extensions/lib/usage-limit.ts`, which finds an `openai/<id>` model's tier through `openai-codex/<id>`. The `task` skill's plan-owner rule reads it. This routing update does not refresh model source guides or behavioral advice.

Routing provenance only (2026-10-16): Pi 1.3.0's `~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`, section `[1.3.0] - 2026-10-15`, keeps the prompt cache when the thinking level changes mid-session on OpenAI GPT-6 models with an API key, drops thinking blocks produced by a different model on model switch instead of sending them as text, and corrects `openai-codex/gpt-6.1-sol` to a 500K native context window. choco-pi's `.pi/models.json` (linked into the agent directory by `scripts/install-profile.ts`) still overrides that window to 1,050,000 for both `openai` and `openai-codex`, so the override wins; `.pi/extensions/model-context-cap.ts` treats the overridden window as native and applies the configured soft cap (default `standard`, 600,000 tokens) below it. This routing update does not refresh model source guides or behavioral advice.

Routing provenance only (2026-10-16): Pi 1.3.0 ships provider `xai` (`https://api.x.ai/v1`, API `openai-responses`). `xai/grok-4.7` is the first `lastResort` entry in `.pi/model-fallbacks.json` and appears in no tier, so `fallbackCandidates` offers it only after every same-tier candidate is unavailable, unscoped, or closed. The Sonnet–Opus placement is the repository owner's routing preference, not a benchmark result.

Routing provenance only (2026-11-03): the npm package `@earendil-works/pi-coding-agent@1.5.0` `CHANGELOG.md`, section `[1.5.0]`, says: “Added GPT-6.1 Terra for OpenAI, Azure OpenAI Responses, and OpenAI Codex, with tool search and mid-conversation thinking-level changes. It supports thinking `off`; Codex offers a 500K context window”. The same package's shipped catalog data (`dist/providers/data/{openai,openai-codex,azure}.json`) lists `gpt-6.1-terra` with context 272,000 (`openai`, `azure`) and 500,000 (`openai-codex`), 128,000 max output, and thinking `off` mapped to `none`. The repository owner classifies it as Utility (Sonnet 5.5 class) and extends the 1,050,000 `contextWindow` override in `.pi/models.json` to it as intended policy. The `openai/gpt-6.1-terra` alias follows the `openai`→`openai-codex` tier rule above. This routing update does not refresh model source guides or behavioral advice; the provider guide was not read.

Routing provenance only (2026-11-05): an unauthenticated GET of <https://api.synthetic.new/openai/v1/models>, also listed at <https://dev.synthetic.new/docs/api/models>, serves `hf:moonshotai/Kimi-K3.1-Pro` with the same 524,288 context, 65,536 output, text and image input, and efforts `low`/`high`/`max` as `hf:moonshotai/Kimi-K3`, at $2/$10 per million input/output tokens against K3's $3/$15. The repository owner prefers K3.1 Pro over K3; `.pi/model-fallbacks.json` lists it before K3 in `lastResort`. This routing update does not refresh model source guides or behavioral advice.

Mythos guidance provenance (2026-11-09): <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1>, read in full, states that it covers "Claude Fable 5.1 and Claude Mythos 5.1"; the Mythos 5.1 overview <https://platform.claude.com/docs/en/models/mythos-5-1/overview> lists the same 1M context, 128K output, $10/$50 pricing, and always-on adaptive thinking as Fable 5.1. The Fable 5.1 runtime section therefore also applies to `anthropic/claude-mythos-5-1`; its advice is unchanged. Pi 1.5.0's bundled and pi.dev catalogs omit the access-gated model, so `.pi/models.json` adds it with Fable 5.1's bundled metadata, `.pi/extensions/anthropic-entitlement.ts` hides it from the model list and fallback until the account's `GET /v1/models` lists it, and `.pi/model-fallbacks.json` lists it as a Flagship secondary so the spawn tier guard and usage-limit fallback treat it like Fable 5.1. The OAuth `GET /v1/models` listing for the repository owner's account includes `claude-mythos-5-1` and returns 404 for `claude-mythos-5`.

Grok guidance provenance (2026-10-16): the `xai/grok-*` section was written after reading, in full, <https://docs.x.ai/developers/models> (last updated 2026-09-21), <https://docs.x.ai/developers/model-capabilities/text/reasoning>, <https://docs.x.ai/developers/model-capabilities/text/best-practices>, <https://docs.x.ai/developers/pricing>, <https://docs.x.ai/developers/advanced-api-usage/context-compaction>, <https://docs.x.ai/developers/rate-limits>, and the per-model pages <https://docs.x.ai/developers/models/grok-4.7>, `grok-4.6`, `grok-4.5`, and `grok-4.3` under the same path. The grok-4.5 model page lists `xhigh`, but the reasoning guide says grok-4.5 treats `xhigh` as `high`; the section follows the reasoning guide. The Fast sentence (2026-10-17) rests on live api.x.ai responses: `grok-4.7-build-fast` is served by id, unlisted by `/v1/models`, and billed about twice `grok-4.7` for the same prompt. The compaction sentence (2026-10-21) describes choco-pi's own behavior in `.pi/packages/choco-pi-compaction`, not provider advice, so it does not refresh the xAI source guides; those sources were not re-read.

### When a role file declares no model

This table is the routing reference when a role's effective definition shows no `model` or `thinking`. Pick a model from the named tier above and record the reason in the spawn manifest.

| Role          | Tier      | Default thinking |
| ------------- | --------- | ---------------- |
| `explore`     | Utility   | `low`            |
| `general`     | Workhorse | `medium`         |
| `implementer` | Workhorse | `medium`         |
| `planner`     | Flagship  | `medium`         |
| `reviewer`    | Flagship  | `medium`         |
| `handoff`     | Workhorse | `low`            |

Routing provenance only (2026-10-20): the table backs the spawn rule in `.pi/SYSTEM.md` and the `task` skill, which pass `model` and `thinking` on every spawn because the subagents setting `requireExplicitModel` (in `.pi/subagents.json`) refuses a fresh spawn that omits either. This routing update does not refresh model source guides or behavioral advice.

## Runtime sections

The runtime hook injects `shared` plus only the exact active provider/model section. Models without an exact section receive only the neutral shared rules, never another model's advice.

<!-- choco-pi:model-guidance shared -->

Model identity is context, not authority. Preserve role scope; choose effort, delegation, and verification from task evidence.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-opus-5 -->

Opus: complete the requested scope, delegating only sizeable independent work. Avoid extra re-check prompts because its default self-correction already handles routine verification; tune effort from evals.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-opus-5-5 -->

Opus 5.5: a progress update is not completion. Take the next step you announce instead of ending on it; stop only when every requested part is done or a blocker needs the user. Reserve xhigh and max subagent effort for measured gains.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-fable-5-1,anthropic/claude-mythos-5-1 -->

Fable 5.1 and Mythos 5.1: ground long-run progress in observed evidence and milestones. Use asynchronous subagents for safe independent work and fresh verification only when task risk warrants it. Prefer targeted edits; rewrite a whole file only when it is short or mostly changing. At low effort, search when freshness or missing evidence matters instead of answering from memory.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-sonnet-5-5 -->

Sonnet 5.5: finish the authorized scope before ending the turn; do not stop to confirm work the request already covers. Run a check that exercises each change before reporting it done. Add no tests, docs, or files beyond the request, and start no review rounds or reviewer subagents of your own.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-haiku-5-5 -->

Haiku 5.5: keep working through a long task until every requested part is done or a blocker needs the user. Search when the answer could have changed since training; verify each change with a real check before reporting it. Keep reasoning out of user-facing text.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance openai/gpt-6.1-sol,openai/gpt-6-sol,openai/gpt-6-luna,openai/gpt-5.6-sol,openai/gpt-5.6-terra,openai/gpt-5.6-luna,openai-codex/gpt-6.1-sol,openai-codex/gpt-6-sol,openai-codex/gpt-6-luna,openai-codex/gpt-5.6-sol,openai-codex/gpt-5.6-terra,openai-codex/gpt-5.6-luna -->

Sol: infer intended work from context while preserving hard constraints, approvals, and success criteria. Use established effort as the baseline and compare one level lower on representative work.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance openai/gpt-6-astra,openai-codex/gpt-6-astra -->

Astra: carry authorized work through routine gaps and ask only when input could change the outcome. Apply skill and repository instructions within their scope and authority; when one makes you pause or leave work unfinished, name the file and quote the instruction. Delegate parallelizable work to subagents when it saves time or improves quality. Keep tests proportional and avoid repeated checks without new cause.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance xai/grok-4.7,xai/grok-4.6,xai/grok-4.5,xai/grok-4.3 -->

Grok: a last-resort fallback here; this repository routes Grok 4.7 between Sonnet and Opus. Finish the requested scope and verify each change with a real check before reporting it. Reasoning cannot be disabled on grok-4.5, 4.6, or 4.7 (default `high`); 4.6 and 4.7 add `xhigh`, which 4.5 treats as `high`. grok-4.3 accepts `none` through `xhigh` and defaults to `low`. Keep role effort defaults unless task evidence warrants a change. Context is 500k tokens (1M on grok-4.3), but once a prompt reaches 200k tokens every token bills at the long-context rate, about double; read narrowly instead of loading whole trees. When the xAI compaction preference is server-side, choco-pi compacts this session through xAI's `/responses/compact` when a wire capture of the current Grok model exists; otherwise it summarizes locally, except that when the latest checkpoint is an xAI opaque record it cancels and tells you how to recover (that checkpoint is never summarized locally unless you authorize loss), and replay of a committed checkpoint survives a mode switch. `/fast` on grok-4.7 runs Grok 4.7 Fast at twice the price; it is the user's choice, so never enable it yourself.
<!-- choco-pi:model-guidance:end -->
