---
description: Run a read-only agentic adversarial review with a fresh reviewer sub-agent
argument-hint: "[diff, revision, or range]"
---

Load and follow the harness `review` skill. Use the review policy the skill names (the project's `.pi/review-policy.md`, else `review-policy.md` in Pi's agent directory) as the authoritative review rules and applicable `AGENTS.md` as supplementary policy. Review this target if supplied: ${ARGUMENTS:-current staged and unstaged changes against HEAD}.
