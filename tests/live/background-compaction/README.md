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

Live (`text-boundary-adoption`, `anthropic-native-adoption`, `idle-input-adoption`, `restart-recovery`, `anthropic-foreground-compaction` only) needs `CHOCO_PI_LIVE_E2E=1` and an approved `--live provider/model`. The stored credential is read once into a sealed in-memory store, only the model origin reaches the network, `usage.json` records real provider usage, and a runaway guard stops at 10x the expected usage in `budget.ts`. For parity with a real session on the same credential, a live launch copies the source agent dir's `SYSTEM.md` into the isolated agent dir (so Pi's default harness preamble is not sent) and keeps the built-in tools; the copy is recorded by digest only (`live-parity` event).

`node --test tests/background-compaction-harness.test.ts` (part of `pnpm test`) guards the harness itself: check verdicts, redaction, live usage accounting, marker mapping and launcher isolation.

## Scenarios

| Scenario                               | What it drives                                                                                                                                                          | Offline                                   | Live (OAuth)                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `text-boundary-adoption`               | Text candidate prepared during an active turn, adopted at the next boundary                                                                                             | pass                                      | Haiku 5.5, before live parity: fail, first foreground request HTTP 400                                    |
| `anthropic-native-adoption`            | Native compaction block replayed byte-exact under strict thinking binding; tool-set mutation refused                                                                    | pass                                      | not run                                                                                                   |
| `idle-input-adoption`                  | Candidate prepared while idle, adopted on the next input before any request                                                                                             | pass                                      | Haiku 5.5, before live parity: fail, summary 200 and checkpoint carried; next foreground request HTTP 400 |
| `restart-recovery`                     | SIGKILL after persisting the candidate; a fresh process recovers and adopts it; reload keeps one checkpoint                                                             | pass                                      | not run                                                                                                   |
| `host-compaction-arbitration`          | Context-cap route, `/compact <instructions>`, overflow without a candidate, disable plus reload                                                                         | pass                                      | offline only                                                                                              |
| `anthropic-foreground-compaction`      | Background off, Anthropic mode `server-side`: two turns, `/compact <instructions>` answered by the server-side lane, one more turn carrying the block                   | pass (scripted lane over global fetch)    | Fable 5.1, 2026-10-14: pass, exit 0; statuses 200, 200, lane 200 (`stop_reason: compaction`), 200         |
| `anthropic-foreground-auto-compaction` | Same path reached automatically: context-cap `compactAt` (agent_settled, `ctx.compact()` without instructions); same lane request, `AnthropicDetails` and replay checks | pass                                      | offline only                                                                                              |
| `child-session-adoption`               | Two filtered subagent children adopt their own text checkpoints                                                                                                         | pending: mixed native children not driven | offline only                                                                                              |
| `codex-native-replay`                  | Codex cached-WebSocket replay                                                                                                                                           | pending: no Codex driver                  | no driver                                                                                                 |
| `codex-long-child-turn`                | Codex child over 32 tool cycles                                                                                                                                         | pending: no Codex driver                  | no driver                                                                                                 |
| `child-cancellation-during-adoption`   | Child cancellation and late completion during parent adoption                                                                                                           | pending: no latches                       | offline only                                                                                              |

The `anthropic-foreground-compaction` live run (`anthropic/claude-fable-5-1`, subscription OAuth) sent four requests: two foreground turns (200, 200), one lane request with the `compact-2026-09-04` beta and `compaction: { type: "summarize", instructions }` (200, `stop_reason: "compaction"`), and the next foreground turn, whose `messages[0]` began with a block deep-equal to the persisted one, under the same beta (200). The compaction entry carried `AnthropicDetails`; no fallback notice and no local summarizer request occurred. Usage: 41,801 input tokens (mostly cache reads and writes) and 64 output tokens.

## Live blockers

- **Anthropic OAuth entitlement (earlier runs).** Before the live-parity change, every full-profile foreground request to Haiku 5.5 returned HTTP 400 `invalid_request_error` ("Third-party apps now draw from your extra usage, not your plan limits"); the tool-less summarizer request returned 200. Those runs sent Pi's default system preamble without built-in tools. The Fable 5.1 run with parity (the user's `SYSTEM.md`, built-in tools) was accepted throughout. Which difference matters is not isolated, and the Haiku scenarios have not been rerun.
- **Codex.** No live driver: Codex foreground traffic uses choco-pi-codex's cached WebSocket rather than `fetch`, and the transport checks are Anthropic-shaped.
