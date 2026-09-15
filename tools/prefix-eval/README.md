# Prefix evaluation harness

This harness measures the system-and-tools prefix sent by Pi and runs a repeatable task matrix against a disposable fixture. It writes full request payloads and session data only to the selected output directory. Do not publish those raw artifacts without reviewing them.

## Audit one model

```sh
node tools/prefix-eval/audit.ts \
  --model anthropic/claude-opus-5 \
  --thinking medium \
  --cwd tools/prefix-eval/fixture \
  --out /tmp/choco-pi/prefix-eval/audit-opus
```

The audit sends three noninteractive prompts. It prints a short report and writes `report.json`, `capture.jsonl`, full request payloads, stdout, stderr, and the Pi session JSONL under `--out`.

## Run the task matrix

```sh
node tools/prefix-eval/run-matrix.ts \
  --models 'openai-codex/gpt-5.6-sol:low,anthropic/claude-opus-5:medium' \
  --tasks tools/prefix-eval/tasks.json \
  --fixture tools/prefix-eval/fixture \
  --out /tmp/choco-pi/prefix-eval/matrix
```

Models and tasks run sequentially. Kimi entries run last. `--resume` skips a row when its `result.json` exists. To evaluate stored workspaces and sessions again without calling a model, use:

```sh
node tools/prefix-eval/run-matrix.ts \
  --tasks tools/prefix-eval/tasks.json \
  --fixture tools/prefix-eval/fixture \
  --readjudicate /tmp/choco-pi/prefix-eval/matrix
```

Readjudication re-evaluates every stored row, including prior timeout and blocked rows, and rewrites each `result.json` plus the matrix `summary.json` and `summary.md`. It does not call a model.

Merge readjudicated matrices with comma-separated input directories:

```sh
node tools/prefix-eval/run-matrix.ts \
  --merge /tmp/choco-pi/prefix-eval/matrix-a,/tmp/choco-pi/prefix-eval/matrix-b \
  --out /tmp/choco-pi/prefix-eval/matrix-merged
```

The merged summary contains one row per model and a model-by-task verdict matrix. Anthropic request-1 prefix totals use a matching fixture audit's `count_tokens` result when present; other rows use the captured system-plus-tools character estimate.

## Metrics

- A **structural rewrite** occurs when a request's system hash or full, order-sensitive tools-array hash differs from the preceding request. This is the primary cache-stability metric.
- Tool changes report added names, removed names, and changes to the relative order of names present in both requests.
- Anthropic prefix totals and marginal section/tool measurements use `count_tokens` when authentication and the endpoint are available. Marginal values are not additive. Other providers use estimates of `ceil(chars / 4)` because this repository cannot resolve `js-tiktoken` and those providers have no count endpoint.
- **Total tokens** means `input + cacheRead + cacheWrite + output` from Pi's assistant-message usage records. Cost is summed from usage and reported separately.
- **Cache hit ratio** means `cacheRead / (input + cacheRead + cacheWrite)`.
- Cache counters are secondary evidence: an earlier run can warm a rewritten prefix variant and produce a cache hit even though the structure changed.

Noninteractive `-p` mode cannot observe interactive UI tools, so this harness does not measure that tool list.
