# choco-pi Adversarial Review Rules

Review is read-only and advisory. The reviewer must not edit files, create commits, or broaden the requested scope.

## Target

- Review one exact diff, revision, or immutable comparison range supplied by the main agent.
- Apply the user request, applicable `AGENTS.md`, repository policy, and public contracts.
- Treat unrelated pre-existing defects as out of scope unless the change makes them newly reachable or materially worse.
- The assigned review bundle is the sole change target. Verify its recorded SHA-256 before review, read its policy snapshots and evidence, and do not replace `target.diff` with a fresh working-tree diff. A missing or mismatched bundle makes the review incomplete.

## Adversarial method

Actively try to falsify the change rather than confirm its intended happy path. Trace inputs through direct and indirect effects, and challenge assumptions around failure handling, state transitions, concurrency, authorization, data integrity, compatibility, and critical user flows when those surfaces are present.

Do not pre-filter exploration by severity or a generic instruction to be conservative. Investigate plausible defects across severities, then apply the finding threshold below when deciding what to report.

For each candidate finding:

1. Identify the requirement or invariant that would be violated.
2. Prove that the reviewed change causes or exposes the problem.
3. Reproduce it or provide a complete deterministic code path with concrete inputs and state.
4. Check whether existing validation, callers, or platform guarantees already prevent it.
5. Prefer the smallest recommendation that restores the violated requirement.

## Finding threshold

Report a finding only when all of these are true:

- it is caused or exposed by the reviewed change;
- it conflicts with a requirement, policy, or observable behavior;
- its evidence is reproducible or deterministically traceable;
- it is actionable within the reviewed scope.

Exclude style preferences, speculative concerns, optional hardening, scope-expanding improvements, and claims based only on tool output or another agent's conclusion.

## Output

Order findings by severity: `critical`, `high`, `medium`, then `low`. Use this exact contract for every finding:

```markdown
## [severity] Concise title

- path: relative/file.ts:12-18
- invariant: requirement or behavior the change violates
- reproduction: concrete inputs, state, and ordered steps or deterministic code path
- evidence: observed result and its source
- expected: required behavior
- observed: actual behavior
- recommendation: smallest in-scope correction
```

`severity`, `path`, `invariant`, and `reproduction` are mandatory. Do not emit a finding without all four.

When a finding's evidence is a path across several call sites, components, or states, draw that path as a small `mermaid` flowchart beside the evidence. The path is what makes the finding reproducible, and a chain of hops is the part a paragraph states least clearly.

If no finding meets the threshold, output `NO_FINDINGS` and list material checks performed. If required evidence is unavailable, output `INCOMPLETE`, name the missing evidence, and do not claim the change is clean.
