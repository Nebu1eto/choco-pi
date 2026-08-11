---
name: commit
description: Create one well-scoped local Git checkpoint with choco-pi when the user requests a commit or an active workflow requires one. Use as the authoritative commit workflow; handle intended staging, repository policy, message construction, AI-assistance and sign-off trailers, configured signing, and final revision verification without ever pushing.
---

# choco-pi Commit

Create a commit only under explicit user authority or an active workflow's checkpoint rule. Never push, open a pull request, deploy, publish, or mutate another system.

## Resolve policy

Use applicable `AGENTS.md` and repository documentation first. If they define message format, generation, formatting, trailers, or signing, follow them. Otherwise use this default:

```text
[<scope>] <type>(<issue>): <short summary>

- <essential detail, only when needed>

Assisted-by: choco-pi:<current model id>
Signed-off-by: <git user.name> <git user.email>
```

- Use `[*]` for repository-wide work and the smallest meaningful package or component for `<scope>`. Omit the bracketed scope only when none can be determined.
- Use `feat`, `fix`, `refactor`, `test`, `docs`, or `chore`. Include an issue only when known; never invent one.
- Follow the user's language and keep the subject and each body bullet at or under 72 characters.
- Omit the body when the subject is sufficient. Otherwise use at most two terse bullets containing only essential context not already stated in the subject. Prefer short fragments; do not repeat the summary, narrate files, or add routine implementation detail.
- Include exactly one `Assisted-by` trailer for choco-pi and the runtime-injected current model ID. Include exactly one `Signed-off-by` trailer from the configured Git identity.

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
