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
4. Capture a review bundle before spawning. The bundle is immutable input, not a pointer to the live working tree. It contains:
   - `target.diff`, produced once from the resolved revision/range or working tree, including requested untracked files;
   - the diff's SHA-256, base and target revision when available, and the command used to capture it;
   - the user requirements;
   - complete snapshots and SHA-256 values of the applicable review policy and repository guidance;
   - current evidence: each command, exit status, relevant output, timestamp, and the repository state it tested.
5. Put the bundle in task scratch space, record its path and digest in the reviewer prompt, and do not regenerate or silently switch it after review begins. If the working tree changes, create a new bundle and a new review run.

## 2. Run the adversarial reviewer

Spawn one fresh `reviewer` sub-agent. Give it the review-bundle path and digest. Require it to verify the digest, review `target.diff` rather than a newly generated diff, and use the bundled requirements, policy snapshots, and evidence. It may inspect repository files only to understand unchanged context; the bundle remains the sole change target.

Do not include implementation plans, claimed safety, expected findings, or previous reviewer conclusions. The reviewer must remain read-only and must not spawn another agent.

## 3. Validate findings

The main agent independently checks every candidate against the exact diff and evidence. Reject findings that are pre-existing, speculative, prevented by an existing guarantee, outside scope, or unsupported by a reproducible failure or deterministic path.

Do not modify code while validating. If evidence requires a command, prefer read-only or non-mutating diagnostics and identify anything not run.

## 4. Report

Return accepted findings first, ordered by severity, using the shared rules' fields. Then state rejected or unresolved candidates only when their disposition materially helps the user. If no finding survives validation, say that no actionable finding was verified and summarize the meaningful checks performed.

## Fresh-Pi E2E scenario

Run this from the repository root in a fresh process after package tests. Replace `<bundle>` and `<sha256>` with a captured bundle and its digest. The prompt deliberately requires one bounded background review and one terminal read:

```bash
pi -p 'Spawn exactly one reviewer named reviewer-e2e-validation in the background with max_turns 15, timeout_ms 120000, max_tool_calls 40, max_tokens 60000, and idle_timeout_ms 30000. Give it review bundle <bundle> with SHA-256 <sha256>. Require the structured review finding contract. Continue other work until its terminal completion notification, then call get_subagent_result exactly once and print the terminal status and reviewer output.'
```

For a live wall-clock termination probe, use a separate fresh process:

```bash
pi -p 'Spawn exactly one reviewer in the background with timeout_ms 1 and prompt it to inspect this repository. Wait for the terminal completion notification, call get_subagent_result exactly once, and print its terminal status. The expected status is budget_exceeded.'
```

Record the fresh process's exit status and output in the task evidence. The deterministic transition tests remain the authority for tool/token caps, watchdog conclude-then-stop, exact-once result reads, and slot release; the fresh process proves the real extension-host wiring.
