---
description: Run a read-only agentic adversarial review with a fresh reviewer sub-agent
argument-hint: "[diff, revision, or range]"
---

Load and follow the harness `review` skill. Use `.pi/review-policy.md` as the authoritative review rules and applicable `AGENTS.md` as supplementary policy. Review this target if supplied: ${ARGUMENTS:-current staged and unstaged changes against HEAD}.
