# Immutable Review Bundle

The agent creating a review handoff owns bundle preparation. Create the bundle once in task scratch space before spawning the reviewer; never ask the reviewer to capture its own target.

Include:

- `target.diff`, captured once from the exact requested revision, range, or working-tree state, including requested untracked files;
- base and target revisions when available, plus the exact capture command;
- the user requirements and complete snapshots of every applicable `AGENTS.md` and review-policy file;
- current validation evidence with each command, completion status, relevant output, timestamp, and tested repository revision or working-tree state;
- a SHA-256 manifest covering `target.diff`, requirements, policy snapshots, metadata, and evidence.

Record the bundle path and the SHA-256 of its manifest in the reviewer prompt. After the manifest is written, treat the directory as immutable. If the target, requirements, policy, or relevant evidence changes, create a new bundle and a new review run rather than modifying or reusing the old one.

The reviewer independently verifies the recorded manifest digest and every listed file before review. `target.diff` is the sole change target; live repository files may supply unchanged context only. If the digest mismatches or any target, requirement, applicable policy snapshot, or checksum is missing, the reviewer outputs `INCOMPLETE`, names the defect, and stops without a clean-review claim.
