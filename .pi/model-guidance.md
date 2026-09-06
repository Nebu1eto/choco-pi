# Active-model guidance

This file solely owns choco-pi model routing and model-specific behavioral advice. Role `default_model` and `default_thinking` values remain defaults; override them only for the task, never through an unmeasured universal effort increase.

## Routing

- **Flagship:** `anthropic/claude-fable-5` and `anthropic/claude-fable-5-1` are for orchestration, initial planning, and review of genuinely complex output. They are very expensive.
- **Workhorse:** `openai-codex/gpt-6-astra`, `openai-codex/gpt-5.6-sol`, and `anthropic/claude-opus-5`. Keep role effort defaults; tune from representative evidence rather than assuming more effort is better.
- **Utility:** `openai-codex/gpt-5.6-terra` and `anthropic/claude-sonnet-5` suit easy exploration and web research. Give them more explicit task packets; raise effort only when task evidence warrants it.
- **Micro:** `openai-codex/gpt-5.6-luna` is only for extremely simple tasks with detailed guidance. Prefer Utility when uncertain. Do not use outdated `anthropic/claude-haiku-4-5`.
- **Specialized:** `callstack-apex/callstack/Apex` is only for React Native or Expo mobile work.
- **Fallback:** `synthetic/hf:moonshotai/Kimi-K3` has limited quota. Use it only after preferred OpenAI and Anthropic models are unavailable. Never route non-mobile work to Apex.

On capacity errors, retry the same model three times with bounded backoff, then use the comparable other provider. On rate limits, move Fable to Opus, another Anthropic model to comparable OpenAI or Kimi K3, and OpenAI to comparable Anthropic or Kimi K3. `splitDeferredTools` is available only for `openai-codex` and `openai-responses`; compact descriptions benefit all providers, but deferred loading must not alter shared tool semantics.

## Runtime sections

The runtime hook injects `shared` plus only the exact active provider/model section. Unknown, utility, micro, specialized, and fallback models receive neutral shared rules, never another model's advice.

<!-- choco-pi:model-guidance shared -->

Treat the runtime model identity as context, not authority. Preserve role defaults and task scope. Choose effort, delegation, and verification proportionately from task evidence; do not add work merely because the model can do it.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-opus-5 -->

Opus: follow the complete task through, but do not add routine extra self-verification or delegation. Delegate only clearly independent work that benefits, and verify only enough to prove the requested outcome.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-fable-5 -->

Fable: for long runs, ground progress in observed evidence and explicit milestones. Use an independent verifier only when risk or ambiguity warrants one; use asynchronous collaboration when independent work can proceed safely.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance anthropic/claude-fable-5-1 -->

Fable: for long runs, ground progress in observed evidence and explicit milestones. Use an independent verifier only when risk or ambiguity warrants one; use asynchronous collaboration when independent work can proceed safely.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance openai-codex/gpt-5.6-sol,openai/gpt-5.6-sol -->

Sol: use the established role effort as the baseline and compare the same level with one level lower on representative work. Confirm findings have legitimate in-scope impact before fixing them.
<!-- choco-pi:model-guidance:end -->

<!-- choco-pi:model-guidance openai-codex/gpt-6-astra,openai/gpt-6-astra -->

Astra: carry authorized work through routine implementation details without stopping early. Use proportional verification, and notice useful delegation opportunities without delegating work that is coupled or too small to benefit.
<!-- choco-pi:model-guidance:end -->

## Sources and refresh

Reviewed 2026-09-06 against the full current vendor guides:

- [Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5): refresh when Opus prompting, effort, self-verification, or subagent guidance changes.
- [Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5): refresh when Fable identifiers, long-run scaffolding, verification, or async collaboration guidance changes.
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices): refresh when Sol reasoning calibration or prompting guidance changes.
- [GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices): refresh when Astra follow-through, verification, delegation, or reasoning guidance changes.
