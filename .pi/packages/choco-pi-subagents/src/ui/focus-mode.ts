import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentRecord } from "../types.ts";
import type { AgentActivity, Theme } from "./agent-widget.ts";
import { ConversationViewer } from "./conversation-viewer.ts";
import { installMethodPatch } from "./method-patch-registry.ts";

const FOCUS_WIDGET_KEY = "subagent-focus";

type EditorLike = {
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  onSubmit?: (text: string) => void;
  addToHistory?(text: string): void;
};

type RenderTarget = {
  render(width: number): string[];
};

export type FocusUICtx = {
  setWidget(
    key: string,
    content:
      | undefined
      | string[]
      | ((tui: TUI, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

export type FocusManager = {
  steer(id: string, message: string): boolean;
  resume(
    id: string,
    message: string,
    signal?: AbortSignal,
    opts?: { isBackground?: boolean },
  ): Promise<AgentRecord | undefined>;
};

export type FocusState = { kind: "orchestrator" } | { kind: "agent"; agentId: string };

export type FocusControllerOptions = {
  getActivity?: (id: string) => AgentActivity | undefined;
  onSteered?: (id: string, message: string) => void;
  /**
   * Whether a visible switcher (FleetView) can currently move focus. Focus is
   * normally left by selecting another row there, so Esc is swallowed; without a
   * switcher Esc stays the escape hatch and must not strand the prompt.
   */
  hasSwitcher?: () => boolean;
};

/** Preserve fullscreen focus while unwinding nested `/agents` menus. */
export async function continueRunningAgentNavigation(
  focusRequested: boolean,
  reopenList: () => Promise<boolean>,
): Promise<boolean> {
  return focusRequested ? true : reopenList();
}

type ActiveFocus = {
  record: AgentRecord;
  tui: TUI;
  viewer: ConversationViewer;
  document: RenderTarget;
};

/**
 * A value that crossed Pi's host boundary — a TUI child, the focused component,
 * or a patched method argument. Unparsed by construction: the guards below are
 * its parser. Spelled as a union rather than `unknown` to match the named
 * host-boundary type choco-pi-lsp uses for the same job.
 */
type HostBoundaryValue = {} | null | undefined;

/**
 * The properties this module probes on a host object. Named rather than an
 * index signature so the value contract stays explicit, mirroring
 * choco-pi-lsp's `HostObject` convention.
 */
interface HostProbe {
  handleInput?: HostBoundaryValue;
  getText?: HostBoundaryValue;
  setText?: HostBoundaryValue;
  render?: HostBoundaryValue;
  children?: HostBoundaryValue;
}

type TUIWithFocusedComponent = TUI & { getFocusedComponent?: () => HostBoundaryValue };

const HostNumberSchema = Type.Number();
const HostStringSchema = Type.String();

/**
 * A plain host object whose probed properties stay unnarrowed until each one is
 * checked below, rather than passing `any` around.
 */
function hostObject(value: HostBoundaryValue): HostProbe | undefined {
  if (
    value === null ||
    Object(value) !== value ||
    Array.isArray(value) ||
    value instanceof Function
  ) {
    return undefined;
  }
  // SAFETY: The guard above admits only a non-array, non-callable host object,
  // whose probed properties are host-boundary values narrowed at each use below.
  return value as HostProbe;
}

function isEditorLike(value: HostBoundaryValue): value is EditorLike {
  const host = hostObject(value);
  return (
    host !== undefined &&
    host.handleInput instanceof Function &&
    host.getText instanceof Function &&
    host.setText instanceof Function
  );
}

function isRenderTarget(value: HostBoundaryValue): value is RenderTarget {
  return hostObject(value)?.render instanceof Function;
}

function childrenOf(value: HostBoundaryValue): HostBoundaryValue[] {
  const children = hostObject(value)?.children;
  return Array.isArray(children) ? children : [];
}

function hostNumber(value: HostBoundaryValue): number | undefined {
  return Value.Check(HostNumberSchema, value) ? value : undefined;
}

function hostString(value: HostBoundaryValue): string | undefined {
  return Value.Check(HostStringSchema, value) ? value : undefined;
}

/** Pi mounts the transcript document first in both regular and fullscreen TUI modes. */
function findDocument(tui: TUI): RenderTarget | undefined {
  const candidate = tui.children[0];
  return isRenderTarget(candidate) ? candidate : undefined;
}

function findEditor(tui: TUI): EditorLike | undefined {
  // SAFETY: Pi's TUI may expose this optional private accessor; its result is parsed by isEditorLike.
  const getFocused = (tui as TUIWithFocusedComponent).getFocusedComponent;
  const focused = getFocused instanceof Function ? getFocused.call(tui) : undefined;
  if (isEditorLike(focused)) return focused;

  // The editor container is a top-level root. Search only two levels so chat
  // message components that happen to expose getText cannot be mistaken for it.
  for (const root of tui.children) {
    if (isEditorLike(root)) return root;
    for (const child of childrenOf(root)) {
      if (isEditorLike(child)) return child;
    }
  }
  return undefined;
}

function focusLabel(record: AgentRecord): string {
  return `@${record.alias ?? record.handle ?? record.type}`;
}

/** Owns the orchestrator ↔ focused-agent state transition and both host patches. */
export class FocusedAgentController {
  private ui: FocusUICtx | undefined;
  private active: ActiveFocus | undefined;
  private restoreDocument: (() => void) | undefined;
  private restoreEditor: (() => void) | undefined;
  private patchedEditor: EditorLike | undefined;
  /** Main prompt draft held outside the focused editor and restored on exit. */
  private orchestratorEditorText: string | undefined;
  private manager: FocusManager;
  private options: FocusControllerOptions;

  constructor(manager: FocusManager, options: FocusControllerOptions = {}) {
    this.manager = manager;
    this.options = options;
  }

  setUICtx(ui: FocusUICtx): void {
    this.ui = ui;
  }

  getState(): FocusState {
    return this.active
      ? { kind: "agent", agentId: this.active.record.id }
      : { kind: "orchestrator" };
  }

  isFocused(): boolean {
    return this.active !== undefined;
  }

  /** Id of the focused record, for UI that mirrors focus (FleetView's cursor). */
  getFocusedAgentId(): string | undefined {
    return this.active?.record.id;
  }

  /** Replace the main transcript renderer and bind the current prompt editor. */
  focus(record: AgentRecord, tui: TUI, theme: Theme): boolean {
    if (!record.session) {
      this.ui?.notify(`Agent is ${record.status} — no session available.`, "info");
      return false;
    }
    const document = findDocument(tui);
    if (!document) {
      this.ui?.notify("Could not locate Pi's conversation area for agent focus.", "warning");
      return false;
    }

    this.restoreOrchestrator("silent");
    const viewer = new ConversationViewer(
      tui,
      record.session,
      record,
      this.options.getActivity?.(record.id),
      theme,
      () => this.unfocus(),
      undefined,
      undefined,
      undefined,
      { profile: "focus" },
    );
    this.active = { record, tui, viewer, document };

    this.restoreDocument = installMethodPatch(
      document,
      "render",
      "focused-conversation-render",
      ({ args }) => {
        this.ensureEditorPatch();
        const width = hostNumber(args[0]) ?? tui.terminal.columns;
        return viewer.render(width);
      },
    );
    this.ensureEditorPatch();
    this.installIndicator(record);
    tui.requestRender(true);
    return true;
  }

  /** Leave focus and repaint the restored orchestrator transcript. */
  unfocus(): void {
    this.restoreOrchestrator("render");
  }

  /**
   * Restore editor input before transcript output, then remove focus chrome.
   * `silent` skips the repaint for a caller that paints something else in the
   * same tick — a focus switch — or is tearing the controller down.
   */
  private restoreOrchestrator(repaint: "render" | "silent"): void {
    const previous = this.active;
    if (!previous) return;
    this.active = undefined;

    const editor = this.patchedEditor;
    this.restoreEditor?.();
    this.restoreEditor = undefined;
    this.patchedEditor = undefined;
    if (editor && this.orchestratorEditorText !== undefined) {
      editor.setText(this.orchestratorEditorText);
    }
    this.orchestratorEditorText = undefined;
    this.restoreDocument?.();
    this.restoreDocument = undefined;
    previous.viewer.dispose();
    this.ui?.setWidget(FOCUS_WIDGET_KEY, undefined);
    if (repaint === "render") previous.tui.requestRender(true);
  }

  dispose(): void {
    this.restoreOrchestrator("silent");
    this.ui = undefined;
  }

  private ensureEditorPatch(): void {
    const active = this.active;
    if (!active) return;
    const editor = findEditor(active.tui);
    if (!editor || editor === this.patchedEditor) return;

    this.restoreEditor?.();
    this.restoreEditor = undefined;
    this.patchedEditor = editor;
    if (this.orchestratorEditorText === undefined) {
      this.orchestratorEditorText = editor.getText();
      editor.setText("");
    }
    this.restoreEditor = installMethodPatch(
      editor,
      "handleInput",
      "focused-editor-input",
      ({ predecessor, receiver, args }) => {
        if (!this.active) return Function.prototype.apply.call(predecessor, receiver, args);
        const data = hostString(args[0]) ?? "";
        // Esc does NOT leave focus while the switcher is up: focus is switched
        // there (↑↓, with `main` restoring the orchestrator), exactly like
        // selecting any other agent. Swallowing it also keeps a prompt addressed
        // to a subagent from reaching the main session's interrupt. With no
        // switcher rendered, Esc remains the only way back and still exits.
        if (matchesKey(data, "escape")) {
          if (this.options.hasSwitcher?.() !== true) this.unfocus();
          return undefined;
        }

        // SAFETY: This adapter is installed only on the EditorLike value found above.
        const target = receiver as EditorLike;
        const originalSubmit = target.onSubmit;
        const focusedSubmit = (text: string): void => this.submitFocused(text, target);
        target.onSubmit = focusedSubmit;
        try {
          return Function.prototype.apply.call(predecessor, receiver, args);
        } finally {
          if (target.onSubmit === focusedSubmit) target.onSubmit = originalSubmit;
        }
      },
    );
  }

  private submitFocused(text: string, editor: EditorLike): void {
    const active = this.active;
    const message = text.trim();
    if (!active || !message) return;

    const { record } = active;
    if (record.status !== "running" && record.status !== "queued") {
      // A settled focused agent is RESUMED through the same path /btw replies
      // use — focus must never eat user input for a resumable session.
      if (record.session) {
        record.resultConsumed = false;
        editor.addToHistory?.(text);
        editor.setText("");
        this.options.onSteered?.(record.id, message);
        const label = focusLabel(record);
        this.ui?.notify(`Resuming ${label}…`, "info");
        active.tui.requestRender();
        void this.manager
          .resume(record.id, message, undefined, { isBackground: true })
          .then((resumed) => {
            if (resumed === undefined)
              this.ui?.notify(`Agent ${label} (${record.status}) cannot be resumed.`, "warning");
          })
          .catch((error) => {
            this.ui?.notify(
              `Could not resume ${label}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          });
        return;
      }
      // Pi's Editor clears before invoking onSubmit. Put the focused draft back
      // when nothing can receive it so a session-less record cannot eat input.
      editor.setText(text);
      this.ui?.notify(
        `Agent ${focusLabel(record)} is ${record.status} and cannot be steered.`,
        "info",
      );
      return;
    }
    if (!this.manager.steer(record.id, message)) {
      editor.setText(text);
      this.ui?.notify(
        `Agent ${focusLabel(record)} is ${record.status} and cannot be steered.`,
        "info",
      );
      return;
    }

    record.resultConsumed = false;
    editor.addToHistory?.(text);
    editor.setText("");
    this.options.onSteered?.(record.id, message);
    this.ui?.notify(`Sent to ${focusLabel(record)}`, "info");
    active.tui.requestRender();
  }

  private installIndicator(record: AgentRecord): void {
    this.ui?.setWidget(
      FOCUS_WIDGET_KEY,
      (_tui, theme) => ({
        // The FleetView switcher already names the focused agent and its keys,
        // so a second line above the editor only repeats it. Speak only when
        // the switcher is off, where this is the one signal focus is active —
        // and there Esc is the exit, not the switcher.
        render: (width) => {
          if (this.options.hasSwitcher?.() === true) return [];
          return [
            truncateToWidth(
              theme.fg(
                "dim",
                `Focused ${focusLabel(record)} · prompt targets this agent · Esc returns to main`,
              ),
              width,
            ),
          ];
        },
        invalidate: () => {},
      }),
      { placement: "aboveEditor" },
    );
  }
}
