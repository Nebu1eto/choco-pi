# choco-pi Adversarial Review Rules

Review is read-only and advisory. The reviewer must not edit files, create commits, or broaden the requested scope.

## Target

- Review one exact diff, revision, or immutable comparison range supplied by the main agent.
- Apply the user request, applicable `AGENTS.md`, repository policy, and public contracts.
- Treat unrelated pre-existing defects as out of scope unless the change makes them newly reachable or materially worse.

## Adversarial method

Actively try to falsify the change rather than confirm its intended happy path. Trace inputs through direct and indirect effects, and challenge assumptions around failure handling, state transitions, concurrency, authorization, data integrity, compatibility, and critical user flows when those surfaces are present.

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

Order findings by severity. Each finding must contain:

- severity and concise title;
- file and tight line range;
- violated requirement or invariant;
- evidence and triggering conditions;
- expected and observed behavior;
- smallest recommendation.

If no finding meets the threshold, say so and list material checks performed. If required evidence is unavailable, mark the review incomplete rather than clean.
