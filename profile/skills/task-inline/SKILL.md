---
name: task-inline
description: Direct implementation for an ordinary repository change.
---

# choco-pi Direct Implementation

Work in the main agent. Do not spawn implementation agents. A fresh read-only reviewer and a fresh `verifier` are the only optional children and follow `task-core`'s task-shaped selection rule.

## 1. Prepare

1. Read `../task-core/SKILL.md`, then run `check` unless this session already has a current result for this checkout; report readiness failures unrelated to the requested change and continue.
2. Read the full path-scoped instruction chain and apply the shared investigation and evidence mechanics.
3. Record the current `HEAD` as `review_base`, inspect the dirty tree, and preserve unrelated work.
4. Resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill and run `node <resolved-script> acquire --cwd "$PWD"`. The script identifies the calling session itself and reclaims a lease only from a provably dead holder. Stop on any other holder, since another session may be editing this checkout, and never clear the lease directory by hand. Report any other lease failure, such as no Git worktree, in one line and continue without a lease.
5. Define the acceptance items required by `task-core` before editing.

## 2. Implement and validate

1. Inspect the closest implementation and validation surfaces.
2. Make the smallest complete change directly.
3. Add a persistent test only when the acceptance items justify `regression_test`.
4. Follow `task-core`'s diagnostics sequence, affected project gates, focused checks, and every non-runtime acceptance item.
5. Inspect the actual diff for objective conformance, minimality, and unrelated edits. Do not commit with known failures.

## 3. Checkpoint

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. The checkpoint creates an immutable review and runtime target but does not finish the task.

Run each required `runtime_e2e` item against that exact `HEAD` unless the user explicitly waived it. After any corrective edit, invalidate the evidence it affects, rerun only those checks, create a new checkpoint, and verify the new `HEAD`.

When the integrated diff contains more than one coherent change, follow the commit skill's split rule; the final `HEAD` still receives repository-required gates and `runtime_e2e` proof.

## 4. Review and finish

When independent review is selected, prepare the exact `review_base..HEAD` input through `../review/references/review-bundle.md` and give the fresh read-only reviewer only its bundle path and manifest digest. Settle findings and candidates under `task-core`'s **Settle review claims** before changing code.

Spawn the reviewer under the system prompt's spawn rule and record `model`, `thinking`, `source: role|chosen|override`, and `reason`. Do not set `max_tokens`, `max_tool_calls`, `timeout_ms`, or `idle_timeout_ms` unless the user asked; the first request alone costs roughly 15–25k tokens. Pass `work_task` (a stable kebab-case id for this work task, reused across review rounds and follow-ups). A `Review round refused` result is not a spawn-parameter error: do not retry or rename the work task; triage, report remaining risk, and tell the user that `/review-continue <work_task>` authorizes another round.

After owned processes stop, release any acquired lease with `node <resolved-script> release --cwd "$PWD"` only when the workflow completes or is deliberately abandoned. If retaining it for recoverable blocked work, report that ownership. Finish only when every required acceptance item passes on the current state or is explicitly user-waived.
