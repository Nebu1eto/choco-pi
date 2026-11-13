---
name: review
description: Read-only adversarial review of an exact diff or revision.
---

# choco-pi Adversarial Review

This workflow reports findings only. It never edits, commits, or expands into implementation unless the user separately requests a fix.

## 1. Resolve the target

1. Load `references/review-bundle.md` relative to this `SKILL.md`, then load `.pi/review-policy.md` from the current project, or `~/.pi/agent/review-policy.md` from the global choco-pi profile, as the authoritative review rules.
2. Read applicable `AGENTS.md` and repository review policy.
3. Resolve the user's explicit diff, revision, or comparison range. If omitted, use the current staged and unstaged working-tree diff against `HEAD`, including relevant untracked files.
4. Prepare the immutable review bundle exactly as `references/review-bundle.md` specifies.

## 2. Run the adversarial reviewer

Spawn one fresh `reviewer` sub-agent. Give it the review-bundle path and manifest digest. Require it to follow `references/review-bundle.md`, review `target.diff` rather than a newly generated diff, and use the bundled requirements, policy snapshots, and evidence. It may inspect repository files only to understand unchanged context; the bundle remains the sole change target.

Spawn it under the system prompt's spawn rule for `model` and `thinking`. Pass `work_task` (a stable kebab-case id for this work task, reused across review rounds and follow-ups). A `Review round refused` result is not a spawn-parameter error: do not retry or rename the work task; triage, report remaining risk, and tell the user that `/review-continue <work_task>` authorizes another round.

Do not include implementation plans, claimed safety, expected findings, or previous reviewer conclusions. The reviewer must remain read-only and must not spawn another agent.

For observation, cancellation, terminal-state classification, and recovery, follow `task-core`'s **Observe and recover a review run** section. In particular, an observation timeout is not an execution failure, and a completed `INCOMPLETE` result must remain incomplete rather than being forced into findings or `NO_FINDINGS`.

## 3. Validate findings

Read the `Verdict record:` line appended to the reviewer's result. A review recorded as `MISSING` or invalid is unrecorded: report it that way and never as clean.

Findings and candidates stay advisory until proved. The main agent independently checks each one against the exact diff and evidence, or gives it to a fresh `verifier` as a claim under `task-core`'s **Settle review claims** section. Reject findings that are pre-existing, speculative, prevented by an existing guarantee, outside scope, or refuted by evidence. A claim nobody could reproduce keeps its severity until it gets an explicit disposition.

Do not modify code while validating. If evidence requires a command, prefer read-only or non-mutating diagnostics and identify anything not run.

## 4. Report

Return accepted findings first, ordered by severity, using the shared rules' fields. Then give every other finding and candidate with its disposition: rejected with a reason, or carried as stated risk. If no finding survives validation, say that no actionable finding was verified and summarize the meaningful checks performed.

Routine review stops here. When a harness maintainer explicitly requests live fresh-Pi evidence, load and follow the opt-in `references/maintainer-e2e.md` scenario.
