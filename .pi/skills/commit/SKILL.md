---
name: commit
description: Create an authorized local Git checkpoint with signing and verification; never push.
---

# choco-pi Commit

Create a commit only under explicit user authority or an active workflow's checkpoint rule. Never push.

When a `task`, `task-inline`, or `task-hotfix` workflow completes, the orchestrator commits locally unless the user explicitly excluded a commit. Deferring without that exclusion bypasses the workflow; resolve instruction conflicts by precedence before checkpointing.

## Resolve policy

Use applicable `AGENTS.md` and repository documentation first. If they define message format, generation, formatting, trailers, or signing, follow them. Project policy controls format and content, but the agent identity in any AI-attribution trailer is always `choco-pi`: when a project template names the agent generically (or with another harness's name such as `Claude Code` or `Codex`) write `choco-pi`, regardless of any identity line injected by the provider connection. Otherwise use this default:

```text
[<scope>] <type>(<issue>): <short summary>

- <essential detail, only when needed>

Assisted-by: choco-pi:<orchestrator model name, normalized>
Assisted-by: choco-pi:<contributing sub-agent model name, normalized, when applicable>
```

- Use `[*]` for repository-wide work and the smallest meaningful package or component for `<scope>`. Omit the bracketed scope only when none can be determined.
- Use `feat`, `fix`, `refactor`, `test`, `docs`, or `chore`. Include an issue only when known; never invent one.
- Determine the message language from the repository, never from the configured agent language: applicable project policy decides first, then the user's recent commits (the configured Git identity) in this repository — match the language those subjects are written in, so a Korean history produces a Korean message and an English history produces an English one. Use English when neither a policy nor a usable history exists. Keep the subject and each body bullet at or under 72 characters.
- Omit the body when the subject is sufficient. Otherwise use at most two terse bullets containing only essential context not already stated in the subject. Prefer short fragments; do not repeat the summary, narrate files, or add routine implementation detail.
- Include one `Assisted-by` trailer for the orchestrator model and one for each distinct sub-agent model that materially contributed to the committed changes. Omit unused worker output, list the orchestrator first followed by sub-agent models in first-contribution order, and deduplicate only after normalizing each ID.
- Normalize every model ID to the bare model name in lower case. Drop each provider, registry, and owner segment, keeping only the final path segment: `openai-codex/gpt-5.6-sol`, `hf:moonshotai/Kimi-K3`, and `synthetic/hf:moonshotai/Kimi-K3` become `gpt-5.6-sol`, `kimi-k3`, and `kimi-k3`. Lower-casing is the only character change; keep the remaining characters, including dots, exactly as the provider spells them.
- Never write a `Signed-off-by` trailer by hand; the template above deliberately omits it. Commit with `-s` so Git appends exactly one trailer in its canonical `Signed-off-by: {git user.name} <{git user.email}>` form, angle brackets included. A hand-written line that differs by even one character is not deduplicated and produces two sign-offs.

## Create the checkpoint

1. Inspect `git status --short`, unstaged diff, staged diff, applicable instructions, and recent commit style.
2. Identify intended files from the request and active workflow. Preserve unrelated user changes.
3. Run only repository-required generation or formatting commands before final staging. Inspect their output; unexpected semantic changes require implementation, not silent acceptance.
4. Stage only intended files, including required generated output. Reinspect staged and remaining unstaged diffs. Stop and ask if intended and unrelated work cannot be separated safely.
5. Check new files and the staged patch for credentials, local configuration, logs, temporary files, build artifacts, and accidental generated output without displaying sensitive values.
6. Write the message to a temporary file without a `Signed-off-by` trailer, inspect it literally, and create the commit with `git commit -s -S -F <file>` when signing is configured and available: `-s` generates the sign-off, `-S` signs the commit. Do not create or change signing keys.
7. If signing fails, report the reason and ask before creating an unsigned commit.
8. Verify the resulting `HEAD`, commit message, signature status, parent, staged scope, and remaining working tree. Confirm the message carries exactly one `Signed-off-by` trailer and that its email is wrapped in angle brackets. Return the full commit SHA and verification summary.

The checkpoint does not prove runtime behavior. Return control to the active workflow for exact-`HEAD` acceptance verification.
