/** The live `/diff` session: creating and shutting it down, its store and preferences, and where its messages go. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiffSource, DiffStore } from "../../lib/changes/git/model.ts";
import { sanitizeTerminalText } from "../../lib/changes/terminal-text.ts";
import { createTurnCheckpointProvider } from "../core/checkpoints.ts";
import { isStaleContextError } from "../../lib/lifecycle.ts";
import { DEFAULT_DIFF_PANE_DEFAULT, type DiffPaneDefault } from "../../lib/agent-preferences.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { sourceLabel, type PaneColor } from "./format.ts";
import { createPrefsStore, DEFAULT_PANE_PREFS, prefsPath, type PrefsStore } from "./prefs.ts";
import { appendToEditor } from "../../lib/changes/references.ts";
import { type Session, type DiffPaneController, SESSION_SOURCE } from "./pane-state.ts";
import { refreshChangeTimes, reloadComments } from "./recorded-sync.ts";
import { followTurn } from "./checkpoint-nav.ts";

export function prefs(pane: DiffPaneController): PrefsStore {
  pane.prefsStore ??= createPrefsStore(
    prefsPath(pane.deps.agentDir()),
    pane.deps.prefsIo,
    pane.deps.clock,
  );
  return pane.prefsStore;
}

export function sessionFor(pane: DiffPaneController, ctx: ExtensionContext): Session {
  if (pane.current?.alive) return pane.current;
  const session: Session = {
    ctx,
    alive: true,
    userActed: false,
    width: DEFAULT_PANE_PREFS.width,
    recordedGeneration: 0,
    commentsGeneration: 0,
    source: SESSION_SOURCE,
    sourceGeneration: 0,
    defaultStatus: DEFAULT_DIFF_PANE_DEFAULT,
    defaultStatusChosen: false,
    autoArmed: true,
    autoHinted: false,
    autoFailed: false,
    autoCheck: "idle",
  };
  if (pane.deps.onDefaultStatusChange) {
    session.unsubscribeDefaultStatus = pane.deps.onDefaultStatusChange((status) => {
      if (!session.alive || pane.current !== session) return;
      session.defaultStatus = status;
      session.defaultStatusChosen = true;
      if (status === "auto") session.autoArmed = true;
    });
  }
  pane.current = session;
  return pane.current;
}

export function persist(pane: DiffPaneController, session: Session): void {
  prefs(pane).save({
    width: session.width,
  });
}

export async function readDefaultStatusSafe(pane: DiffPaneController): Promise<DiffPaneDefault> {
  const read = pane.deps.readDefaultStatus;
  if (!read) return DEFAULT_DIFF_PANE_DEFAULT;
  try {
    return await read();
  } catch {
    return DEFAULT_DIFF_PANE_DEFAULT;
  }
}

export function sessionHasBaseline(pane: DiffPaneController, session: Session): boolean {
  try {
    if (pane.deps.sessionBaseline) {
      return pane.deps.sessionBaseline(session.ctx).kind === "checkpoint";
    }
    return (pane.deps.listTurns?.(session.ctx).length ?? 0) > 0;
  } catch {
    return false;
  }
}

export function ensureStore(pane: DiffPaneController, session: Session): DiffStore {
  if (session.store) return session.store;
  const ctx = session.ctx;
  const listTurns = pane.deps.listTurns;
  const baseline = pane.deps.sessionBaseline;
  const checkpoints = listTurns
    ? createTurnCheckpointProvider(() => listTurns(ctx), baseline ? () => baseline(ctx) : undefined)
    : undefined;
  const store = pane.deps.createStore(ctx.cwd, checkpoints, session.source);
  session.store = store;
  session.unsubscribeStore = store.subscribe((update) => {
    if (!session.alive) return;
    // A poll can list a new prompt's edits before any event names them. Following
    // changes the source, and `update` is then older than what the store holds.
    const generation = session.sourceGeneration;
    followTurn(pane, session);
    const state = generation === session.sourceGeneration ? update : store.getState();
    session.view?.setState(state);
    if (
      state.kind === "ready" &&
      state.snapshot.revision !== session.timesRevision &&
      (session.recorded?.findings.length ?? 0) > 0
    ) {
      void refreshChangeTimes(pane, session);
    }
    if (state.kind === "ready" && state.snapshot.revision !== session.commentsRevision) {
      void reloadComments(pane, session);
    }
    session.host?.requestRender();
  });
  return store;
}

/* ------------------------------------------------------ messages */

export function say(
  pane: DiffPaneController,
  session: Session,
  text: string,
  color: PaneColor = "muted",
): void {
  if (session.view && session.host) {
    session.view.setMessage(text, color);
    session.host.requestRender();
  } else {
    session.ctx.ui.notify(
      sanitizeTerminalText(text),
      color === "warning" || color === "error" ? "warning" : "info",
    );
  }
}

/**
 * Confirm a source switch. The open pane names its source on the header's
 * border, so there it only clears an older message (an earlier failure
 * would otherwise stay up); a closed pane gets a notice.
 */
export function saySource(pane: DiffPaneController, session: Session, source: DiffSource): void {
  if (session.view && session.host) {
    session.view.clearMessage();
    session.host.requestRender();
  } else {
    say(pane, session, `Diff source: ${sourceLabel(source)}.`);
  }
}

/**
 * Show a failure of work nothing awaits: in the open pane, else as a notice.
 * Silent once the session ended or its context went stale. Never throws, so
 * it is safe as the last handler of a fire-and-forget promise.
 */
export function reportFailure(
  pane: DiffPaneController,
  session: Session,
  text: string,
  error: RuntimeValue,
): void {
  if (!session.alive || isStaleContextError(error)) return;
  try {
    say(pane, session, text, "error");
  } catch (failure) {
    if (isStaleContextError(failure) || !session.view || !session.host) return;
    // The pane could not show it: try a notice instead.
    try {
      session.ctx.ui.notify(sanitizeTerminalText(text), "warning");
    } catch {
      // Neither the pane nor a notice can show it; there is nowhere left to report it.
    }
  }
}

/** Give keyboard focus back to the prompt editor without arming double-Esc close. */
export function returnToEditor(pane: DiffPaneController, session: Session): void {
  if (session.host?.isFocused()) session.host.unfocus();
}

export function insertIntoEditor(pane: DiffPaneController, session: Session, text: string): void {
  const ui = session.ctx.ui;
  ui.setEditorText(appendToEditor(ui.getEditorText(), text));
  returnToEditor(pane, session);
}

/* ------------------------------------------------- review records */

export function shutdown(pane: DiffPaneController, session: Session): void {
  session.alive = false;
  if (pane.current === session) pane.current = undefined;
  session.unsubscribeDefaultStatus?.();
  session.unsubscribeDefaultStatus = undefined;
  session.escapeArmedUntil = undefined;
  session.removeInputListener?.();
  session.removeInputListener = undefined;
  session.host?.uninstall();
  session.host = undefined;
  session.unsubscribeStore?.();
  session.unsubscribeStore = undefined;
  session.store?.dispose();
  session.store = undefined;
  session.view?.dispose();
  session.view = undefined;
  session.tui = undefined;
  session.recordedGeneration += 1;
}
