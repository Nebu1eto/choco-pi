# e2e-revival: durable subagent revival against a real Pi 1.0.4

Opt-in harness. It is not part of `pnpm test` (no file ends in `.test.ts`).
It starts a real Pi 1.0.4 process in RPC mode with a scripted faux model
provider, so it is deterministic, needs no network, and spends no model credit.

```bash
node .pi/packages/choco-pi-subagents/tests/e2e-revival/run.ts --dry-run
node .pi/packages/choco-pi-subagents/tests/e2e-revival/run.ts                  # S1..S5
node .pi/packages/choco-pi-subagents/tests/e2e-revival/run.ts --scenario S1 --scenario S3
```

Options:

- `--pi <path>`: Pi binary. Defaults to `~/.local/pi-1.0.4/node_modules/.bin/pi`
  (absolute path in `run.ts`); any binary whose `--version` is not `1.0.4` is refused.
- `--scenario S1[,S2]`: select scenarios (repeatable). Default: all.
- `--out <dir>`: base directory; each run gets `<dir>/<run-id>/<scenario>/`.
  Default: `/tmp/choco-pi/$PI_SESSION_ID/e2e` (or `/tmp/choco-pi/e2e-revival/e2e`).
- `--subagents <index.ts>`: subagents extension entry. Default: this package's
  `src/index.ts`. Use it to run against a snapshot (see below).
- `--sleep-seconds N`: how long the child's `bash sleep` runs (default 25).
- `--dry-run`: validate arguments, the binary version, and extension entries; start nothing.

Exit code: 0 when every selected scenario passed and no Pi process survived,
1 otherwise, 2 for invalid arguments or a refused binary.

## Isolation

Each scenario gets fresh `agent/` (`PI_CODING_AGENT_DIR`, with a `settings.json`
that disables retry, sets `agentOnUsageLimit: auto-resume` and the faux default
model), `sessions/` (`PI_CODING_AGENT_SESSION_DIR`), and `repo/` (a `git init`
working directory used as cwd). Pi runs with `--no-extensions -e faux-extension.ts
-e <subagents entry> --no-skills --no-prompt-templates --no-themes
--no-context-files --no-mcp --offline` and an allowlisted environment (no
provider keys, no user Pi configuration). The root
`.pi/extensions/usage-limit-policy.ts` is not loaded.

`faux-extension.ts` registers provider `e2e-faux/scripted`, a fake usage-limit
policy in the `Symbol.for("choco-pi.usage-limit-policy")` registry keyed by the
session id (quota with reset `now + 30 s` for errors carrying
`E2E-QUOTA-EXHAUSTED`), the `/e2e-reload` command
(`ctx.reload()`), and an observation log (`observations.jsonl`) of provider calls,
policy calls, session lifecycle, and `subagents:*` events.

The scripted model reads the transcript only, so it behaves the same after a
restart: the main session calls `Agent` (background, `general-purpose`, model
`e2e-faux/scripted`); a sleep child calls `bash sleep N`, then answers; a child
that receives a new user message containing the revival marker answers
`E2E-CHILD-REVIVED-MARKER`; a quota child fails with the marker until it receives
any follow-up prompt.

## Revival marker

`run.ts` imports `buildInterruptionPrompt` from this package's `src/revival-journal.ts`,
builds the clean (`unclean: false`) and unclean (`unclean: true`) variants with no
steers, and uses their longest shared line as the marker. It is printed in the run
header and passed to the extension as `E2E_REVIVAL_MARKER`. Both the faux child
script and the revival-message checks key on it, so clean and unclean revivals are
detected the same way. The run refuses to start (exit 2) if the variants share no
line. The builder always comes from the working tree, even with `--subagents`.

## Checks

`M*` checks are mechanics: Pi started, the faux main model spawned the child,
the child ran bash, reload, SIGTERM, SIGKILL, restart, or fork happened. A failing
`M*` check marks the scenario `[HARNESS/MECHANICS FAILURE]`. `J*` checks assert
the revival contract on `subagent-journal` entries (only the fixed fields
`v`, `rootSessionId`, `at`, `suspended`, `agent.{id,handle,status,sessionFile,revivals,usageWait}`).
An unobserved step is a FAIL. When the root session holds no journal entry at
all, later journal waits are shortened to 3 s, so a build without the feature
fails quickly.

| Scenario | Disruption                                                                                                | Contract checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1       | `/e2e-reload` while the child sleeps                                                                      | running (suspended=false), then interrupted with suspended=true, then running with the same id/handle/sessionFile, child file gains a user message with the revival marker (and the faux child answers it), completed, never stopped                                                                                                                                                                                                                                                                                                   |
| S2       | SIGTERM, restart with `--session <root>`                                                                  | as S1, interrupted entry written before exit, revivals 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S3       | SIGKILL, restart with `--session <root>`                                                                  | latest entry before the kill is running with suspended=false, running after restart with revivals 1, marker message, completed, never stopped                                                                                                                                                                                                                                                                                                                                                                                          |
| S4       | child parks on the fake quota, SIGTERM, restart                                                           | waiting_for_reset with usageWait, still waiting 3 s after restart (before reset), running with `at >= resetAt`, resumed provider call in the new process, completed                                                                                                                                                                                                                                                                                                                                                                    |
| S5       | sleep child running in session A; RPC `fork` at a later user message; then RPC `switch_session` back to A | J2: the fork gains no new running/queued entry for A's agent (copied entries stamped with A's root id and older than the fork are allowed). J3: while the fork is active, no child provider call and no new marker message in the child file. J4: A gains only `subagent-journal` entries with suspended=true and status interrupted or waiting_for_reset (no other `subagent*` custom entry, no malformed journal). J5-J8 after switching back: running with the same id/handle/sessionFile, marker message, completed, never stopped |

Non-subagent lines added to A during the fork are counted as "unattributed" in
J4's evidence but do not fail it.

Runtime: about 30 s per scenario without the feature. With the feature, S4
takes about 70 s because the manager wakes 30 s after the fake reset.

## Running against a stable snapshot

While other work edits `src/` the working tree may not load. To check the
mechanics against `HEAD`:

```bash
S=/tmp/choco-pi/e2e-revival/head-snapshot
mkdir -p "$S" && git archive HEAD .pi/packages | tar -x -C "$S"
for d in .pi/packages/*/; do n=$(basename "$d"); [ -d "$d/node_modules" ] && [ ! -e "$S/.pi/packages/$n/node_modules" ] && ln -s "$PWD/$d/node_modules" "$S/.pi/packages/$n/node_modules"; done
node .pi/packages/choco-pi-subagents/tests/e2e-revival/run.ts --subagents "$S/.pi/packages/choco-pi-subagents/src/index.ts"
```

## Cleanup

Pi is spawned in its own process group. Every launched group is killed with
SIGKILL when its scenario ends, on harness errors, and on SIGINT, SIGTERM, or
SIGHUP. This also kills a child `sleep` orphaned by a SIGKILLed Pi. The run
directory is left in place as evidence: `pi-N.rpc.jsonl`, `pi-N.stderr.log`,
`observations.jsonl`, and the session files.
