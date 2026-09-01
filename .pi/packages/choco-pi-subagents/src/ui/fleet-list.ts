/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * The selection IS the fullscreen focus: moving onto a subagent row focuses it in
 * Pi's main conversation area, and moving back onto `main` restores the orchestrator.
 * The list therefore keeps rendering and keeps owning ↑/↓ while an agent is focused,
 * so switching agents is the same gesture as switching back to main; Esc only leaves
 * list navigation and never unfocuses. `/btw` rows are excluded from auto-focus —
 * they own their dismissible overlay, opened with Enter.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import {
  isKeyRelease,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hasAgentBadge } from "../agent-color.ts";
import type { AgentManager } from "../agent-manager.ts";
import type { AgentRecord } from "../types.ts";
import { getLifetimeTotal } from "../usage.ts";
import { buildAgentTree, type AgentTreeRow } from "./agent-tree.ts";
import { type AgentActivity, renderAgentTreeLabel, type Theme } from "./agent-widget.ts";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.ts";
import type { ViewerKeybindings } from "./viewer-keys.ts";

export type FleetFocusOptions = {
  focusAgent?: (record: AgentRecord, tui: TUI, theme: Theme) => boolean;
  /** Id of the agent currently holding fullscreen focus, if any. */
  focusedAgentId?: () => string | undefined;
  /** Restore the orchestrator transcript (selection moved to `main` or an unfocusable row). */
  unfocusAgent?: () => void;
  /** Side conversations own their dismissible/replyable overlay lifecycle. */
  openSideConversation?: (record: AgentRecord) => boolean;
};

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content:
      | undefined
      | ((
          tui: TUI,
          theme: Theme,
        ) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: ViewerKeybindings | undefined,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
};

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord; depth: number };
type FleetEntry = MainEntry | AgentEntry;
type FocusedComponentBoundary = {} | null | undefined;

interface FocusedEditorProbe {
  getText?: FocusedComponentBoundary;
  setText?: FocusedComponentBoundary;
  handleInput?: FocusedComponentBoundary;
}

function focusedEditorProbe(value: FocusedComponentBoundary): FocusedEditorProbe | undefined {
  if (
    value === null ||
    Object(value) !== value ||
    Array.isArray(value) ||
    value instanceof Function
  ) {
    return undefined;
  }
  // SAFETY: The guard admits only a non-array, non-callable host object;
  // each probed method is independently checked before use.
  return value as FocusedEditorProbe;
}

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k` — down-arrow prefix and compact magnitude. */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact}`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: TUI | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private theme: Theme | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  // choco-pi fork: parameter properties desugared to explicit fields (see the
  // note in `group-join.ts`) so this file stays erasable-syntax-only.
  private manager: AgentManager;
  private agentActivity: Map<string, AgentActivity>;
  private focusOptions: FleetFocusOptions;

  constructor(
    manager: AgentManager,
    agentActivity: Map<string, AgentActivity>,
    focusOptions: FleetFocusOptions = {},
  ) {
    this.manager = manager;
    this.agentActivity = agentActivity;
    this.focusOptions = focusOptions;
  }

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Whether the switcher is actually on screen. Focus mode asks this before
   * swallowing Esc: with no rows drawn there is nothing to switch with, so Esc
   * must stay the escape hatch.
   */
  isShowingRows(): boolean {
    return this.enabled && this.agentRows().length > 0;
  }

  /** Whether this list currently owns navigation keys. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) {
      this.viewerClose();
      this.viewerClose = undefined;
    }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.theme = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when no agents remain. */
  update(): void {
    if (!this.ui) return;
    const hasAgents = this.enabled && this.agentRows().length > 0;

    if (!hasAgents) {
      // The switcher is the only way out of focus, so it must never vanish
      // while an agent is focused: a settled focused record is evicted by the
      // manager's cleanup after ten minutes, which would otherwise leave the
      // orchestrator transcript unreachable with Esc swallowed.
      this.unfocusAgent();
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(
        FLEET_KEY,
        (tui, theme) => {
          this.tui = tui;
          this.theme = theme;
          return {
            render: (w: number) => this.renderBar(w, theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Children sit directly under their parent,
   * recursively, with siblings in the same launch order. Included: running/queued,
   * the viewed/focused agent, recently-finished records, and ancestors needed to
   * preserve a visible descendant's ownership path. A queued row without a session
   * remains selectable; focus/view reports that the session is not available yet.
   */
  private agentRows(): AgentTreeRow<AgentRecord>[] {
    const now = Date.now();
    const focusedId = this.focusOptions.focusedAgentId?.();
    const records = this.manager.listAgents();
    const byId = new Map(records.map((record) => [record.id, record]));
    const visibleIds = new Set(
      records
        .filter(
          (record) =>
            record.status === "running" ||
            record.status === "queued" ||
            record.id === this.viewingAgentId ||
            record.id === focusedId ||
            (record.completedAt != null && now - record.completedAt < FINISHED_LINGER_MS),
        )
        .map((record) => record.id),
    );

    // Keep ancestors visible while a descendant is active so indentation keeps
    // showing ownership even though textual agent identities are flat.
    for (const id of visibleIds) {
      let parentId = byId.get(id)?.parentAgentId;
      while (parentId !== undefined) {
        visibleIds.add(parentId);
        parentId = byId.get(parentId)?.parentAgentId;
      }
    }
    return buildAgentTree(records).filter((row) => visibleIds.has(row.record.id));
  }

  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.agentRows().map(({ record, depth }) => ({ kind: "agent" as const, record, depth })),
    ];
  }

  private clampSelection(): void {
    // A focused agent owns the cursor: its row is what the prompt targets, so the
    // marker must follow it even when the roster reorders underneath.
    const focusedIndex = this.focusedIndex();
    if (focusedIndex >= 0) this.selectedIndex = focusedIndex;
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  /** Roster index of the focused agent, or -1 when nothing is focused/listed. */
  private focusedIndex(): number {
    const focusedId = this.focusOptions.focusedAgentId?.();
    if (!focusedId) return -1;
    return this.roster().findIndex((e) => e.kind === "agent" && e.record.id === focusedId);
  }

  private isFocused(agentId?: string): boolean {
    const focusedId = this.focusOptions.focusedAgentId?.();
    if (agentId === undefined) return focusedId !== undefined;
    return focusedId === agentId;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input.
    if (this.viewerClose) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      if (isActivator && this.agentRows().length > 0 && this.ui.getEditorText() === "") {
        this.active = true;
        // Re-entering the list while an agent is focused keeps the cursor on that
        // agent, so the activating press never switches away from it.
        if (!this.isFocused()) this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows switch the focused agent, Enter opens the modal viewer,
    // Esc / Up-past-top leaves list navigation without changing focus.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      const next = Math.min(max, this.selectedIndex + 1);
      if (next !== this.selectedIndex) {
        this.selectedIndex = next;
        this.applySelection();
      }
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) {
        this.deactivate();
        return { consume: true };
      }
      this.selectedIndex -= 1;
      this.applySelection();
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.acceptSelection();
      return { consume: true };
    }
    if (matchesKey(data, "f")) {
      this.focusSelected();
      return { consume: true };
    }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    // SAFETY: Pi's TUI instance owns this optional private field for focus routing.
    const focused = (this.tui as { focusedComponent?: FocusedComponentBoundary } | undefined)
      ?.focusedComponent;
    if (focused == null) return true;
    const candidate = focusedEditorProbe(focused);
    return (
      candidate !== undefined &&
      candidate.getText instanceof Function &&
      candidate.setText instanceof Function &&
      candidate.handleInput instanceof Function
    );
  }

  private deactivate(): void {
    this.active = false;
    // Leaving navigation never unfocuses, so the cursor stays on the focused row.
    if (!this.isFocused()) this.selectedIndex = 0;
    this.update();
  }

  /**
   * Enter no longer opens the modal viewer for an ordinary agent: moving onto its
   * row already focused it in the main conversation area, so the overlay would
   * duplicate what is on screen. Enter simply ends navigation, leaving the prompt
   * addressed to that agent. A `/btw` row is the exception — its dismissible
   * overlay is the only way to read it, since side conversations never take focus.
   */
  private acceptSelection(): void {
    const entry = this.roster()[this.selectedIndex];
    if (entry?.kind === "agent" && entry.record.sideConversation) {
      this.openSelected();
      return;
    }
    this.deactivate();
  }

  /**
   * Selection is focus. Landing on a subagent row takes over Pi's main transcript
   * immediately; landing on `main`, on a `/btw` row (it owns a dismissible overlay
   * instead), or on a row that cannot be focused restores the orchestrator.
   */
  private applySelection(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry) return;
    if (entry.kind === "main" || entry.record.sideConversation) {
      this.unfocusAgent();
      return;
    }
    const record = entry.record;
    if (this.isFocused(record.id)) return;
    const focusAgent = this.focusOptions.focusAgent;
    if (!record.session || !this.tui || !this.theme || !focusAgent) {
      this.unfocusAgent();
      return;
    }
    if (!focusAgent(record, this.tui, this.theme)) this.unfocusAgent();
  }

  private unfocusAgent(): void {
    if (this.isFocused()) this.focusOptions.unfocusAgent?.();
  }

  private focusSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      this.unfocusAgent();
      this.deactivate();
      return;
    }
    if (!entry.record.session || !this.tui || !this.theme || !this.focusOptions.focusAgent) {
      this.ui?.notify(`Agent is ${entry.record.status} — fullscreen focus is unavailable.`, "info");
      return;
    }
    this.focusOptions.focusAgent(entry.record, this.tui, this.theme);
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (record.sideConversation && this.focusOptions.openSideConversation?.(record)) {
      this.active = false;
      this.update();
      return;
    }
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui
      .custom<undefined>(
        (tui, theme, keybindings, done) => {
          this.viewerClose = () => done(undefined);
          return new ConversationViewer(
            tui,
            session,
            record,
            activity,
            theme,
            done,
            () => {
              if (this.manager.abort(record.id))
                this.ui?.notify(`Stopped "${record.description}".`, "info");
            },
            keybindings,
            (message: string) => this.manager.steer(record.id, message),
            {
              onFocus: this.focusOptions.focusAgent
                ? () => queueMicrotask(() => this.focusOptions.focusAgent?.(record, tui, theme))
                : undefined,
            },
          );
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
        },
      )
      .then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    if (this.viewingAgentId) {
      const idx = this.roster().findIndex(
        (e) => e.kind === "agent" && e.record.id === this.viewingAgentId,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const agents = this.roster().filter((entry): entry is AgentEntry => entry.kind === "agent");
    if (agents.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, agents.length);

    // The switcher stays visible while an agent is focused — it is the only
    // affordance that says how to reach another agent or return to main.
    const focused = this.isFocused();
    // Enter is only meaningful on a `/btw` row now that selection is focus.
    const selectedEntry = this.roster()[this.selectedIndex];
    const selectedIsSide =
      selectedEntry?.kind === "agent" && selectedEntry.record.sideConversation === true;
    let hint: string;
    if (this.active) {
      if (selectedIsSide) {
        hint = "↑↓ switch agent · enter opens the [btw] overlay · esc back";
      } else {
        hint = "↑↓ switch agent · main returns to orchestrator · esc back";
      }
    } else {
      hint = focused
        ? "prompt targets the focused agent · ↓ to switch agents"
        : "esc to interrupt · ← for agents · ↓ to manage";
    }
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    // Window the agent rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, agents.length);
    const selAgent = Math.max(0, sel - 1);
    const start = selAgent < visible ? 0 : selAgent - visible + 1;
    const hiddenBelow = agents.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      lines.push(
        this.renderAgentRow({
          rosterIndex: a + 1,
          sel,
          record: agents[a].record,
          depth: agents[a].depth,
          width,
          theme,
        }),
      );
    }
    if (hiddenBelow > 0)
      lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  private renderAgentRow(row: {
    rosterIndex: number;
    sel: number;
    record: AgentRecord;
    depth: number;
    width: number;
    theme: Theme;
  }): string {
    const { rosterIndex, sel, record, depth, width, theme } = row;
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === sel;
    const name = renderAgentTreeLabel(record, depth, theme, {
      topLevel: selected
        ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
        : { fallbackColor: "muted" },
    });
    const sideTag = record.sideConversation ? theme.fg("accent", "[btw] ") : "";
    const workflowTag = record.workflowStepId
      ? theme.fg("accent", `[wf:${record.workflowStepId}] `)
      : "";
    const description = selected ? theme.fg("text", record.description) : record.description;
    const treePrefix = depth > 0 ? `${"  ".repeat(depth - 1)}└ ` : "";
    const status = depth > 0 ? theme.fg("dim", `[${record.status}] `) : "";
    const left = `  ${this.bullet(rosterIndex, sel, theme)} ${treePrefix}${sideTag}${workflowTag}${name}  ${status}${description}`;
    const tokens = getLifetimeTotal(
      this.agentActivity.get(record.id)?.lifetimeUsage ?? record.lifetimeUsage,
    );
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
