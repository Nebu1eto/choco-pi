---
name: review
description: Perform an independent, adversarial, read-only review of an exact diff or revision when /review-agent or an explicit agentic code-review request is given.
---

# choco-pi Adversarial Review

This workflow reports findings only. It never edits, commits, or expands into implementation unless the user separately requests a fix.

## 1. Resolve the target

1. Load `.pi/review-policy.md` from the current project, or `~/.pi/agent/review-policy.md` from the global choco-pi profile, as the authoritative review rules.
2. Read applicable `AGENTS.md` and repository review policy.
3. Resolve the user's explicit diff, revision, or comparison range. If omitted, use the current staged and unstaged working-tree diff against `HEAD`, including relevant untracked files.
4. Record the exact target and do not silently switch ranges after review begins.

## 2. Run the adversarial reviewer

Spawn one fresh `reviewer` sub-agent. Give it the exact target, user requirements, applicable project policy, and the resolved review-policy path. Require it to load and follow those shared rules before inspecting the change.

Do not include implementation plans, claimed safety, expected findings, or previous reviewer conclusions. The reviewer must remain read-only and must not spawn another agent.

## 3. Validate findings

The main agent independently checks every candidate against the exact diff and evidence. Reject findings that are pre-existing, speculative, prevented by an existing guarantee, outside scope, or unsupported by a reproducible failure or deterministic path.

Do not modify code while validating. If evidence requires a command, prefer read-only or non-mutating diagnostics and identify anything not run.

## 4. Report

Return accepted findings first, ordered by severity, using the shared rules' fields. Then state rejected or unresolved candidates only when their disposition materially helps the user. If no finding survives validation, say that no actionable finding was verified and summarize the meaningful checks performed.
