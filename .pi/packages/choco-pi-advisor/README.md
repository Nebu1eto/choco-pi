# Advisor

The `advisor` tool blocks inline while a fresh, read-only subagent answers a focused
`question` with optional `context`. It includes a bounded excerpt of the live branch,
streams response progress, and forwards cancellation to the subagent manager.
Advice is not evidence: the executor must verify claims before acting.

Requires the existing subagents package and an authenticated, available model.
The extension registers in root and child sessions. The advisor agent definition gives
the leaf only read-only built-ins and no extensions, so it cannot delegate or recursively
consult an advisor. Other child agents consult through the process-wide subagents manager
slot.

## Settings

Read `advisor.json` from the agent directory, then overlay `.pi/advisor.json` in the
project. Preferences writes go only to the global file, so project settings still
take precedence. Unknown keys are ignored. Invalid layers use defaults and warn in
interactive sessions.
Consults are skipped when the advisor model equals the session model with the message
`advisor is disabled for this session: the advisor model (<provider>/<id>) is the same as the session model; pick a different advisor model in /preferences`.

| Key       | Default                      | Values                                                    |
| --------- | ---------------------------- | --------------------------------------------------------- |
| `enabled` | `false`                      | Boolean                                                   |
| `model`   | `anthropic/claude-fable-5-1` | Provider/model identifier                                 |
| `effort`  | `low`                        | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `maxUses` | Absent (unlimited)           | Positive integer                                          |

The preferences cap input accepts `0` or empty to remove `maxUses`; a literal zero
in a settings file is invalid. The cap counts advisor tool results after the latest
user message, including unsuccessful calls.

## Trailer contract

Every successful result ends with this deterministic line, using the resolved model:

```text
advisor: <provider>/<modelId> effort=<effort>
```

## Known gaps

Consult records are disposed immediately after settlement; with an older subagents
build lacking `disposeSettledRecord`, interactive sessions may hold closed advisor
sessions (and their cached transports) until the retention timer evicts them.
Advisor consults exit cleanly in headless print mode because the advisor leaf loads
no extensions; print-mode runs that spawn extension-loaded subagents may still linger,
an upstream, advisor-independent behavior reproduced with a plain Agent consult.
Child consult records are not attributed to the calling child. Non-advisor children can
fan out advisor usage and cost, so configure `maxUses` with that risk in mind.
The concise answer target is a prompt instruction, not an enforced token budget.
Preferences load file values at session start; tool calls reload them live.
