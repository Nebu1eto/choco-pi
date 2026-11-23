/**
 * `/diff` pane controller: command, shortcuts, session lifecycle, refresh
 * wiring, automatic opening, and preferences.
 *
 * The pane shows the session source (changes since the session's first file
 * checkpoint) whenever it opens without an explicit source; `/diff source …`
 * applies until the pane closes. Nothing runs before the user first opens the
 * pane, the `diffPaneDefault` preference asks for startup opening (`on`) or
 * auto-opening on a resumed checkpointed session (`auto`), or a possibly
 * file-changing tool call ends under `auto`: no store, no git, no timers, no
 * TUI probe. Sessions without the interactive terminal UI get the command (as
 * an inline list) but never a host and never open anything by themselves.
 *
 * Default status (`diffPaneDefault` in `/preferences`):
 * - `on`: opens when a TUI session starts; closing with `/diff` closes it for
 *   the current session without changing the preference.
 * - `off`: never opens by itself; `/diff` still opens and closes it manually.
 * - `auto` (default): opens only when the session has changes — after a tool
 *   call that is not known to be read-only, a subagent completion, or resuming
 *   a session with an existing checkpoint baseline. Never falls back to an
 *   overlay or inline list; leaves one hint per session when docking fails.
 *   Closing the pane stops automatic opening for the rest of the session until
 *   the user opens it again.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../../lib/changes/terminal-text.ts";
import type { DiffPaneDefault } from "../../lib/agent-preferences.ts";
import { editorRendersMarkdown, markdownText } from "../../lib/changes/markdown.ts";
import { DIFF_SUBCOMMANDS, parseDiffCommand } from "./command.ts";
import {
  type DiffPaneController,
  type DiffPaneDependencies,
  type DiffPaneProbe,
  noBaseMarkdown,
  errorText,
  TOGGLE_SHORTCUT,
  FOCUS_SHORTCUT,
  ENTER_PANE_SHORTCUT,
  SUBAGENT_DONE_EVENTS,
  READ_ONLY_TOOLS,
} from "./pane-state.ts";
import {
  prefs,
  sessionFor,
  readDefaultStatusSafe,
  sessionHasBaseline,
  say,
  reportFailure,
  shutdown,
} from "./pane-session.ts";
import { manualRefresh } from "./recorded-sync.ts";
import {
  applySource,
  resetToSessionSource,
  branchSource,
  showSource,
  sourceBranch,
  sourceTurn,
} from "./checkpoint-nav.ts";
import { sendNotes, clearNotes, startReview } from "./pane-actions.ts";
import {
  setWidth,
  openPane,
  showInline,
  userOpen,
  userClose,
  toggle,
  focusToggle,
} from "./host-binding.ts";
import { requestRefresh, autoOpenInBackground } from "./refresh-lifecycle.ts";

export {
  DOUBLE_ESCAPE_MS,
  ENTER_PANE_SHORTCUT,
  FOCUS_SHORTCUT,
  READ_ONLY_TOOLS,
  SUBAGENT_DONE_EVENTS,
  TOGGLE_SHORTCUT,
  type DiffPaneDependencies,
  type DiffPaneProbe,
} from "./pane-state.ts";

export function registerDiffPane(pi: ExtensionAPI, deps: DiffPaneDependencies): DiffPaneProbe {
  const pane: DiffPaneController = {
    pi,
    deps,
    env: deps.env ?? process.env,
    current: undefined,
    prefsStore: undefined,
  };

  pi.on("session_start", async (_event, ctx) => {
    const previous = pane.current;
    if (previous?.alive) shutdown(pane, previous);
    const session = sessionFor(pane, ctx);
    if (ctx.mode !== "tui") return;
    const load = Promise.all([prefs(pane).load(), readDefaultStatusSafe(pane)]).then(
      ([saved, defaultStatus]) => {
        if (!session.alive || pane.current !== session) return;
        if (!session.defaultStatusChosen) session.defaultStatus = defaultStatus;
        if (!session.userActed) session.width = saved.width;
      },
    );
    session.prefsPending = load;
    try {
      await load;
    } finally {
      if (session.prefsPending === load) session.prefsPending = undefined;
    }
    if (!session.alive || pane.current !== session) return;
    if (session.userActed || session.host) return;
    if (session.defaultStatus === "on") {
      openPane(pane, session, { announce: false, overlay: true });
    } else if (session.defaultStatus === "auto" && sessionHasBaseline(pane, session)) {
      autoOpenInBackground(pane);
    }
  });

  // Synchronous: hosts are removed before Pi tears the session down, and the
  // pending preference write (if any) starts now instead of on a timer.
  pi.on("session_shutdown", () => {
    if (pane.current) shutdown(pane, pane.current);
    if (pane.prefsStore) void pane.prefsStore.flush();
  });

  pi.on("tool_execution_end", (event) => {
    requestRefresh(pane, "tool");
    if (!READ_ONLY_TOOLS.has(event.toolName)) autoOpenInBackground(pane);
  });
  pi.on("agent_settled", () => requestRefresh(pane, "settled"));
  // `!cmd` shell commands emit nothing after they run; the next turn catches them.
  pi.on("turn_start", () => requestRefresh(pane, "turn"));
  for (const channel of SUBAGENT_DONE_EVENTS) {
    pi.events.on(channel, () => {
      requestRefresh(pane, "subagent");
      autoOpenInBackground(pane);
    });
  }

  pi.registerCommand("diff", {
    description: "Show this session's changes in a side pane",
    getArgumentCompletions: (prefix) => {
      const typed = prefix.trim();
      // An exact match offers nothing to complete; listing it makes Enter accept it instead of running.
      const items = DIFF_SUBCOMMANDS.filter(
        (item) => item.value.startsWith(typed) && item.value !== typed,
      ).map((item) => ({ value: item.value, label: item.value, description: item.description }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const session = sessionFor(pane, ctx);
      const command = parseDiffCommand(args);
      if (ctx.mode !== "tui") {
        // No terminal UI (print, RPC, ACP, subagent sessions): answer inline, never mount.
        // In the editor the usage text is Markdown-escaped: `<columns>` would be read as HTML.
        const editor = editorRendersMarkdown(pane.env);
        if (command.kind === "invalid") {
          ctx.ui.notify(editor ? markdownText(command.message) : command.message, "warning");
        } else if (command.kind === "review") {
          startReview(pane, session);
        } else if (command.kind === "notes" || command.kind === "source-turn") {
          ctx.ui.notify("Notes and turn sources need the diff pane in the terminal UI.", "info");
        } else if (command.kind === "auto") {
          ctx.ui.notify("The diff pane opens by itself only in the terminal UI.", "info");
        } else if (command.kind === "source") {
          applySource(pane, session, command.source);
          await showInline(pane, session, undefined);
        } else if (command.kind === "source-branch") {
          const choice = await branchSource(pane, session, command.base);
          // git's own text from a failed default-base lookup reaches a plain terminal here.
          if (choice.kind === "none")
            ctx.ui.notify(
              editor ? noBaseMarkdown(choice) : sanitizeTerminalText(choice.message),
              "warning",
            );
          if (choice.kind !== "found") return;
          applySource(pane, session, choice.source);
          await showInline(pane, session, undefined);
        } else {
          resetToSessionSource(pane, session);
          await showInline(pane, session, undefined);
        }
        return;
      }
      switch (command.kind) {
        case "invalid":
          // In the open pane when there is one: an overlay can cover a notification.
          say(pane, session, command.message, "warning");
          return;
        case "toggle":
          await toggle(pane, session);
          return;
        case "open":
          await userOpen(pane, session);
          return;
        case "close":
          userClose(pane, session);
          return;
        case "focus":
          if (!session.host?.isFocused()) await focusToggle(pane, session);
          return;
        case "width":
          setWidth(pane, session, command.width);
          if (!session.host) ctx.ui.notify(`Diff pane width set to ${session.width}.`, "info");
          return;
        case "refresh":
          if (session.host) manualRefresh(pane, session);
          else await showInline(pane, session, undefined);
          return;
        case "source":
          await showSource(pane, session, command.source);
          return;
        case "source-turn":
          await sourceTurn(pane, session, command.turn);
          return;
        case "source-branch":
          await sourceBranch(pane, session, command.base);
          return;
        case "auto":
          if (command.enabled !== undefined) {
            const next: DiffPaneDefault = command.enabled ? "auto" : "off";
            session.defaultStatus = next;
            session.defaultStatusChosen = true;
            if (next === "auto") session.autoArmed = true;
            if (deps.writeDefaultStatus) {
              try {
                await deps.writeDefaultStatus(next);
              } catch (error) {
                reportFailure(
                  pane,
                  session,
                  `Could not save the diff panel default: ${errorText(error)}`,
                  error,
                );
                return;
              }
              if (!session.alive) return;
            }
          }
          say(
            pane,
            session,
            session.defaultStatus === "on"
              ? "The diff pane opens on startup (/diff auto off stops it, or change it in /preferences)."
              : session.defaultStatus === "auto"
                ? "The diff pane opens by itself when the session has changes (/diff auto off stops it)."
                : "The diff pane does not open by itself (/diff auto on turns it back on).",
          );
          return;
        case "notes":
          if (command.action === "send") await sendNotes(pane, session);
          else await clearNotes(pane, session);
          return;
        case "review":
          startReview(pane, session);
          return;
      }
    },
  });

  pi.registerShortcut(TOGGLE_SHORTCUT, {
    description: "Toggle the diff pane",
    handler: async (ctx) => {
      if (ctx.mode === "tui") await toggle(pane, sessionFor(pane, ctx));
    },
  });
  pi.registerShortcut(FOCUS_SHORTCUT, {
    description: "Move focus into or out of the diff pane",
    handler: async (ctx) => {
      if (ctx.mode === "tui") await focusToggle(pane, sessionFor(pane, ctx));
    },
  });
  pi.registerShortcut(ENTER_PANE_SHORTCUT, {
    description: "Move focus into the open diff pane",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      const host = sessionFor(pane, ctx).host;
      if (host && !host.isFocused()) host.focus();
    },
  });

  return { session: () => pane.current };
}
