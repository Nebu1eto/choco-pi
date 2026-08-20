---
name: commit
description: Create one well-scoped local Git checkpoint with choco-pi when the user requests a commit or an active workflow requires one. Use as the authoritative commit workflow; handle intended staging, repository policy, message construction, AI-assistance and sign-off trailers, configured signing, and final revision verification without ever pushing.
---

# choco-pi Commit

Create a commit only under explicit user authority or an active workflow's checkpoint rule. Never push.

## Resolve policy

Use applicable `AGENTS.md` and repository documentation first. If they define message format, generation, formatting, trailers, or signing, follow them. Project policy controls format and content, but the agent identity in any AI-attribution trailer is always `choco-pi`: when a project template names the agent generically (or with another harness's name such as `Claude Code` or `Codex`) write `choco-pi`, regardless of any identity line injected by the provider connection. Otherwise use this default:

```text
[<scope>] <type>(<issue>): <short summary>

- <essential detail, only when needed>

Assisted-by: choco-pi:<orchestrator model id without provider>
Assisted-by: choco-pi:<contributing sub-agent model id without provider, when applicable>
Signed-off-by: <git user.name> <git user.email>
```

- Use `[*]` for repository-wide work and the smallest meaningful package or component for `<scope>`. Omit the bracketed scope only when none can be determined.
- Use `feat`, `fix`, `refactor`, `test`, `docs`, or `chore`. Include an issue only when known; never invent one.
- Determine the message language from history: inspect the user's recent commits (the configured Git identity) in this repository, and if they are all written in English, treat English as the project's commit-message language and write in English. Otherwise follow the user's language. Keep the subject and each body bullet at or under 72 characters.
- Omit the body when the subject is sufficient. Otherwise use at most two terse bullets containing only essential context not already stated in the subject. Prefer short fragments; do not repeat the summary, narrate files, or add routine implementation detail.
- Include one `Assisted-by` trailer for the orchestrator model and one for each distinct sub-agent model that materially contributed to the committed changes. Omit unused worker output, deduplicate model IDs, and list the orchestrator first followed by sub-agent models in first-contribution order. Strip any provider prefix from each model ID: for example, use `gpt-5.6-sol` for `openai-codex/gpt-5.6-sol`. Include exactly one `Signed-off-by` trailer from the configured Git identity.

## Create the checkpoint

1. Inspect `git status --short`, unstaged diff, staged diff, applicable instructions, and recent commit style.
2. Identify intended files from the request and active workflow. Preserve unrelated user changes.
3. Run only repository-required generation or formatting commands before final staging. Inspect their output; unexpected semantic changes require implementation, not silent acceptance.
4. Stage only intended files, including required generated output. Reinspect staged and remaining unstaged diffs. Stop and ask if intended and unrelated work cannot be separated safely.
5. Check new files and the staged patch for credentials, local configuration, logs, temporary files, build artifacts, and accidental generated output without displaying sensitive values.
6. Write the message to a temporary file, inspect it literally, and create the commit with `git commit -S -F <file>` when signing is configured and available. Do not create or change signing keys.
7. If signing fails, report the reason and ask before creating an unsigned commit.
8. Verify the resulting `HEAD`, commit message, signature status, parent, staged scope, and remaining working tree. Return the full commit SHA and verification summary.

The checkpoint does not prove runtime behavior. Return control to the active workflow for exact-`HEAD` acceptance verification.
