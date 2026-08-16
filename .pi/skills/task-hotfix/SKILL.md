---
name: task-hotfix
description: Apply an urgent production fix or critical regression patch directly in the main choco-pi agent. Use as the authoritative hotfix workflow only when the user requests an actual fix; do not trigger for diagnosis, incident explanation, status checks, or ordinary follow-ups.
---

# choco-pi Urgent Fix

Keep implementation in the main agent. Do not spawn implementation agents. A fresh read-only reviewer is optional only when required by the user or project risk policy.

## 1. Triage

1. Run `check`; do not wait for optional capabilities unrelated to the incident.
2. Read the incident evidence and applicable instructions.
3. Record `review_base`, inspect the dirty tree, resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill, and run `node <resolved-script> acquire --cwd "$PWD"`. The script identifies the calling session itself; stop on a conflicting owner it does not report as dead.
4. Reproduce the failure through the narrowest reliable path and identify the most likely root cause.
5. Record success criteria, explicit exclusions, authority boundaries, and an acceptance ledger using `regression_test`, `direct_check`, or `runtime_e2e`.

## 2. Fix and validate

1. Apply the smallest safe patch; do not fold adjacent cleanup or hardening into the incident.
2. Run the original reproduction, justified regression tests, affected project gates, and direct checks.
3. Inspect the final diff and update every acceptance row from observed results.
4. Count each `edit → run → observed failure` cycle as one attempt. After three unresolved attempts, stop and report the evidence and next decision; do not silently broaden scope or delegate the fix unless the user authorizes it.

## 3. Checkpoint and runtime proof

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. Run required executable behavior against that exact `HEAD`. A corrective edit invalidates affected evidence and requires validation, a new checkpoint, and final-`HEAD` verification again.

## 4. Review and report

Use fresh read-only review only when required, and independently validate any finding. After owned runtime cleanup, release the lease with `node <resolved-script> release --cwd "$PWD"`. Report the root cause, minimal patch, exact gates and runtime observations, final revision, waivers, and remaining risk.
