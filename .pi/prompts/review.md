---
description: Run a read-only adversarial review with a fresh reviewer sub-agent
argument-hint: "[diff, revision, or range]"
---
Load and follow the harness `review` skill. Use applicable `AGENTS.md` as review policy without replacing this workflow. Review this target if supplied: ${ARGUMENTS:-current staged and unstaged changes against HEAD}.
