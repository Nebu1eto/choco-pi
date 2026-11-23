/** Refresh requests and automatic opening: when the pane opens by itself, and what happens when it cannot. */
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

/* --------------------------------------------------- automatic opening */

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

/**
 * After a tool call that may have changed files: read the session source
 * and dock the pane when it lists a change. Coalesces triggers that arrive
 * while a read runs into one more read.
 */
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
  // Docking is impossible and the user was told once: reading git would change nothing.
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

/** Whether a trigger arrived during the last read; if so, the check reads once more. */
export function rearmCheck(pane: DiffPaneController, session: Session): boolean {
  if (session.autoCheck !== "again") return false;
  session.autoCheck = "running";
  return true;
}

/**
 * Start the automatic opening check without anyone awaiting it. Any failure
 * (a git read, the TUI probe, docking into Pi's layout, a stale context)
 * turns automatic opening off for the rest of this session and is told once;
 * `/diff` still opens the pane by hand.
 */
export function autoOpenInBackground(pane: DiffPaneController): void {
  const session = pane.current;
  if (!session) return;
  void maybeAutoOpen(pane, session).catch((error: RuntimeValue) =>
    autoOpenFailed(pane, session, error),
  );
}

/**
 * A host contained a throw from the view (guard.ts). Never throws: it runs
 * in a microtask, where nothing above would catch it.
 *
 * Render: the pane closes (a failure that comes from the data repeats on
 * every frame, and a pane that cannot draw only takes room), focus returns
 * to the editor, the user is told once, and the pane does not open by
 * itself again in this session; `/diff` by hand tries again.
 * Input: focus returns to the editor and the failure is shown on the
 * pane's message line; the pane stays, and the toggle shortcut and
 * `/diff close` (handled here, not by the view) still close it.
 */
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
    // Closing touched a stale or broken host; the notice below still says what happened.
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
  } catch {
    // A stale context: the session ended, nothing to tell.
  }
}

/** Never throws: it is the last handler of the background check. */
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
  } catch {
    // A notice is the only place to say it; when that fails too, automatic opening just stays off.
  }
}
