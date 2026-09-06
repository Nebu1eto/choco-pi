# Maintainer Fresh-Pi Review Self-Test

This is an explicit opt-in harness-maintainer check, not a routine review step. Run it only when a maintainer requests live extension-host evidence. Start from the repository root in a fresh process after package tests, and replace `<bundle>` and `<sha256>` with an immutable review bundle and its manifest digest.

```bash
pi -p 'Spawn exactly one reviewer named reviewer-e2e-validation in the background with max_turns 15, timeout_ms 120000, max_tool_calls 40, max_tokens 60000, and idle_timeout_ms 30000. Give it review bundle <bundle> with SHA-256 <sha256>. Require the structured review finding contract. Continue other work until its terminal completion notification, then call get_subagent_result exactly once and print the terminal status and reviewer output.'
```

For an explicitly requested live wall-clock termination probe, use a separate fresh process:

```bash
pi -p 'Spawn exactly one reviewer in the background with timeout_ms 1 and prompt it to inspect this repository. Wait for the terminal completion notification, call get_subagent_result exactly once, and print its terminal status. The expected status is budget_exceeded.'
```

Record each fresh process's exit status and output. Deterministic transition tests remain authoritative for tool and token caps, watchdog conclude-then-stop behavior, exact-once result reads, and slot release; this opt-in scenario checks real extension-host wiring.
