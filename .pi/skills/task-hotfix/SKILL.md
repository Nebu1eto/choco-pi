---
name: task-hotfix
description: Direct implementation for an urgent production fix.
---

# choco-pi Urgent Fix

Keep implementation in the main agent. Do not spawn implementation agents. A fresh read-only reviewer is optional under `task-core`'s task-shaped selection rule.

## 1. Triage

1. Read `../task-core/SKILL.md`, then run `check`; do not wait for optional capabilities unrelated to the incident.
2. Read the incident evidence and applicable instructions, applying the shared investigation and evidence mechanics.
3. Record `review_base`, inspect the dirty tree, resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill, and run `node <resolved-script> acquire --cwd "$PWD"`. The script identifies the calling session itself; stop on a conflicting owner it does not report as dead.
4. Reproduce the failure through the narrowest reliable path and identify the most likely root cause.
5. Record the incident acceptance ledger required by `task-core`.

## 2. Fix and validate

1. Apply the smallest safe patch; do not fold adjacent cleanup or hardening into the incident.
2. Run the original reproduction, justified regression tests, `task-core`'s diagnostics sequence, affected project gates, and direct checks.
3. Inspect the final diff and update every acceptance row from observed results.
4. Count each `edit → run → observed failure` cycle as one attempt. After three unresolved attempts, stop and report the evidence and next decision; do not silently broaden scope or delegate the fix unless the user authorizes it.

## 3. Checkpoint and runtime proof

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. Run required executable behavior against that exact `HEAD`. A corrective edit invalidates affected evidence and requires validation, a new checkpoint, and final-`HEAD` verification again.

## 4. Review and report

When independent review is selected, prepare its immutable input through `../review/references/review-bundle.md`; independently validate any finding. After owned runtime cleanup, release the lease with `node <resolved-script> release --cwd "$PWD"`. Report the root cause, minimal patch, exact gates and runtime observations, final revision, waivers, and remaining risk.
