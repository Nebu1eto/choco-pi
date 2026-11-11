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

Every review must also cover these angles:

1. Behavior the diff removed or changed that callers, tests, or documentation still rely on.
2. Callers and dependents of every changed contract, including those outside the diff.
3. A final pass that asks only what the earlier passes missed.

For each possible finding:

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

A finding needs no execution. When you can quote or point to the violated requirement, rule, or contract where it is stated, name the exact place, and trace a complete path from a reachable entry to the violating state with no link assumed, report a finding with `code_path` evidence. Reaching the violating state is enough; what a host or dependency does next need not be shown. A concern with a concrete invariant and a traced path but a missing or assumed link (reachability not established, a precondition the code does not confirm, a dependency you could not inspect, or an invariant you inferred but found stated nowhere) is a candidate, and its `evidence` names that link. Report every candidate, separated from findings; never drop one silently. A concern without both an invariant and a traced path is speculation and stays excluded.

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

List candidates after all findings under a `## Candidates` heading, in the same template with `[candidate severity]` titles; `reproduction` holds the traced path and `evidence` names the missing or assumed link.

When a finding's evidence is a path across several call sites, components, or states, draw that path as a small `mermaid` flowchart beside the evidence. The path is what makes the finding reproducible, and a chain of hops is the part a paragraph states least clearly.

If no finding meets the threshold and no candidate remains, output `NO_FINDINGS` and list material checks performed. If required evidence is unavailable, output `INCOMPLETE`, name the missing evidence, and do not claim the change is clean.

End the final message with exactly one `choco-pi-review` block that agrees with the Markdown. A review without a valid block is unrecorded and cannot be reported as clean. `verdict` is `FINDINGS` when `findings` holds any finding or candidate, `NO_FINDINGS` only when it is empty, and `INCOMPLETE` with `incomplete.missing` naming what is missing. `bundleDigest` is the manifest digest you were given. Each entry has `class` (`finding` or `candidate`), `evidence` (`reproduction` if you ran it, `code_path` if you traced it), and optionally `startLine`, `endLine`, and `angle`. The block takes no other fields:

```choco-pi-review
{
  "schema": 1,
  "verdict": "FINDINGS",
  "bundleDigest": "sha256:9c1e4b7a2d8f3e6c0b5a9d2f7e1c4b8a3d6f9e2c5b8a1d4f7e0c3b6a9d2f5e8c",
  "findings": [
    {
      "id": "F1",
      "class": "finding",
      "severity": "high",
      "path": "scripts/lease.ts",
      "startLine": 41,
      "endLine": 58,
      "invariant": "release() removes only a lock its caller holds",
      "evidence": "code_path",
      "reproduction": "holder A's lock goes stale; B unlinks it and re-creates it; A's finally block unlinks B's lock by path",
      "angle": "callers of changed contract"
    },
    {
      "id": "C1",
      "class": "candidate",
      "severity": "medium",
      "path": "scripts/lease.ts",
      "startLine": 72,
      "invariant": "a dead holder's lease is reclaimed once",
      "evidence": "code_path",
      "reproduction": "two reclaimers both read the dead pid before either writes; the second is stopped only if rename refuses an existing target, a platform behavior not established",
      "angle": "final pass"
    }
  ]
}
```

For `INCOMPLETE`, `findings` holds only what you established before stopping, often `[]`, and you add `"incomplete": { "missing": "target.diff checksum does not match the manifest" }`.
