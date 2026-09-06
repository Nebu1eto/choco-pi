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

Do not include implementation plans, claimed safety, expected findings, or previous reviewer conclusions. The reviewer must remain read-only and must not spawn another agent.

## 3. Validate findings

The main agent independently checks every candidate against the exact diff and evidence. Reject findings that are pre-existing, speculative, prevented by an existing guarantee, outside scope, or unsupported by a reproducible failure or deterministic path.

Do not modify code while validating. If evidence requires a command, prefer read-only or non-mutating diagnostics and identify anything not run.

## 4. Report

Return accepted findings first, ordered by severity, using the shared rules' fields. Then state rejected or unresolved candidates only when their disposition materially helps the user. If no finding survives validation, say that no actionable finding was verified and summarize the meaningful checks performed.

Routine review stops here. When a harness maintainer explicitly requests live fresh-Pi evidence, load and follow the opt-in `references/maintainer-e2e.md` scenario.
