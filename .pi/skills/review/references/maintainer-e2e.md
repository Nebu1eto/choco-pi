# Maintainer Fresh-Pi Review Self-Test

This is an explicit opt-in harness-maintainer check, not a routine review step. Run it only when a maintainer requests live extension-host evidence. Start from the repository root in a fresh process after package tests, and replace `<bundle>` and `<sha256>` with an immutable review bundle and its manifest digest.

```bash
pi -p 'Spawn exactly one reviewer named reviewer-e2e-validation in the background with max_turns 15, timeout_ms 120000, max_tool_calls 40, max_tokens 60000, and idle_timeout_ms 30000. Give it review bundle <bundle> with SHA-256 <sha256>. Require the structured review finding contract. Continue other work until its terminal completion notification, then call get_subagent_result exactly once and print the terminal status and reviewer output.'
```

For an explicitly requested live wall-clock termination probe, use a separate fresh process:

```bash
pi -p 'Spawn exactly one reviewer in the background with timeout_ms 1 and prompt it to inspect this repository. Wait for the terminal completion notification, call get_subagent_result exactly once, and print its terminal status. The expected status is budget_exceeded.'
```

Record each fresh process's exit status and output. Deterministic transition tests remain authoritative for tool and token caps, watchdog conclude-then-stop behavior, exact-once result reads, and slot release; this opt-in scenario checks real extension-host wiring.

## Local scripted hardening probe

This separate opt-in probe exercises the real Pi extension host, production
subagents extension, `runAgent`, manager, consolidated notification gate, and
`get_subagent_result` without external requests. It is a wiring check, not
evidence that a model follows review policy.

```bash
scratch="${TASKSCRATCH:?TASKSCRATCH must be an approved task-scratch directory}"
mkdir -p "$scratch/budget-sessions"
CHOCO_PI_HARDENING_MODE=budget \
CHOCO_PI_HARDENING_TRACE="$scratch/budget-trace.jsonl" \
  PI_OFFLINE=1 pi -p -ne \
  -e .pi/packages/choco-pi-subagents/tests/fixtures/hardening-host-probe.ts \
  --provider hardening-fixture --model parent --thinking off \
  --session-dir "$scratch/budget-sessions" \
  'Run the scripted hardening host probe.'
CHOCO_PI_HARDENING_MODE=budget \
node .pi/packages/choco-pi-subagents/tests/fixtures/hardening-host-check.ts \
  "$scratch/budget-trace.jsonl" "$scratch/budget-sessions"
```

Run manual cancellation in another fresh process with an empty session directory:

```bash
scratch="${TASKSCRATCH:?TASKSCRATCH must be an approved task-scratch directory}"
mkdir -p "$scratch/manual-stop-sessions"
CHOCO_PI_HARDENING_MODE=manual-stop \
CHOCO_PI_HARDENING_TRACE="$scratch/manual-stop-trace.jsonl" \
  PI_OFFLINE=1 pi -p -ne \
  -e .pi/packages/choco-pi-subagents/tests/fixtures/hardening-host-probe.ts \
  --provider hardening-fixture --model parent --thinking off \
  --session-dir "$scratch/manual-stop-sessions" \
  'Run the scripted manual-stop host probe.'
CHOCO_PI_HARDENING_MODE=manual-stop \
node .pi/packages/choco-pi-subagents/tests/fixtures/hardening-host-check.ts \
  "$scratch/manual-stop-trace.jsonl" "$scratch/manual-stop-sessions"
```

`budget` is the default mode. Both models are scripted local providers; neither
scenario calls a user model. In `manual-stop`, the parent calls the native
`stop_subagent` twice after steering. The child records its aborted signal but
holds stream completion until the parent barrier releases it after both stop
results. The checker requires both actual stop results to report pending, one
production stopped event, an unconsumed/unsettled matching generation before
release, then notification XML `<status>Stopped</status>` and result text
`Status: stopped`. Signal/event counts check observable cancellation delivery;
deterministic production tests separately prove no repeated manager abort call.
The manual ordering inserts stop → cancellation → pending result → repeated
stop → pending result → unwind release before abort/settlement in the common
chain below. The generous 60-second production timeout is only a fallback, not
the handshake. Barriers have bounded deadlines, and shutdown releases any held
provider stream and clears owned timers. Record both CLI exit statuses; a
checker pass alone does not prove a clean process exit.

The fixture is inert unless explicitly loaded and requires its trace path to be
provided. Expected evidence is a successful process, one
`child_provider_started` followed by one `child_provider_aborted`, no
`child_request_after_first`, a `send_message` for `subagent-notification` only
after `parent_barrier_child_settled`, that settlement record reports both
`pendingSteers: 0` and `sessionHasQueuedMessages: false`, one
`get_subagent_result` tool execution, and a final
`HARDENING_HOST_OBSERVATION` reporting `childRequests: 1`. The strict checker
parses JSONL entries rather than searching the whole transcript. It binds the
same child ID and notification generation across the event chain, requires the
actual result text `Status: budget_exceeded` in budget mode, requires notification XML status
`<status>Budget exceeded</status>` in that mode, explicitly rejects `<status>Done</status>`,
and verifies start → steer → abort → settle → send → observe → consume →
continuation order. Production exposes no `done: false` field, so this probe
claims conceptual not-done status only from those real terminal contracts. The
fixture does not duplicate production settlement logic and does not make
network-backed policy claims.

## Coordination delivery probe

This opt-in fixture runs the production extension, native `Agent`, the child's
real scoped `agent_message`, the coordination and terminal sends, and the real
`get_subagent_result`. The child uses a controlled local provider. Its unique
message marker is created inside the fixture and does not appear in the parent
prompt or `Agent` arguments.

Run the fully local scripted parent first:

```bash
scratch="${TASKSCRATCH:?TASKSCRATCH must be an approved task-scratch directory}"
mkdir -p "$scratch/coordination-local-sessions"
CHOCO_PI_COORDINATION_TRACE="$scratch/coordination-local-trace.jsonl" \
  PI_OFFLINE=1 pi -p -ne \
  -e .pi/packages/choco-pi-subagents/tests/fixtures/coordination-host-probe.ts \
  --provider coordination-fixture --model parent --thinking off \
  --session-dir "$scratch/coordination-local-sessions" \
  'Run the scripted coordination host probe.'
node .pi/packages/choco-pi-subagents/tests/fixtures/coordination-host-check.ts \
  "$scratch/coordination-local-trace.jsonl" "$scratch/coordination-local-sessions"
```

For a native Astra parent against the same controlled child, use this exact
prompt. It names the production tool sequence and child limits but cannot quote
the fixture-generated marker:

```bash
scratch="${TASKSCRATCH:?TASKSCRATCH must be an approved task-scratch directory}"
mkdir -p "$scratch/coordination-astra-sessions"
prompt='Use native Agent to spawn exactly one isolated general child named coordination-host-child with model coordination-fixture/child, thinking off, run_in_background true, max_turns 3, timeout_ms 15000, and max_tool_calls 2. Tell it to send one MESSAGE to /root with its available coordination tool and then finish normally. After Agent returns, call coordination_delivery_barrier with its agent ID. In the next context confirm the actual agent-message envelope is present, then call coordination_settlement_barrier with the same ID. In the next context confirm the matching terminal notification is present, call get_subagent_result exactly once with that ID, and finish. Do not end a response merely to flush pending messages.'
CHOCO_PI_COORDINATION_TRACE="$scratch/coordination-astra-trace.jsonl" \
  pi -p -ne \
  -e .pi/packages/choco-pi-subagents/tests/fixtures/coordination-host-probe.ts \
  --provider openai-codex --model gpt-6-astra \
  --session-dir "$scratch/coordination-astra-sessions" "$prompt"
node .pi/packages/choco-pi-subagents/tests/fixtures/coordination-host-check.ts \
  "$scratch/coordination-astra-trace.jsonl" "$scratch/coordination-astra-sessions"
```

Record the Pi and checker exit statuses separately. The checker parses the
structured trace and persisted session JSONL. It binds the child ID and result
generation across both `steer`/`triggerTurn` sends, requires the coordination
envelope in parent context immediately after the first barrier, requires the
terminal notice immediately after the settlement barrier, rejects any first
outer `agent_end` before both observations, and requires one terminal result
consumption. A pass demonstrates standard Pi safe-boundary delivery. It does not
claim that an in-flight native Astra response was interrupted; provider-native
in-flight steering is a separate behavior.
