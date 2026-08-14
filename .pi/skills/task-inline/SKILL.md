---
name: task-inline
description: Execute a new repository-changing implementation directly in the main choco-pi agent when parallel implementation would not materially help. Use as the authoritative default modifying workflow, not for read-only, diagnostic, or operational work, or a follow-up inside an already active workflow.
---

# choco-pi Direct Implementation

Work in the main agent. Do not spawn implementation agents. A fresh read-only reviewer is the only optional child and is used only when the user or project risk policy requires it.

## 1. Prepare

1. Run `check`, plus repository gates required by applicable `AGENTS.md`.
2. Read the full path-scoped instruction chain.
3. Record the current `HEAD` as `review_base`, inspect the dirty tree, and preserve unrelated work.
4. Resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill and run `node <resolved-script> acquire --cwd "$PWD" --owner "$PI_SESSION_ID"`. Stop on a conflicting owner; never reclaim it from an apparently live session.
5. Define the objective, exclusions, affected paths, authority boundaries, and an acceptance ledger. Assign each behavior `regression_test`, `direct_check`, or `runtime_e2e` before editing.

## 2. Implement and validate

1. Inspect the closest implementation and validation surfaces.
2. Make the smallest complete change directly.
3. Add a persistent test only when the ledger justifies `regression_test`.
4. Run affected project gates, focused checks, and every non-runtime acceptance item.
5. Inspect the actual diff for objective conformance, minimality, and unrelated edits. Do not commit with known failures.

## 3. Checkpoint

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. The checkpoint creates an immutable review and runtime target but does not finish the task.

Run each required `runtime_e2e` item against that exact `HEAD` unless the user explicitly waived it. After any corrective edit, invalidate affected evidence, repeat validation, create a new checkpoint, and verify the new `HEAD`.

## 4. Review and finish

Use a fresh read-only reviewer only when required. Give it the exact `review_base..HEAD` range, applicable policy, and the minimum evidence needed for the selected review mode. Verify findings yourself before changing code.

After owned processes stop, release the lease with `node <resolved-script> release --cwd "$PWD" --owner "$PI_SESSION_ID"` only when the workflow completes or is deliberately abandoned. If retaining it for recoverable blocked work, report that ownership. Finish only when every required acceptance row is `pass` on the current state or explicitly user-`waived`.
