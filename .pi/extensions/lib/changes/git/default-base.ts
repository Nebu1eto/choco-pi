/**
 * The base a branch comparison uses when the user names none: the remote's
 * default branch when the repository knows it, then `main`, then `master`.
 */
import type { ExecRunner } from "../types.ts";
import { nulFields } from "./parse.ts";

export type DefaultBaseChoice = { kind: "found"; base: string } | { kind: "none"; message: string };

export const NO_DEFAULT_BASE_MESSAGE =
  "This repository has no remote default branch, no main and no master to compare with. Name one: /diff source branch <base>.";

async function verifiedCommit(runner: ExecRunner, cwd: string, ref: string): Promise<boolean> {
  const result = await runner("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

/** `origin` first, then any other remote whose HEAD points at a branch. */
async function remoteDefault(runner: ExecRunner, cwd: string): Promise<string | undefined> {
  const result = await runner(
    "git",
    ["for-each-ref", "--format=%(refname)%00%(symref:short)%00", "refs/remotes/"],
    { cwd },
  );
  if (result.code !== 0) return undefined;
  const fields = nulFields(result.stdout);
  const targets: Array<{ remote: string; target: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index] ?? "";
    const target = (fields[index + 1] ?? "").trim();
    const match = /^refs\/remotes\/(.+)\/HEAD$/u.exec(name.trim());
    if (match?.[1] && target && !target.startsWith("-")) {
      targets.push({ remote: match[1], target });
    }
  }
  targets.sort(
    (left, right) => Number(right.remote === "origin") - Number(left.remote === "origin"),
  );
  for (const { target } of targets) {
    if (await verifiedCommit(runner, cwd, target)) return target;
  }
  return undefined;
}

/** Resolve the default base. Rejects only when the runner does (deadline, cancellation). */
export async function resolveDefaultBranchBase(
  runner: ExecRunner,
  cwd: string,
): Promise<DefaultBaseChoice> {
  const remote = await remoteDefault(runner, cwd);
  if (remote !== undefined) return { kind: "found", base: remote };
  for (const branch of ["main", "master"]) {
    if (await verifiedCommit(runner, cwd, `refs/heads/${branch}`)) {
      return { kind: "found", base: branch };
    }
  }
  return { kind: "none", message: NO_DEFAULT_BASE_MESSAGE };
}
