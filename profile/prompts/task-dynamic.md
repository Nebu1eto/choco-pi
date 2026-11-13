---
description: Run the dynamic recursive parallel implementation workflow with nested choco-pi sub-agents
argument-hint: "<task>"
---

Locate the `task-dynamic` harness `SKILL.md` from available skill metadata. Because this explicit-only skill may be hidden from metadata, if needed read only Pi's `skills` configuration field and search its configured skill directories for `task-dynamic/SKILL.md`; treat conventional paths only as candidates. Load that file and resolve its relative references from its actual directory. Use applicable `AGENTS.md` as repository policy. Treat the following as the user's task: $ARGUMENTS
