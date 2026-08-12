---
name: task
description: Orchestrate a new repository-changing implementation with choco-pi sub-agents when at least two independent units materially benefit from separate planning and parallel execution. Use as the authoritative parallel workflow; do not trigger merely because many files or packages are involved.
---

# choco-pi Parallel Implementation

The main agent owns scope, authority, orchestration, integration, validation, commit preparation, and the final answer. Delegate semantic implementation to leaf agents; do not edit implementation code in the orchestrator.

## 1. Bootstrap

1. Run `check`, including sub-agent discovery, plus repository gates required by applicable `AGENTS.md`.
2. Read path-scoped instructions. Load another skill only for a distinct domain operation, never to replace this workflow. Record objective, exclusions, scope, constraints, success criteria, and authority boundaries.
3. Record `review_base`, inspect the dirty tree, resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill, and run `node <resolved-script> acquire --cwd "$PWD" --owner "$PI_SESSION_ID"`.
4. Create the acceptance ledger with a verification mode for every required behavior.
5. If this workflow was automatically selected but safe parallel execution or sub-agents are unavailable, fall back to `task-inline`. If the user explicitly selected it, report the limitation and request direction.

## 2. Plan

Spawn one fresh `planner` with the objective, instructions, direct and indirect write risks, acceptance ledger, and available model/reasoning choices. Require a dependency-aware plan and spawn manifest containing each unit's objective, read/write scope, indirect effects, dependencies, done criteria, and verification plan.

Resolve model and reasoning effort in the system-prompt priority order. Present the plan only when it contains a material user decision.

## 3. Execute

1. Validate that parallel units have disjoint direct and indirect write scopes.
2. Spawn leaf `implementer` agents by dependency wave. Each receives a bounded task packet and returns uncommitted changes plus exact evidence.
3. Prevent parallel workers from committing, rebasing, generating shared output, formatting repository-wide state, running shared migrations, or mutating common databases, ports, devices, fixtures, schemas, or lockfiles.
4. Use steering for an immediate correction at the next safe point and follow-up for queued work. Preserve message order.
5. Inspect every worker's actual diff and evidence. Send a correction back only while it remains inside that worker's scope; otherwise create a sequential integration unit.

## 4. Integrate and checkpoint

After all writers stop, merge and deduplicate deferred checks, run combined and project-required gates, and inspect the complete diff. Run project-required generation or formatting only from the orchestrator and treat unexpected semantic output as implementation work.

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. Never create the commit directly or substitute another commit workflow. Run every required runtime behavior against the exact checkpoint `HEAD`. A correction invalidates affected evidence and requires combined validation, a new checkpoint, and final-`HEAD` proof.

## 5. Review and handoff

Select review depth by risk. Use one fresh `reviewer` only when the user or project risk policy requires independent review. Give it the exact immutable range and applicable requirements, but not claimed safety, expected findings, or previous conclusions. Findings remain advisory until the main agent reproduces or proves them.

Use `handoff` only when it materially improves a complex delivery. Stop all children and owned runtimes, then release the lease with `node <resolved-script> release --cwd "$PWD" --owner "$PI_SESSION_ID"`. Report exact final revision, acceptance results, review disposition, waivers, and remaining risk. Never treat a worker report as completion proof.
