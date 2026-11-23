import type { RefreshReason } from "../../lib/changes/git/model.ts";
import { sanitizeTerminalText } from "../../lib/changes/terminal-text.ts";
import { isStaleContextError } from "../../lib/lifecycle.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import type { PaneHost } from "../host/types.ts";
import { type Session, type DiffPaneController, type OpenResult, errorText } from "./pane-state.ts";
import { ensureStore, reportFailure } from "./pane-session.ts";
import { reloadRecorded, reloadComments } from "./recorded-sync.ts";
import { resetToSessionSource, followTurn } from "./checkpoint-nav.ts";
import { dockBlocker, openPane, closePane } from "./host-binding.ts";

export function requestRefresh(pane: DiffPaneController, reason: RefreshReason): void {
  const session = pane.current;
  if (!session?.alive || !session.host) return;
  followTurn(pane, session);
  session.store?.requestRefresh(reason);
  if (reason === "subagent") {
    void reloadRecorded(pane, session);
    void reloadComments(pane, session);
  }
}

export function autoEligible(pane: DiffPaneController, session: Session): boolean {
  return (
    session.alive &&
    pane.current === session &&
    session.ctx.mode === "tui" &&
    session.defaultStatus === "auto" &&
    session.autoArmed &&
    !session.autoFailed &&
    session.host === undefined
  );
}

export function autoHint(pane: DiffPaneController, session: Session, reason: string): void {
  if (session.autoHinted) return;
  session.autoHinted = true;
  session.ctx.ui.notify(
    `The diff pane did not open by itself: ${reason}. /diff lists this session's changes.`,
    "info",
  );
}

export async function maybeAutoOpen(pane: DiffPaneController, session: Session): Promise<void> {
  if (session.prefsPending) {
    await session.prefsPending;
    if (!session.alive || pane.current !== session) return;
  }
  if (!autoEligible(pane, session)) return;
  if (session.autoCheck !== "idle") {
    session.autoCheck = "again";
    return;
  }
  if (session.autoHinted && dockBlocker(pane, session) !== undefined) return;
  session.autoCheck = "running";
  try {
    for (;;) {
      resetToSessionSource(pane, session);
      const store = ensureStore(pane, session);
      await store.refreshNow();
      if (!autoEligible(pane, session)) return;
      const state = store.getState();
      const changed =
        state.kind === "ready" &&
        state.snapshot.source.kind === "session" &&
        state.snapshot.files.length + state.snapshot.omittedFiles > 0;
      if (changed) {
        const later = dockBlocker(pane, session);
        const result: OpenResult =
          later === undefined
            ? openPane(pane, session, { announce: false, overlay: false })
            : { opened: false, reason: later };
        if (!result.opened) autoHint(pane, session, result.reason);
        return;
      }
      if (!rearmCheck(pane, session)) return;
    }
  } finally {
    session.autoCheck = "idle";
  }
}

export function rearmCheck(pane: DiffPaneController, session: Session): boolean {
  if (session.autoCheck !== "again") return false;
  session.autoCheck = "running";
  return true;
}

export function autoOpenInBackground(pane: DiffPaneController): void {
  const session = pane.current;
  if (!session) return;
  void maybeAutoOpen(pane, session).catch((error: RuntimeValue) =>
    autoOpenFailed(pane, session, error),
  );
}

export function paneFailed(
  pane: DiffPaneController,
  session: Session,
  host: PaneHost,
  kind: "render" | "input",
  error: RuntimeValue,
): void {
  if (!session.alive || isStaleContextError(error)) return;
  if (session.host !== host) return;
  try {
    if (kind === "input") {
      host.unfocus();
      reportFailure(pane, session, `A key in the diff pane failed: ${errorText(error)}`, error);
      return;
    }
    session.autoFailed = true;
    closePane(pane, session);
  } catch (failure) {
    if (isStaleContextError(failure)) return;
  }
  if (kind !== "render") return;
  try {
    session.ctx.ui.notify(
      sanitizeTerminalText(
        `The diff pane could not be drawn (${errorText(error)}) and was closed; it will not open by itself again in this session. /diff opens it.`,
      ),
      "warning",
    );
  } catch {}
}

export function autoOpenFailed(
  pane: DiffPaneController,
  session: Session,
  error: RuntimeValue,
): void {
  if (session.autoFailed) return;
  session.autoFailed = true;
  if (!session.alive || pane.current !== session || isStaleContextError(error)) return;
  try {
    session.ctx.ui.notify(
      sanitizeTerminalText(
        `The diff pane could not open by itself (${errorText(error)}) and will not try again in this session; /diff opens it.`,
      ),
      "warning",
    );
  } catch {}
}
