/** Recorded review findings, file change times and review comments shown in the pane, each read so a stale result is dropped. */
import { join } from "node:path";
import {
  summarizeFindings,
  EMPTY_FINDINGS,
  type FindingsSummary,
} from "../../lib/changes/findings.ts";
import { isStaleContextError } from "../../lib/lifecycle.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { normalizeFindingPath } from "./pane-view.ts";
import { type Session, type DiffPaneController, errorText } from "./pane-state.ts";
import { reportFailure } from "./pane-session.ts";
import { followTurn } from "./checkpoint-nav.ts";

export function findingPaths(
  pane: DiffPaneController,
  session: Session,
  recorded: FindingsSummary,
): string[] {
  const state = session.store?.getState();
  if (state?.kind !== "ready") return [];
  const listed = new Set(state.snapshot.files.map((file) => file.path));
  const paths = new Set<string>();
  for (const finding of recorded.findings) {
    const path = normalizeFindingPath(finding.path, state.snapshot.repoRoot);
    if (listed.has(path)) paths.add(path);
  }
  return [...paths];
}

export async function changeTimesFor(
  pane: DiffPaneController,
  session: Session,
  recorded: FindingsSummary,
): Promise<Map<string, number | null>> {
  const times = new Map<string, number | null>();
  const stat = pane.deps.fileChangedAt;
  const state = session.store?.getState();
  if (!stat || state?.kind !== "ready") return times;
  const root = state.snapshot.repoRoot;
  for (const path of findingPaths(pane, session, recorded)) {
    times.set(path, await stat(join(root, path)).catch(() => null));
  }
  return times;
}

/**
 * A review-record read or change-time scan threw: keep the findings last read and
 * add the failure to the summary's read errors, which the header counts and
 * the findings list shows. Never throws.
 */
export function recordedFailed(
  pane: DiffPaneController,
  session: Session,
  error: RuntimeValue,
): void {
  if (!session.alive || isStaleContextError(error)) return;
  const text = `Cannot read the review records: ${errorText(error)}`;
  const previous = session.recorded ?? EMPTY_FINDINGS;
  const recorded = previous.errors.includes(text)
    ? previous
    : { ...previous, errors: [...previous.errors, text] };
  session.recorded = recorded;
  try {
    session.view?.setRecorded(recorded, session.view.changeTimes);
    session.host?.requestRender();
  } catch (failure) {
    reportFailure(pane, session, text, failure);
  }
}

/**
 * Re-read the review records (first use, manual refresh, subagent completion). Never
 * polls and never rejects: a failure is shown with the summary's read errors.
 */
export async function reloadRecorded(pane: DiffPaneController, session: Session): Promise<void> {
  const read = pane.deps.readRecords;
  if (!read || !session.view) return;
  let generation: number | undefined;
  try {
    const scratch = pane.deps.scratchDir?.(session.ctx);
    if (!scratch) return;
    session.recordedGeneration += 1;
    generation = session.recordedGeneration;
    const listing = await read(scratch).catch((error: RuntimeValue) => ({
      tasks: [],
      errors: [`Cannot read the review records: ${errorText(error)}`],
    }));
    if (!session.alive || generation !== session.recordedGeneration) return;
    const recorded = summarizeFindings(listing);
    const revision = currentRevision(pane, session);
    const times = await changeTimesFor(pane, session, recorded);
    if (!session.alive || generation !== session.recordedGeneration) return;
    session.recorded = recorded;
    session.timesRevision = revision;
    session.view?.setRecorded(recorded, times);
    session.host?.requestRender();
  } catch (error) {
    if (generation !== undefined && generation !== session.recordedGeneration) return;
    recordedFailed(pane, session, error);
  }
}

/** The working tree changed: re-check which findings predate their file's last change. Never rejects. */
export async function refreshChangeTimes(
  pane: DiffPaneController,
  session: Session,
): Promise<void> {
  const recorded = session.recorded;
  if (!recorded) return;
  session.recordedGeneration += 1;
  const generation = session.recordedGeneration;
  try {
    const revision = currentRevision(pane, session);
    session.timesRevision = revision;
    const times = await changeTimesFor(pane, session, recorded);
    if (!session.alive || generation !== session.recordedGeneration) return;
    session.view?.setRecorded(recorded, times);
    session.host?.requestRender();
  } catch (error) {
    if (generation !== session.recordedGeneration) return;
    recordedFailed(pane, session, error);
  }
}

export function currentRevision(pane: DiffPaneController, session: Session): number | undefined {
  const state = session.store?.getState();
  return state?.kind === "ready" ? state.snapshot.revision : undefined;
}

export function manualRefresh(pane: DiffPaneController, session: Session): void {
  followTurn(pane, session);
  session.store?.requestRefresh("manual");
  void reloadRecorded(pane, session);
  void reloadComments(pane, session);
}

/**
 * Re-read the `/review-assist` comments for the snapshot shown (first use, each new
 * snapshot, manual refresh, subagent completion). Never rejects: a failure is shown
 * in the pane's message line and the comments last read stay.
 */
export async function reloadComments(pane: DiffPaneController, session: Session): Promise<void> {
  const read = pane.deps.readComments;
  const view = session.view;
  const state = session.store?.getState();
  if (!read || !view || state?.kind !== "ready") return;
  session.commentsGeneration += 1;
  const generation = session.commentsGeneration;
  const snapshot = state.snapshot;
  session.commentsRevision = snapshot.revision;
  try {
    const sessionId = session.ctx.sessionManager.getSessionId();
    const comments = await read({
      repoRoot: snapshot.repoRoot,
      sessionId: sessionId || undefined,
      branch: snapshot.branch,
    });
    if (!session.alive || generation !== session.commentsGeneration) return;
    session.view?.setComments(comments);
    session.host?.requestRender();
  } catch (error) {
    if (generation !== session.commentsGeneration) return;
    reportFailure(pane, session, `Cannot read the review comments: ${errorText(error)}`, error);
  }
}

/* ---------------------------------------------------------- sources */
