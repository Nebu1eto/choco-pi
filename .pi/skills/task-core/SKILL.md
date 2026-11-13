---
name: task-core
description: Internal implementation evidence mechanics.
disable-model-invocation: true
---

# choco-pi Implementation Mechanics

`task-inline`, `task`, `task-dynamic`, and `task-hotfix` load this skill. It owns their shared investigation, acceptance, validation, and review-selection mechanics; their own skills own routing, orchestration, checkpointing, and handoff.

## Investigate from current state

- Inspect real files, diffs, configuration, and runtime behavior before deciding. Derive paths from repository metadata or search rather than repeating a failed guess.
- With choco-pi-lsp active, discover unfamiliar source through `symbol_search`, then `module_report`, then `read_symbol` or `read_enclosing`. Use `lsp_navigation` for definitions, references, implementations, and call hierarchy.
- Use `ast_grep_search` for structural code patterns. Use `rg` for logs, prose, configuration, generated text, or queries semantic tools cannot express.
- Re-read a target just before editing when another agent, formatter, generator, or failed edit may have changed it. After a partial edit failure, inspect the actual diff before retrying.
- Preserve unrelated dirty-tree changes. Never discard, overwrite, stage, or commit work outside the active scope.

## Define evidence before implementation

Record the outcome, exclusions, affected scope, success criteria, authority boundaries, and one evidence mode for each required behavior:

- `regression_test`: durable coverage for important flows, authorization, data integrity, or public interfaces.
- `direct_check`: a focused command, typecheck, lint, build, or inspection proves the requirement.
- `runtime_e2e`: only the real application path can prove the behavior.
- `property_test`: a property-based test of the real code over generated inputs, for parsers, reducers, and normalisation.
- `model_check`: a bounded model under the `formal-verify` skill, for ordering and state rules. A pass covers the model within its bounds, not the code.

When the repository has `formal/**/coverage.json` records, resolve `../formal-verify/scripts/drift.ts` relative to this skill and run `node <resolved-script> affected --files <planned files>` from the repository root. Exit 3 means the plan touches code a model or property test covers; re-run that artifact and then update its coverage record.

Advisor output is never an evidence mode; it may only suggest what to verify.

Add no test by default. A regression test must exercise production behavior or a real boundary and fail when the behavior regresses; a test that mirrors implementation constants or asserts its own fixture setup is not evidence.

The `check` skill owns environment readiness. Run it once per session and checkout; later requests reuse that result unless the checkout, the Pi process, or the capabilities the work needs have changed. Readiness or lease failures unrelated to the requested change, such as a capability it does not need or a target outside Git, are reported and do not block the work. Choose validation from the acceptance items and applicable repository requirements; do not impose a full repository gate pass before editing. Run checks appropriate to the change; repeat or broaden them only after a new change, a failure, or a specific unresolved concern. A check that cannot run because its tool or service is missing, such as an uninstalled linter, is reported once and not rerun until that changes. A fresh existing automatic result may satisfy a selected check only when its record includes the completed status, scope, repository revision or exact working-tree state, and all are current for the acceptance item. A pending, cancelled, stale, unavailable, or failed result is never a pass.

## Select independent review by task shape

Use a fresh read-only reviewer when the user or project risk policy requires one. Active-model guidance may also select review for a qualifying long-running task when fresh context materially improves evidence. Do not require or forbid a reviewer from the provider or model name alone, and do not add routine review to small work. Before every review handoff, follow `../review/references/review-bundle.md`.

The same rule selects a fresh `verifier`, which follows the `verify` skill to reproduce review claims. Launch it on the exact state to verify, normally the checkpoint `HEAD`, with the work task, checkout path, and one or more review claims plus the bundle path and digest. Pass `work_task` as for a reviewer; verification launches do not consume review rounds. Treat `Verification round refused` like `Review round refused`; `/verify-continue <work_task>` authorizes another round.

### Settle review claims

When independent review was selected, its findings and candidates stay advisory until proved. Prove one yourself or give it to a `verifier` as a claim. Settle every candidate like a finding; never skip one for its class. The implementer turns a `CONFIRMED` reproduction into the regression test for the fix. A failed reproduction is not a refutation: an `UNPROVEN` claim keeps its severity and needs an explicit disposition (accept and fix, reject with a reason, or carry as stated risk), because some defects, such as a wrong test oracle, documentation, or policy, only a reader catches. Read the `Verdict record:` line on every reviewer and verifier result; a review recorded as `MISSING` or invalid is unrecorded and is never reported as clean.

### Observe and recover a review run

The orchestrator owns review-run recovery. Give the first reviewer the complete immutable packet; do not rely on later steering to supply requirements, policy, target, or evidence.

Classify what was actually observed:

- an observation wait that ends without a result is not evidence that execution failed or timed out;
- an execution failure or execution timeout is a terminal failed run only when the runner reports that terminal state;
- a cancellation request stays `cancellation pending` until the runner reports terminal settlement; never report or consume it as completed;
- a completed `INCOMPLETE` review is a completed run with insufficient review evidence, not a pass; preserve its named missing input or scope limitation;
- actionable findings from partial output may be independently validated, but they do not make the review complete or clean; `NO_FINDINGS` applies only to the complete bundled target and evidence the reviewer actually reviewed.

After an observation timeout, rely on the runner's state or terminal notification. Do not stop a still-running reviewer because an observation window elapsed. For an evidence defect or incomplete scope, retry only after naming and correcting the defect or revising the scope. A transient provider or capacity failure may use the bounded retry and fallback policy in `.pi/model-guidance.md`. Do not ask an incomplete reviewer to replace `INCOMPLETE` with findings or `NO_FINDINGS`.

If a required review fails, remains cancellation-pending, or completes `INCOMPLETE` and the named defect cannot be corrected within current authority, the task is blocked or partially complete. Report the exact review state, usable partial output, missing evidence, and required next action; do not declare completion.

## Validate the current state

1. Inspect the diff for scope, minimality, and unintended changes.
2. When changed files use a supported language and diagnostics are relevant to the acceptance item, run targeted `lsp_diagnostics`. Fix blocking findings, or report unavailable, partial, or stale diagnostics and the fallback check used.
3. Run the narrowest focused checks and acceptance-selected project gates that prove the acceptance items, scaled to the change's size and risk. At completion, also run every gate applicable repository policy requires, whatever the change size.
4. Observe every `runtime_e2e` item through the real path; an exit code, static reading, or another agent's report is not runtime observation.
5. When a code change spans several files covered by the diagnostics pipeline, run `diagnostics_report mode=all` before completion, since targeted checks miss cross-file breakage; a one-file change needs only step 2. Report stale or unavailable results as incomplete, with the fallback used.

A change after validation invalidates affected evidence. Repeat the relevant checks on the new state. Protected validation that mutates remote systems, databases, deployments, credentials, or published artifacts requires explicit user authority.

Acceptance-selected extension-host and TUI checks use a fresh separate Pi process, and real-Pi suites remain opt-in.

## Post-task session audit

Run this audit only after multi-unit `task` or `task-dynamic` work or on user request, not for small `task-inline` or `task-hotfix` changes. The root orchestrator audits the task lineage once from a recorded cutoff; leaf and workflow agents do not repeat it. Historical sweeps require an explicit request and remain bounded and incremental. Exclude audit workers created after the cutoff to prevent recursion.

Report coverage limits, recurring failures or retries, repeated review findings, and only new durable lessons. Never expose secrets or mutate, delete, steer, compact, or annotate sessions; report unavailable records instead of inventing coverage.
