---
name: task
description: Use parallel planning and agents for repository changes only when at least two genuinely independent implementation units materially benefit; do not route by file count.
---

# choco-pi Parallel Implementation

The main agent owns scope, authority, orchestration, integration, validation, commit preparation, and the final answer. Delegate semantic implementation to leaf agents; do not edit implementation code in the orchestrator.

When the user explicitly invokes `task-dynamic`, that workflow supersedes this one for dynamically decomposed nested work; never auto-route to it.

## 1. Bootstrap

1. Run `check`, including sub-agent discovery, plus repository gates required by applicable `AGENTS.md`.
2. Read path-scoped instructions. Record objective, exclusions, scope, constraints, success criteria, and authority boundaries.
3. Record `review_base`, inspect the dirty tree, resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill, and run `node <resolved-script> acquire --cwd "$PWD"`. The script identifies the calling session itself; stop on a conflicting owner it does not report as dead.
4. Create the acceptance ledger with a verification mode for every required behavior.
5. If this workflow was automatically selected but safe parallel execution or sub-agents are unavailable, fall back to `task-inline`. If the user explicitly selected it, report the limitation and request direction.

## 2. Plan

Spawn one fresh `planner` with the objective, instructions, direct and indirect write risks, acceptance ledger, and available model/reasoning choices, using `.pi/model-guidance.md` resolved relative to the repository as the selection reference. Require a dependency-aware plan and spawn manifest containing each unit's objective, read/write scope, indirect effects, dependencies, done criteria, and verification plan.

Require the plan to carry a `mermaid` flowchart of the units, their dependencies, and the waves that run in parallel. Disjoint write scopes and wave ordering are what this workflow gets wrong most often, and both are easier to check as a graph than as a list.

Select each role from the unit's work before resolving model or reasoning effort; an override must never replace a specialized role with `general`. Resolve model and reasoning effort in the system-prompt priority order. Read the selected role file's `default_model` and `default_thinking`, then pass both explicitly on every spawn; these fields are overridable defaults, not pinned runtime fields. Present the plan only when it contains a material user decision.

## 3. Execute

1. Assign each parallel unit an exclusive direct and indirect write scope, and validate that the scopes are disjoint. Work in the current checkout unless the user requests a worktree or repository policy requires isolation.
2. Spawn leaf `implementer` agents by dependency wave. Name every spawned child by its goal (`role-goal`, one to three dashed words, unique among its siblings). Each receives a bounded task packet and returns uncommitted changes plus exact evidence.
3. Prevent parallel workers from committing, rebasing, generating shared output, formatting repository-wide state, running shared migrations, or mutating common databases, ports, devices, fixtures, schemas, or lockfiles.
4. Use `steer_subagent` to correct running work after its current tool. Use `resume` only for a follow-up within the same unit, and preserve message order.
5. Inspect every worker's actual diff and evidence. Send a correction back only while it remains inside that worker's scope; otherwise create a sequential integration unit.

## 4. Integrate and checkpoint

After all writers stop, merge and deduplicate deferred checks, run combined and project-required gates, and inspect the complete diff. Run project-required generation or formatting only from the orchestrator and treat unexpected semantic output as implementation work.

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. Run every required runtime behavior against the exact checkpoint `HEAD`. A correction invalidates affected evidence and requires combined validation, a new checkpoint, and final-`HEAD` proof.

## 5. Review and handoff

Select review depth by risk. Use one fresh `reviewer` only when the user or project risk policy requires independent review. Give it the exact immutable range and applicable requirements, but not claimed safety, expected findings, or previous conclusions. Findings remain advisory until the main agent reproduces or proves them.

Use `handoff` only when it materially improves a complex delivery. Stop all children and owned runtimes, then release the lease with `node <resolved-script> release --cwd "$PWD"`. Report exact final revision, acceptance results, review disposition, waivers, and remaining risk. Never treat a worker report as completion proof.
