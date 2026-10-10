# Active-model guidance

This file solely owns choco-pi model routing and model-specific behavioral advice. Role `default_model` and `default_thinking` values remain defaults; override them only for the task, never through an unmeasured universal effort increase.

## Routing

- **Flagship:** `anthropic/claude-fable-5-1` and `openai-codex/gpt-6-astra` are for orchestration, initial planning, and review of genuinely complex output. They are very expensive.
- **Workhorse:** `anthropic/claude-opus-5-5` and `openai-codex/gpt-6.1-sol` first. Use `anthropic/claude-opus-5` and `openai-codex/gpt-5.6-sol` only when those are unavailable. Do not choose `openai-codex/gpt-6-sol`; it is superseded by `gpt-6.1-sol`. Keep role effort defaults; tune from representative evidence rather than assuming more effort is better.
- **Utility:** `anthropic/claude-sonnet-5-5` and `openai-codex/gpt-5.6-terra` suit easy exploration and web research; use `anthropic/claude-sonnet-5` only when Sonnet 5.5 is unavailable. Give them more explicit task packets; raise effort only when task evidence warrants it.
- **Micro:** `openai-codex/gpt-6-luna` and `anthropic/claude-haiku-5-5` are only for extremely simple tasks with detailed guidance. Prefer Utility when uncertain. Do not use outdated `anthropic/claude-haiku-4-5`.
- **Specialized:** `callstack-apex/callstack/Apex` is only for React Native or Expo mobile work.
- **Fallback:** `synthetic/hf:moonshotai/Kimi-K3` has limited quota. Use it only after preferred OpenAI and Anthropic models are unavailable. Never route non-mobile work to Apex.

On capacity errors, retry the same model three times with bounded backoff, then use the comparable other provider. On rate limits, move Fable to Opus, another Anthropic model to comparable OpenAI or Kimi K3, and OpenAI to comparable Anthropic or Kimi K3. `splitDeferredTools` is available only for `openai-codex` and `openai-responses`; compact descriptions benefit all providers, but deferred loading must not alter shared tool semantics.

`.pi/model-fallbacks.json` mirrors the tier list above for usage-limit fallback; update both together.

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

<!-- choco-pi:model-guidance anthropic/claude-fable-5-1 -->

Fable: ground long-run progress in observed evidence and milestones. Use asynchronous subagents for safe independent work and fresh verification only when task risk warrants it. Prefer targeted edits; rewrite a whole file only when it is short or mostly changing. At low effort, search when freshness or missing evidence matters instead of answering from memory.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-sonnet-5-5 -->

Sonnet 5.5: finish the authorized scope before ending the turn; do not stop to confirm work the request already covers. Run a check that exercises each change before reporting it done. Add no tests, docs, or files beyond the request, and start no review rounds or reviewer subagents of your own.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-haiku-5-5 -->

Haiku 5.5: keep working through a long task until every requested part is done or a blocker needs the user. Search when the answer could have changed since training; verify each change with a real check before reporting it. Keep reasoning out of user-facing text.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance openai-codex/gpt-6.1-sol,openai/gpt-6.1-sol,openai-codex/gpt-6-sol,openai/gpt-6-sol,openai-codex/gpt-6-luna,openai/gpt-6-luna,openai-codex/gpt-5.6-sol,openai/gpt-5.6-sol,openai-codex/gpt-5.6-terra,openai/gpt-5.6-terra,openai-codex/gpt-5.6-luna,openai/gpt-5.6-luna -->

Sol: infer intended work from context while preserving hard constraints, approvals, and success criteria. Use established effort as the baseline and compare one level lower on representative work.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance openai-codex/gpt-6-astra,openai/gpt-6-astra -->

Astra: carry authorized work through routine gaps and ask only when input could change the outcome. Apply skill and repository instructions within their scope and authority; when one makes you pause or leave work unfinished, name the file and quote the instruction. Delegate parallelizable work to subagents when it saves time or improves quality. Keep tests proportional and avoid repeated checks without new cause.
<!-- choco-pi:model-guidance:end -->
