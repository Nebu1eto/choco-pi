---
name: task-hotfix
description: Direct implementation for an urgent production fix.
---

# choco-pi Urgent Fix

Keep implementation in the main agent and spawn no implementation agents. A fresh read-only reviewer or `verifier` follows `task-core`'s task-shaped selection rule.

## 1. Triage

1. Read `../task-core/SKILL.md`, then run `check` unless this session already has a current result for this checkout; report readiness failures unrelated to the incident and continue.
2. Read the incident evidence and applicable instructions; apply `task-core`'s shared mechanics.
3. Record `review_base`, inspect the dirty tree, resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill, and run `node <resolved-script> acquire --cwd "$PWD"`. Stop only on a holder it does not report as dead, since another session may be editing this checkout; report any other lease failure, such as no Git worktree, in one line and continue.
4. Reproduce the failure through the narrowest reliable path and identify the most likely root cause.
5. Record the incident acceptance items required by `task-core`.

## 2. Fix and validate

1. Apply the smallest safe patch; do not fold adjacent cleanup or hardening into the incident.
2. Run the original reproduction, justified regression tests, `task-core`'s diagnostics sequence, affected project gates, and direct checks.
3. Inspect the final diff and update each acceptance item from observed results.
4. Count each `edit → run → observed failure` cycle as one attempt. After three unresolved attempts, stop and report the evidence and next decision; do not broaden scope or delegate the fix without user authority.

## 3. Checkpoint and runtime proof

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. Run required executable behavior against that exact `HEAD`. A corrective edit requires revalidation, a new checkpoint, and final-`HEAD` verification.

When the integrated diff contains more than one coherent change, follow the commit skill's split rule; the final `HEAD` still receives repository-required gates and executable-behavior proof.

## 4. Review and report

When independent review is selected, prepare its immutable input through `../review/references/review-bundle.md`; settle findings and candidates under `task-core`'s **Settle review claims**. After owned runtime cleanup, release any acquired lease with `node <resolved-script> release --cwd "$PWD"`. Report the root cause, minimal patch, exact gates and runtime observations, final revision, waivers, and remaining risk.
