import { resolveDefaultBranchBase } from "../../lib/changes/git/default-base.ts";
import { listBranches, repositoryRoot } from "../core/git.ts";
import { listPullRequests } from "../core/pr.ts";
import type { ExecRunner, ReviewTarget, SessionCheckpointProvider } from "../core/types.ts";
import {
  pickReviewTarget,
  pullRequestTargetChoice,
  type ReviewTargetChoice,
  type TargetPickerHost,
} from "./target-picker.ts";

export type TargetChoiceContext = {
  cwd: string;
  sessionId: string;
  ui: TargetPickerHost & { notify(message: string, type?: "info" | "warning" | "error"): void };
};

async function currentBranch(root: string, runner: ExecRunner): Promise<string | undefined> {
  try {
    const result = await runner("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: root,
    });
    const name = result.stdout.trim();
    return result.code === 0 && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

async function defaultBase(root: string, runner: ExecRunner): Promise<string | undefined> {
  try {
    const choice = await resolveDefaultBranchBase(runner, root);
    return choice.kind === "found" ? choice.base : undefined;
  } catch {
    return undefined;
  }
}

export function branchBaseChoices(
  branches: readonly string[],
  current: string | undefined,
  base: string | undefined,
): ReviewTargetChoice[] {
  const ordered = [
    ...(base === undefined ? [] : [base]),
    ...branches.filter((name) => name !== base),
  ];
  return ordered
    .filter((name) => name !== current && name !== `refs/heads/${current ?? ""}`)
    .map((name) => ({ label: `Branch base: ${name}`, target: { kind: "branch", base: name } }));
}

export async function chooseReviewTarget(
  context: TargetChoiceContext,
  provider: SessionCheckpointProvider,
  runner: ExecRunner,
  isCurrent: () => boolean = () => true,
): Promise<ReviewTarget | undefined> {
  const root = await repositoryRoot(context.cwd, runner);
  if (!isCurrent()) return undefined;
  let pullRequestWarning: string | undefined;
  const [turns, branches, pullRequests, current, base] = await Promise.all([
    provider.listTurns().catch(() => []),
    listBranches(root, runner),
    listPullRequests(root, runner).catch((error: Error) => {
      pullRequestWarning = error.message;
      return [];
    }),
    currentBranch(root, runner),
    defaultBase(root, runner),
  ]);
  if (!isCurrent()) return undefined;
  if (pullRequestWarning) {
    context.ui.notify(`Pull request targets are unavailable: ${pullRequestWarning}`, "warning");
  }
  const candidates: ReviewTargetChoice[] = [];
  if (turns.length > 0) {
    candidates.push({
      label: "Current session",
      target: { kind: "session", sessionId: context.sessionId },
    });
  }
  candidates.push({ label: "Uncommitted changes", target: { kind: "branch", base: "HEAD" } });
  for (const pullRequest of pullRequests) {
    candidates.push(pullRequestTargetChoice(pullRequest.number, pullRequest.title));
  }
  candidates.push(...branchBaseChoices(branches, current, base));
  const target = await pickReviewTarget(
    {
      select: async (title, options) => {
        if (!isCurrent()) return undefined;
        const selected = await context.ui.select(title, options);
        return isCurrent() ? selected : undefined;
      },
    },
    candidates,
  );
  return isCurrent() ? target : undefined;
}
