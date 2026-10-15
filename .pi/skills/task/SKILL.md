---
name: task
description: Use parallel agents only for two or more independent implementation units.
---

# choco-pi Parallel Implementation

The main agent owns scope, authority, orchestration, integration, validation, commit preparation, and the final answer. Delegate semantic implementation to leaf agents; do not edit implementation code in the orchestrator.

When the user explicitly invokes `task-dynamic`, that workflow supersedes this one for dynamically decomposed nested work; never auto-route to it.

## 1. Bootstrap

1. Read `../task-core/SKILL.md`, then run `check`, including sub-agent discovery.
2. Read path-scoped instructions and apply the shared investigation and evidence mechanics.
3. Record `review_base`, inspect the dirty tree, resolve `../../scripts/checkout-mutation-lease.ts` relative to this skill, and run `node <resolved-script> acquire --cwd "$PWD"`. The script identifies the calling session itself; stop on a conflicting owner it does not report as dead.
4. Create the acceptance ledger required by `task-core`.
5. If this workflow was automatically selected but safe parallel execution or sub-agents are unavailable, fall back to `task-inline`. If the user explicitly selected it, report the limitation and request direction.

## 2. Plan

Settle the plan owner once, when this step starts, by the first rule that applies:

1. **User request:** when the user explicitly asks for a `planner` subagent, spawn one fresh `planner`.
2. **Prior plan:** when the current conversation or a file the user names holds a plan that decides the approach for this objective, the orchestrator conforms it, whatever the current model. A plan known only through a compaction summary qualifies only when its full text is in a readable file. An analysis without a chosen approach is evidence, not a plan.
3. **Flagship model:** when `../../model-guidance.md`, resolved relative to this skill, places the runtime `Current model` in the Flagship tier, the orchestrator plans. Astra qualifies under both `openai-codex/` and `openai/`.
4. **Planner:** otherwise, including an `"unknown"` model, spawn one fresh `planner`.

When a prior plan leaves part of the objective uncovered, rules 3 and 4 decide who plans that remainder. A spawned `planner` receives the objective, instructions, direct and indirect write risks, acceptance ledger, available model/reasoning choices, and any prior or conformed plan, whose recorded user decisions and exclusions are binding.

Every plan owner uses `../../model-guidance.md` as the selection reference and produces the smallest dependency-aware plan and spawn manifest containing each unit's objective, read/write scope, indirect effects, dependencies, done criteria, and verification plan. The plan preserves explicit exclusions, identifies direct and indirect write conflicts, and names each material ambiguity that repository evidence cannot resolve.

Require the plan to carry a `mermaid` flowchart of the units, their dependencies, and the waves that run in parallel. Disjoint write scopes and wave ordering are what this workflow gets wrong most often, and both are easier to check as a graph than as a list.

To conform a prior plan, keep its recorded user decisions and exclusions; requests added after it form the uncovered remainder. Re-verify its load-bearing evidence against `review_base` and the dirty tree. When current evidence contradicts a recorded decision, present the conflict as a material user decision instead of changing it. Add what this contract requires and the plan lacks: units, scopes, indirect effects, dependencies, done criteria, verification, the flowchart, role and model choices, and acceptance-ledger rows.

When the orchestrator plans or conforms:

- Make no implementation or checkout change until the plan is final; session scratch is allowed.
- Send broad read-only discovery to `explore` leaves with exact questions, and keep the synthesis.
- Write the final plan to `/tmp/choco-pi/${PI_SESSION_ID}/` and record its path in the acceptance ledger.
- Under rule 3 only, if the current model leaves the Flagship tier before the plan is final, spawn the `planner` with the gathered evidence and the draft. A model change after the plan is final does not reopen it.

Select each role from the unit's work before considering a model or reasoning override; an override must never replace a specialized role with `general`. Omit `model` and `thinking` in every spawn so the role file's `default_model` and `default_thinking` apply; the spawn manifest records a model or effort only as an override. Pass an override only for a reason allowed by `.pi/model-guidance.md`, and record that reason. Restating the role default, the orchestrator's own model, or the plan owner's preference is not a reason. Present the plan only when it contains a material user decision.

When the advisor tool is enabled, the orchestrator may consult it before presenting a complex plan and before final acceptance; advisor output is advice, not evidence.

### Delegation packet

Write every fresh child's prompt as a self-contained briefing for a capable colleague with no access to the parent conversation. Include:

- the objective and why it matters;
- established facts, failed approaches, and decisions the child must not re-litigate;
- exact read and write scope, including indirect shared-output risks and explicit exclusions;
- dependencies, authority boundaries, done criteria, and required verification;
- whether the unit is research-only or may edit code, plus the expected response shape or length when material.
- the leaf's persona when it should differ from its agent file: one line `Persona: unset|critical|pessimistic` in the task prompt; without it, the agent file's `persona` applies, then the global `agentPersona` (default `pessimistic`).

For a lookup, provide the exact command or target. For an investigation, provide the question and evidence standard rather than prescribing steps that assume the cause. Do not delegate synthesis with phrases such as "based on the findings, fix it." Integrate the findings first, then brief a separate implementation unit with specific files, locations, and changes.

## 3. Execute

1. Assign each parallel unit an exclusive direct and indirect write scope, and validate that the scopes are disjoint. Work in the current checkout unless the user requests a worktree or repository policy requires isolation.
2. Spawn leaf `implementer` agents by dependency wave. Name every spawned child by its goal (`role-goal`, one to three dashed words, unique among its siblings). Each receives the delegation packet above and returns uncommitted changes plus exact evidence.
3. Prevent parallel workers from committing, rebasing, generating shared output, formatting repository-wide state, running shared migrations, or mutating common databases, ports, devices, fixtures, schemas, or lockfiles.
4. Use `steer_subagent` to correct running work after its current tool. Use `resume` only for a follow-up within the same unit, and preserve message order.
5. Inspect every worker's actual diff and evidence. Send a correction back only while it remains inside that worker's scope; otherwise create a sequential integration unit.

## 4. Integrate and checkpoint

After all writers stop, merge and deduplicate deferred checks, follow `task-core`'s diagnostics sequence, run combined and project-required gates, and inspect the complete diff. Run project-required generation or formatting only from the orchestrator and treat unexpected semantic output as implementation work.

Unless the user explicitly excluded a commit, load and follow the harness `commit` skill. Run every required runtime behavior against the exact checkpoint `HEAD`. A correction invalidates affected evidence and requires combined validation, a new checkpoint, and final-`HEAD` proof.

When the integrated diff contains more than one coherent change, follow the commit skill's split rule; the final `HEAD` still receives full gates and required runtime-behavior proof.

## 5. Review and handoff

Select review through `task-core`'s task-shaped rule. When selected, prepare the immutable input through `../review/references/review-bundle.md` and give one fresh `reviewer` only its bundle path and manifest digest, not claimed safety, expected findings, or previous conclusions. Findings remain advisory until the main agent reproduces or proves them.

Use `handoff` only when it materially improves a complex delivery. Stop all children and owned runtimes, then release the lease with `node <resolved-script> release --cwd "$PWD"`. Report exact final revision, acceptance results, review disposition, waivers, and remaining risk. Never treat a worker report as completion proof.
