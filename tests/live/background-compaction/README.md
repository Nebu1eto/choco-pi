# Background-compaction end-to-end harness

Drives the real Pi SDK with the full worktree extension profile and checks background compaction on the actual wire, branch and session file. Run from the worktree with Node 24 or newer; no install or build step.

## Running

Two modes:

- **Offline** (default, no network): one fresh process per scenario, an offline fake Anthropic provider, global `fetch` replaced by a blocker, sealed in-memory credentials, isolated agent, project, session and HOME directories.
- **Live** (opt-in, paid): the same scenarios against a real provider; see below.

```sh
node tests/live/background-compaction/run.ts --scenario <name> --out /tmp/choco-pi/<session>/e2e/<name>
```

Exit codes: 0 every required check passed; 1 a check failed or the driver threw; 2 the scenario is pending. A required check with no runtime evidence fails. `<out>` receives redacted `events.json`, `verdicts.json` (one entry per check) and `manifest.json`; `restart-recovery` adds `workers/<phase>.json`. Never commit artifacts.

Live (`text-boundary-adoption`, `anthropic-native-adoption`, `idle-input-adoption`, `restart-recovery`, `anthropic-foreground-compaction`, `context-window-presets` only) needs `CHOCO_PI_LIVE_E2E=1` and an approved `--live provider/model`. The stored credential is read once into a sealed in-memory store, only the model origin reaches the network, `usage.json` records real provider usage, and a runaway guard stops at 10x the expected usage in `budget.ts`. For parity with a real session on the same credential, a live launch copies the source agent dir's `SYSTEM.md` into the isolated agent dir (so Pi's default harness preamble is not sent) and keeps the built-in tools; the copy is recorded by digest only (`live-parity` event).

`node --test tests/background-compaction-harness.test.ts` (part of `pnpm test`) guards the harness itself: check verdicts, redaction, live usage accounting, marker mapping and launcher isolation.

## Scenarios

| Scenario                               | What it drives                                                                                                                                                                                                                                          | Offline                                                                                                    | Live (OAuth)                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `text-boundary-adoption`               | Text candidate prepared during an active turn, adopted at the next boundary                                                                                                                                                                             | pass                                                                                                       | Haiku 5.5, before live parity: fail, first foreground request HTTP 400                                    |
| `anthropic-native-adoption`            | Native compaction block replayed byte-exact under strict thinking binding; tool-set mutation refused                                                                                                                                                    | pass                                                                                                       | not run                                                                                                   |
| `idle-input-adoption`                  | Candidate prepared while idle, adopted on the next input before any request                                                                                                                                                                             | pass                                                                                                       | Haiku 5.5, before live parity: fail, summary 200 and checkpoint carried; next foreground request HTTP 400 |
| `restart-recovery`                     | SIGKILL after persisting the candidate; a fresh process recovers and adopts it; reload keeps one checkpoint                                                                                                                                             | pass                                                                                                       | not run                                                                                                   |
| `host-compaction-arbitration`          | Context-cap route, `/compact <instructions>`, overflow without a candidate, disable plus reload                                                                                                                                                         | pass                                                                                                       | offline only                                                                                              |
| `anthropic-foreground-compaction`      | Background off, Anthropic mode `server-side`: two turns, `/compact <instructions>` answered by the server-side lane, one more turn carrying the block                                                                                                   | pass (scripted lane over global fetch)                                                                     | Fable 5.1, 2026-10-14: pass, exit 0; statuses 200, 200, lane 200 (`stop_reason: compaction`), 200         |
| `anthropic-foreground-auto-compaction` | Same path reached automatically: the Standard / Standard preset point (450,000 on the 1M mirror; answers report 460,000 input tokens) fires agent_settled `ctx.compact()` without instructions; same lane request, `AnthropicDetails` and replay checks | pass                                                                                                       | offline only                                                                                              |
| `context-window-presets`               | `contextSoftCap` / `autoCompactionPoint` presets from agent `settings.json`, then changed in-session (`writeAgentPreference`): window in `ctx.model`, the footer expression, `getContextUsage()`, `/status`, `/context`; compaction point               | pass (`--offline-model` `haiku-window-mirror`, `luna-window-mirror`, `kimi-window-mirror`, `harness-fake`) | 2026-10-14: Haiku 5.5, GPT-6 Luna and Kimi-K3 pass, exit 0 (below)                                        |
| `child-session-adoption`               | Two filtered subagent children adopt their own text checkpoints                                                                                                                                                                                         | pending: mixed native children not driven                                                                  | offline only                                                                                              |
| `codex-native-replay`                  | Codex cached-WebSocket replay                                                                                                                                                                                                                           | pending: no Codex driver                                                                                   | no driver                                                                                                 |
| `codex-long-child-turn`                | Codex child over 32 tool cycles                                                                                                                                                                                                                         | pending: no Codex driver                                                                                   | no driver                                                                                                 |
| `child-cancellation-during-adoption`   | Child cancellation and late completion during parent adoption                                                                                                                                                                                           | pending: no latches                                                                                        | offline only                                                                                              |

The `anthropic-foreground-compaction` live run (`anthropic/claude-fable-5-1`, subscription OAuth) sent four requests: two foreground turns (200, 200), one lane request with the `compact-2026-09-04` beta and `compaction: { type: "summarize", instructions }` (200, `stop_reason: "compaction"`), and the next foreground turn, whose `messages[0]` began with a block deep-equal to the persisted one, under the same beta (200). The compaction entry carried `AnthropicDetails`; no fallback notice and no local summarizer request occurred. Usage: 41,801 input tokens (mostly cache reads and writes) and 64 output tokens.

## Context window presets

`context-window-presets` seeds the live catalog mirrors (Haiku 5.5 at 1,000,000, GPT-6 Luna at 272,000; Kimi-K3 at 524,288 is registered as a mirror of the Synthetic provider extension's static registration, because an extension provider resolves no store entry before its extension loads, and the real extension re-registers over it) and applies a copy of the worktree `.pi/models.json`, which the real agent dir symlinks (Luna becomes 1,050,000). It runs one short turn, then three preset phases (four for Kimi-K3, below). Each phase runs the real `/status` and `/context` commands, keeps their report frames, and reads `ctx.model.contextWindow`, `getContextUsage().contextWindow` and the footer expression `ctx.model?.contextWindow ?? getContextUsage()?.contextWindow` in-host. The phases change no request; only the first turn reaches the provider.

The footer and statusline themselves are not observed: the SDK host has no TUI, so zentui renders nothing. The artifacts show their input (that expression) only.

The compaction point is observed two ways. Offline, it is behavioral: a turn whose context is exactly the point requests no compaction, one token more requests one (`session_before_compact` probe). Live, one short turn cannot reach it, so the point is read from production `resolvePolicy` in-host, with the live native-compaction budget hook. It is computed, not triggered.

Expected values follow the documented policy, written out rather than recomputed. Both live runs and all offline subjects matched every value:

| Phase (`contextSoftCap` / `autoCompactionPoint`) | Window, 1M-class native (Haiku 1,000,000; Luna 1,050,000) | Point   | Window, 200K native (`harness-fake`) | Point   |
| ------------------------------------------------ | --------------------------------------------------------- | ------- | ------------------------------------ | ------- |
| standard / standard                              | 600,000                                                   | 450,000 | 200,000                              | 170,000 |
| strict / standard                                | 400,000                                                   | 340,000 | 200,000                              | 170,000 |
| standard / strictest                             | 600,000                                                   | 200,000 | 200,000                              | 170,000 |

Kimi-K3 (`synthetic/hf:moonshotai/Kimi-K3`, 524,288 native; `kimi-window-mirror` offline) runs its own four phases. Headroom is 15% of the cap clamped to [24,384, 100,000]; offline and live matched every value:

| Phase (`contextSoftCap` / `autoCompactionPoint`) | Window  | Point   |
| ------------------------------------------------ | ------- | ------- |
| standard / standard                              | 524,288 | 445,645 |
| permissive / permissive                          | 524,288 | 445,645 |
| unlimited / unlimited                            | 524,288 | 445,645 |
| strict / strict                                  | 400,000 | 300,000 |

Live runs, 2026-10-14, one run per model, exit 0:

- `anthropic/claude-haiku-5-5`: one foreground request, HTTP 200, 9,879 input and 14 output tokens. `/status` shows `600,000 tokens` with no `soft cap (native …)` annotation, because the registry object the label compares against is capped too.
- `openai-codex/gpt-6-luna`: the turn ran over choco-pi-codex's own transport, outside the fetch ledger (`usage.json` shows 0 requests). Its assistant message ended `stop` with 4,712 input and 10 output tokens (`live-provider-turn` record; `live-accepted` accepts that record for provider-owned transports). `/status` shows `600,000 tokens · soft cap (native 1,050,000)`. The budget hook did not lower the point (450,000).
- `synthetic/hf:moonshotai/Kimi-K3` (id and 524,288 window confirmed from the Synthetic models list in the 4h store cache before the run): one foreground request over fetch to the model endpoint, HTTP 200 (`kind: other` in `usage.json`, which cannot parse OpenAI-compatible SSE usage). The assistant message ended `stop` with 5,283 input and 13 output tokens, `reasoning_effort: low` (off clamps to low). All four phases matched; `/status` shows `400,000 tokens · soft cap (native 524,288)` under Strict. A live Synthetic launch passes only requests under the model's base URL (`/openai/v1`); the provider's same-origin utility calls (`/v2/quotas`) would be blocked (none was attempted in this run). The `live-provider-turn` transport label was reworded after this run (it read `provider-owned, not in the fetch ledger`).

The registry entries are recorded but not asserted. A provider that re-registers (choco-pi-codex's `openai-codex`, the offline provider) returns fresh, uncapped registry objects, so the Luna registry entry reads 1,050,000 while the session model reads the capped value.

## Live blockers

- **Anthropic OAuth entitlement (earlier runs).** Before the live-parity change, every full-profile foreground request to Haiku 5.5 returned HTTP 400 `invalid_request_error` ("Third-party apps now draw from your extra usage, not your plan limits"); the tool-less summarizer request returned 200. Those runs sent Pi's default system preamble without built-in tools. The Fable 5.1 run with parity (the user's `SYSTEM.md`, built-in tools) was accepted throughout. Which difference matters is not isolated, and the Haiku scenarios have not been rerun.
- **Codex.** No live driver: Codex foreground traffic uses choco-pi-codex's cached WebSocket rather than `fetch`, and the transport checks are Anthropic-shaped.
