import type { ReviewRecord, ReviewStore, ReviewTarget } from "../core/types.ts";

export type TargetPickerHost = {
  select(title: string, options: string[]): Promise<string | undefined>;
};

export type ReviewTargetChoice = {
  label: string;
  target: ReviewTarget;
};

export function pullRequestTargetChoice(number: number, title: string): ReviewTargetChoice {
  return {
    label: `Pull request #${number}: ${title}`,
    target: { kind: "pr", number },
  };
}

export function describeReviewTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case "session":
      return `session ${target.sessionId}`;
    case "session-turn":
      return `session ${target.sessionId}, turn ${target.turnIndex}`;
    case "branch":
      return target.target === undefined
        ? `${target.base}…HEAD`
        : `${target.base}…${target.target}`;
    case "pr":
      return `pull request #${target.number}`;
  }
}

function uniqueChoices(labels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return labels.map((label) => {
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}

/** Pick from caller-resolved targets; this module never resolves Git ranges or sessions. */
export async function pickReviewTarget(
  host: TargetPickerHost,
  candidates: readonly ReviewTargetChoice[],
): Promise<ReviewTarget | undefined> {
  if (candidates.length === 0) return undefined;
  const choices = uniqueChoices(candidates.map((candidate) => candidate.label));
  const selected = await host.select("Review target", choices);
  const index = selected === undefined ? -1 : choices.indexOf(selected);
  return index < 0 ? undefined : candidates[index]?.target;
}

function resumeLabel(record: ReviewRecord): string {
  const updated = new Date(record.updatedAt).toLocaleString();
  const reviewed = record.cursor.reviewedHunkIds.length;
  const comments = record.comments.length;
  return `${describeReviewTarget(record.target)} — ${reviewed} reviewed, ${comments} comment${comments === 1 ? "" : "s"} — ${updated}`;
}

/** Load and pick a persisted review, newest first. */
export async function pickReviewRecord(
  host: TargetPickerHost,
  store: ReviewStore,
  repoKey: string,
): Promise<ReviewRecord | undefined> {
  const records = [...(await store.list(repoKey))].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  if (records.length === 0) return undefined;
  const choices = uniqueChoices(records.map(resumeLabel));
  const selected = await host.select("Resume review", choices);
  const index = selected === undefined ? -1 : choices.indexOf(selected);
  return index < 0 ? undefined : records[index];
}
