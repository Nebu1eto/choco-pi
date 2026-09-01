---
name: task-core
description: Shared investigation and evidence mechanics loaded by choco-pi implementation workflows; never select as a standalone workflow.
---

# choco-pi Implementation Mechanics

`task-inline`, `task`, `task-dynamic`, and `task-hotfix` load this skill. It owns the mechanics shared by those workflows; their own skills own routing, orchestration, checkpointing, and handoff.

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

## Validate the current state

1. Inspect the diff for scope, minimality, and unintended changes.
2. Run `lsp_diagnostics` on every changed source or configuration file before broader gates. Fix blocking findings or report unavailable, partial, or stale diagnostics with the documented fallback.
3. Run the narrowest focused checks and affected project gates that prove the acceptance items.
4. Observe every `runtime_e2e` item through the real path; an exit code, static reading, or another agent's report is not runtime observation.
5. Run `diagnostics_report mode=all` before completion. Treat stale or unavailable results as incomplete evidence and report the fallback used.

A change after validation invalidates affected evidence. Repeat the relevant checks on the new state. Protected validation that mutates remote systems, databases, deployments, credentials, or published artifacts requires explicit user authority.
