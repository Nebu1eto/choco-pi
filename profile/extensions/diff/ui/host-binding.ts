/** Mounting the pane in a dock or overlay host, its width, and opening, closing and focusing it. */
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { DiffStore } from "../../lib/changes/git/model.ts";
import { sanitizeTerminalText } from "../../lib/changes/terminal-text.ts";
import { editorRendersMarkdown, markdownText } from "../../lib/changes/markdown.ts";
import type { RuntimeValue } from "../../lib/runtime-values.ts";
import { createDockHost } from "../host/dock-host.ts";
import {
  BORDER_WIDTH,
  canHostPane,
  clampPaneWidth,
  MIN_PANE_WIDTH,
  MIN_TRANSCRIPT_WIDTH,
} from "../host/geometry.ts";
import { createOverlayHost } from "../host/overlay-host.ts";
import type { HostCallbacks } from "../../lib/changes/view/surface.ts";
import type { PaneHost } from "../host/types.ts";
import { inlineList, inlineMarkdown } from "./format.ts";
import { presentNativeDiff } from "../native-diff.ts";
import { PaneView } from "./pane-view.ts";
import {
  type Session,
  type DiffPaneController,
  type OpenResult,
  errorText,
  TOGGLE_SHORTCUT,
  FOCUS_SHORTCUT,
  DOUBLE_ESCAPE_MS,
} from "./pane-state.ts";
import { persist, ensureStore, say, reportFailure } from "./pane-session.ts";
import { reloadRecorded, manualRefresh, reloadComments } from "./recorded-sync.ts";
import { resetToSessionSource, cycleSource, stepTurn } from "./checkpoint-nav.ts";
import { ask, copy, notesFor, addNote, sendNotes, startReview } from "./pane-actions.ts";
import { paneFailed } from "./refresh-lifecycle.ts";

export function effectiveWidth(pane: DiffPaneController, session: Session): number {
  const tui = session.tui;
  return tui ? clampPaneWidth(session.width, tui.terminal.columns) : session.width;
}

export function setWidth(pane: DiffPaneController, session: Session, width: number): void {
  session.userActed = true;
  const tui = session.tui;
  session.width = tui
    ? clampPaneWidth(width, tui.terminal.columns)
    : Math.max(MIN_PANE_WIDTH, width);
  session.host?.setWidth(effectiveWidth(pane, session));
  persist(pane, session);
}

export function ensureView(pane: DiffPaneController, session: Session, store: DiffStore): PaneView {
  if (session.view) return session.view;
  const view = new PaneView({
    store,
    styler: pane.deps.styler(session.ctx),
    renderFileBody: pane.deps.renderFileBody,
    actions: {
      unfocus: () => {
        session.host?.unfocus();
        session.escapeArmedUntil = pane.deps.clock.now() + DOUBLE_ESCAPE_MS;
      },
      close: () => closePane(pane, session),
      resizeBy: (delta) => setWidth(pane, session, effectiveWidth(pane, session) + delta),
      refresh: () => manualRefresh(pane, session),
      requestRender: () => session.host?.requestRender(),
      isToggleKey: (data) => matchesKey(data, TOGGLE_SHORTCUT),
      isFocusKey: (data) => matchesKey(data, FOCUS_SHORTCUT),
      ask: (target) => ask(pane, session, target),
      copy: (target) => copy(pane, session, target),
      addNote: (file, hunk, text) => addNote(pane, session, file, hunk, text),
      sendNotes: () =>
        void sendNotes(pane, session).catch((error: RuntimeValue) =>
          reportFailure(
            pane,
            session,
            `Cannot put the notes in the editor: ${errorText(error)}`,
            error,
          ),
        ),
      cycleSource: () =>
        void cycleSource(pane, session).catch((error: RuntimeValue) =>
          reportFailure(pane, session, `Cannot change the diff source: ${errorText(error)}`, error),
        ),
      stepTurn: (delta) => stepTurn(pane, session, delta),
      startReview: () => startReview(pane, session),
    },
  });
  view.source = session.source;
  view.setState(store.getState());
  session.view = view;
  view.notes = notesFor(pane, session);
  void reloadRecorded(pane, session);
  void reloadComments(pane, session);
  loadHeaderBox(pane, session, view);
  return view;
}

/** zentui's header box, when installed; the view draws its own until it arrives. */
export function loadHeaderBox(pane: DiffPaneController, session: Session, view: PaneView): void {
  const load = pane.deps.headerBox;
  if (!load) return;
  void (async () => {
    const box = await load(session.ctx);
    if (!session.alive || session.view !== view || !box) return;
    view.headerBox = box;
    session.host?.requestRender();
  })().catch(() => {
    // zentui could not be loaded: the header keeps the theme's own box, which is complete.
  });
}

/** Why the pane cannot dock now, or undefined when it can try. */
export function dockBlocker(pane: DiffPaneController, session: Session): string | undefined {
  const ctx = session.ctx;
  if (ctx.mode !== "tui") return "it needs the terminal UI";
  session.tui ??= pane.deps.probe(ctx.ui);
  const tui = session.tui;
  if (!tui) return "the terminal UI could not be reached";
  if (tui.mode !== "fullscreen") return "it needs fullscreen mode (/settings, TUI mode)";
  if (!canHostPane(tui.terminal.columns)) {
    const needed = MIN_PANE_WIDTH + MIN_TRANSCRIPT_WIDTH + BORDER_WIDTH;
    return `the terminal is ${tui.terminal.columns} columns wide and it needs ${needed}`;
  }
  return undefined;
}

/**
 * Mount the pane. `overlay` allows the overlay host when docking fails
 * (user and restored opens); automatic opening never uses it.
 */
export function openPane(
  pane: DiffPaneController,
  session: Session,
  options: { announce: boolean; overlay: boolean },
): OpenResult {
  const announce = options.announce;
  if (session.host) return { opened: true };
  const ctx = session.ctx;
  if (ctx.mode !== "tui") return { opened: false, reason: "The diff pane needs the terminal UI." };
  session.tui ??= pane.deps.probe(ctx.ui);
  const tui = session.tui;
  if (!tui) return { opened: false, reason: "The diff pane could not reach the terminal UI." };
  if (tui.mode !== "fullscreen") {
    return {
      opened: false,
      reason: "The diff pane needs fullscreen mode (/settings, TUI mode); showing a list instead.",
    };
  }
  if (!canHostPane(tui.terminal.columns)) {
    const needed = MIN_PANE_WIDTH + MIN_TRANSCRIPT_WIDTH + BORDER_WIDTH;
    return {
      opened: false,
      reason: `The terminal is ${tui.terminal.columns} columns wide; the diff pane needs ${needed}. Showing a list instead.`,
    };
  }
  const store = ensureStore(pane, session);
  const view = ensureView(pane, session, store);
  const callbacks: HostCallbacks = {
    width: () => effectiveWidth(pane, session),
    resizeTo: (width) => setWidth(pane, session, width),
    failed: (kind, error) => paneFailed(pane, session, host, kind, error),
  };
  let host: PaneHost = createDockHost(tui, view, callbacks);
  let docked: boolean;
  try {
    docked = host.install();
  } catch (error) {
    // Automatic opening reports the failure and stops; a user's open falls back to the overlay.
    if (!options.overlay) throw error;
    docked = false;
  }
  let overlayFallback = false;
  if (!docked) {
    if (!options.overlay) {
      return { opened: false, reason: "Pi's screen layout is not the expected one" };
    }
    host = createOverlayHost(tui, view, callbacks);
    if (!host.install()) return { opened: false, reason: "The diff pane could not be mounted." };
    overlayFallback = true;
  }
  session.host = host;
  session.removeInputListener = tui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined;
    const armedUntil = session.escapeArmedUntil;
    session.escapeArmedUntil = undefined;
    if (
      armedUntil !== undefined &&
      pane.deps.clock.now() <= armedUntil &&
      matchesKey(data, "escape") &&
      !host.isFocused()
    ) {
      closePane(pane, session);
      return { consume: true };
    }
    return undefined;
  });
  store.setVisible(true);
  store.requestRefresh("open");
  if (overlayFallback && announce) {
    // On the pane's own message line: the overlay covers the transcript column
    // where a notification would be drawn, and clipped it.
    say(
      pane,
      session,
      "Opened as an overlay because Pi's screen layout is not the expected one. Close it (/diff close) before changing the TUI mode.",
      "warning",
    );
  }
  return { opened: true };
}

export function closePane(pane: DiffPaneController, session: Session): void {
  const host = session.host;
  if (!host) return;
  session.host = undefined;
  session.escapeArmedUntil = undefined;
  session.removeInputListener?.();
  session.removeInputListener = undefined;
  host.uninstall();
  session.store?.setVisible(false);
  // Every close is the user's (command, shortcut, double Esc): stop opening by itself.
  session.autoArmed = false;
  // A message about the old source (or anything else) would be stale when the pane reopens.
  if (session.view) {
    session.view.message = undefined;
    // A revealed sensitive file is shown for this opening only; reopening hides it again.
    session.view.hideRevealed();
  }
  resetToSessionSource(pane, session);
}

export async function showInline(
  pane: DiffPaneController,
  session: Session,
  reason: string | undefined,
): Promise<void> {
  const store = ensureStore(pane, session);
  await store.refreshNow();
  if (!session.alive) return;
  // Native-diff seam (native-diff.ts): an ACP client that renders diffs gets them instead.
  const native = { env: pane.env, clock: pane.deps.clock, alive: () => session.alive };
  if (await presentNativeDiff(session.ctx, store.getState(), native)) return;
  if (!session.alive) return;
  if (editorRendersMarkdown(pane.env)) {
    // Any other source in the editor: the same list as Markdown, sanitised once there.
    const list = inlineMarkdown(store.getState());
    session.ctx.ui.notify(reason ? `${markdownText(reason)}\n\n${list}` : list, "info");
    return;
  }
  const list = inlineList(store.getState());
  session.ctx.ui.notify(reason ? `${sanitizeTerminalText(reason)}\n${list}` : list, "info");
}

/** Open on the user's request; without `keepSource` the pane shows the session source. */
export async function userOpen(
  pane: DiffPaneController,
  session: Session,
  options: { keepSource: boolean } = { keepSource: false },
): Promise<boolean> {
  session.userActed = true;
  session.autoArmed = true;
  if (!options.keepSource && !session.host) resetToSessionSource(pane, session);
  const result = openPane(pane, session, { announce: true, overlay: true });
  if (result.opened) {
    return true;
  }
  await showInline(pane, session, session.ctx.mode === "tui" ? result.reason : undefined);
  return false;
}

export function userClose(pane: DiffPaneController, session: Session): void {
  session.userActed = true;
  session.autoArmed = false;
  closePane(pane, session);
}

export async function toggle(pane: DiffPaneController, session: Session): Promise<void> {
  if (session.host) userClose(pane, session);
  else await userOpen(pane, session);
}

export async function focusToggle(pane: DiffPaneController, session: Session): Promise<void> {
  if (session.host?.isFocused()) {
    session.host.unfocus();
    return;
  }
  if (session.host || (await userOpen(pane, session))) session.host?.focus();
}
