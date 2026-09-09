---
name: task-core
description: Internal implementation evidence mechanics.
disable-model-invocation: true
---

# choco-pi Implementation Mechanics

`task-inline`, `task`, `task-dynamic`, and `task-hotfix` load this skill. It owns their shared investigation, acceptance, validation, and review-selection mechanics; their own skills own routing, orchestration, checkpointing, and handoff. The review-selection section below owns when to load the review-bundle reference.

## Investigate from current state

- Inspect real files, diffs, configuration, and runtime behavior before deciding. Derive paths from repository metadata or search rather than repeating a failed guess.
- With choco-pi-lsp active, discover unfamiliar source through `symbol_search`, then `module_report`, then `read_symbol` or `read_enclosing`. Use `lsp_navigation` for definitions, references, implementations, and call hierarchy.
- Use `ast_grep_search` for structural code patterns. Use `rg` for logs, prose, configuration, generated text, or queries semantic tools cannot express.
- Re-read a target immediately before editing when another agent, formatter, generator, or failed edit may have changed it. After a partial edit failure, inspect the actual diff before retrying.
- Preserve unrelated dirty-tree changes. Never discard, overwrite, stage, or commit work outside the active scope.

## Define evidence before implementation

Record the outcome, exclusions, affected scope, success criteria, authority boundaries, and one evidence mode for each required behavior:

- `regression_test`: durable coverage for important flows, authorization, data integrity, or public interfaces.
- `direct_check`: a focused command, typecheck, lint, build, or inspection proves the requirement.
- `runtime_e2e`: only the real application path can prove the behavior.

Add no test by default. A regression test must exercise production behavior or a real boundary and fail when the behavior regresses; a test that mirrors implementation constants or asserts its own fixture setup is not evidence.

The `check` skill owns environment readiness. Choose validation from the acceptance ledger and applicable repository requirements; do not impose a full repository gate pass before editing. A fresh existing automatic result may satisfy a selected check only when its record includes the completed status, scope, repository revision or exact working-tree state, and all are current for the acceptance item. A pending, cancelled, stale, unavailable, or failed result is never a pass.

## Select independent review by task shape

Use a fresh read-only reviewer when the user or project risk policy requires one. Active-model guidance may also select review for a qualifying long-running task when fresh context materially improves evidence. Do not require or forbid a reviewer from the provider or model name alone, and do not add routine review to small work. Before every review handoff, follow `../review/references/review-bundle.md`.

### Observe and recover a review run

The orchestrator owns review-run recovery. Give the first reviewer the complete immutable packet; do not rely on later steering to supply requirements, policy, target, or evidence.

Classify what was actually observed before deciding what to do:

- an observation wait ending without a result means only that the observation window ended; it is not evidence that execution failed or timed out;
- an execution failure or execution timeout is a terminal failed run only when the runner reports that terminal state;
- a cancellation request is `cancellation pending` until the runner reports terminal settlement, and must not be reported or consumed as completed;
- a completed `INCOMPLETE` review is a completed run with insufficient review evidence, not a pass; preserve its named missing input or scope limitation;
- actionable findings from partial output may be independently validated, but they do not make the review complete or clean; `NO_FINDINGS` applies only to the complete bundled target and evidence the reviewer actually reviewed.

After an observation timeout, use the runner's state or terminal notification instead of repeating the same wait, poll, or steer loop. Do not stop a still-running reviewer merely because an observation window elapsed. For an evidence defect or incomplete scope, retry only after naming and correcting the defect or revising the scope, and create a new immutable bundle when its inputs change; never loop on an identical defective packet. A transient provider or capacity failure may use the bounded retry and fallback policy in `.pi/model-guidance.md`. Do not ask an incomplete reviewer to replace `INCOMPLETE` with findings or `NO_FINDINGS`.

If a required review fails, remains cancellation-pending, or completes `INCOMPLETE` and the named defect cannot be corrected within current authority, the task is blocked or partially complete. Report the exact review state, usable partial output, missing evidence, and required next action; do not declare completion or turn a partial `NO_FINDINGS` statement into a pass.

## Validate the current state

1. Inspect the diff for scope, minimality, and unintended changes.
2. When changed files use a supported language and diagnostics are relevant to the acceptance item, run targeted `lsp_diagnostics`. Fix blocking findings or report unavailable, partial, or stale diagnostics and the focused lint, type, parse, or inspection fallback used. Do not block an unrelated prose-only change on unavailable language-server diagnostics.
3. Run the narrowest focused checks and acceptance-selected project gates that prove the acceptance items. At completion, also run every gate required by applicable repository policy.
4. Observe every `runtime_e2e` item through the real path; an exit code, static reading, or another agent's report is not runtime observation.
5. For changed files covered by the diagnostics pipeline, run `diagnostics_report mode=all` before completion. Treat stale or unavailable results as incomplete diagnostics evidence and report the focused fallback used; do not make this an unrelated prose-only gate.

A change after validation invalidates affected evidence. Repeat the relevant checks on the new state. Protected validation that mutates remote systems, databases, deployments, credentials, or published artifacts requires explicit user authority.
