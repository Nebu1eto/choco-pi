/**
 * side-conversation.ts — BTW-style orchestrator-owned side conversations.
 *
 * A side conversation is an ordinary top-level AgentRecord with a marker. It
 * therefore shares maxConcurrent, handles, persistence, FleetView and focus
 * mode with the rest of the fleet. This controller only owns launch defaults,
 * overlay lifetime and unobtrusive completion delivery.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";
import { getAvailableTypes, getFallbackSubagent, NO_FALLBACK, resolveSpawnType, type SpawnTypeResolution } from "../agent-types.ts";
import type { AgentRecord } from "../types.ts";
import type { AgentActivity, Theme } from "./agent-widget.ts";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.ts";

export type SideConversationUICtx = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (
      tui: any,
      theme: Theme,
      keybindings: any,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
};

export type SideConversationOptions = {
  getActivity?: (id: string) => AgentActivity | undefined;
  onSteered?: (id: string, message: string) => void;
  focusAgent?: (record: AgentRecord, tui: any, theme: Theme) => boolean;
};

/**
 * Pick the agent type for a side conversation. `general-purpose` is preferred,
 * but harnesses run with default agents disabled (`fallbackSubagent: "none"`),
 * so fall through the configured fallback, then `general`, then every
 * registered type. A BTW conversation must work in any viable fleet.
 */
export function resolveBtwType(): SpawnTypeResolution {
  const candidates: string[] = ["general-purpose"];
  const configured = getFallbackSubagent();
  if (configured && configured.toLowerCase() !== NO_FALLBACK) candidates.push(configured);
  candidates.push("general", ...getAvailableTypes());
  const seen = new Set<string>();
  let lastMessage = "No available agent type for a BTW conversation.";
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const dispatch = resolveSpawnType(candidate);
    if (dispatch.ok) return dispatch;
    lastMessage = dispatch.message;
  }
  return { ok: false, message: lastMessage };
}

function describeQuestion(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `btw: ${oneLine.slice(0, 69)}…` : `btw: ${oneLine}`;
}

export class SideConversationController {
  private manager: AgentManager;
  private options: SideConversationOptions;
  private ui: SideConversationUICtx | undefined;
  private autoOpen = new Set<string>();
  private openAgentId: string | undefined;
  private closeOverlay: (() => void) | undefined;

  constructor(manager: AgentManager, options: SideConversationOptions = {}) {
    this.manager = manager;
    this.options = options;
  }

  setUICtx(ui: SideConversationUICtx): void {
    this.ui = ui;
  }

  /**
   * Fork the main context into a bounded, read-only background subagent. The
   * main transcript receives no user or assistant turn from this path.
   */
  launch(pi: ExtensionAPI, ctx: ExtensionContext, type: string, question: string): string {
    let id: string | undefined;
    const reveal = () => {
      if (!id || !this.autoOpen.delete(id)) return;
      const record = this.manager.getRecord(id);
      if (record?.session) this.open(record);
    };

    id = this.manager.spawn(pi, ctx, type, question, {
      description: describeQuestion(question),
      isBackground: true,
      inheritContext: true,
      sideConversation: true,
      readOnly: true,
      rootSessionId: ctx.sessionManager?.getSessionId?.(),
      // Session creation is asynchronous in the real runner. Queueing also
      // makes this safe for synchronous test doubles that invoke the callback
      // before spawn() returns its id.
      onSessionCreated: () => queueMicrotask(reveal),
    });
    this.autoOpen.add(id);

    // A synchronous manager double may already have attached its session.
    if (this.manager.getRecord(id)?.session) queueMicrotask(reveal);
    return id;
  }

  /** Open one side conversation in the shared dismissible viewer. */
  open(record: AgentRecord): boolean {
    if (!record.sideConversation || !record.session || !this.ui) return false;
    if (this.openAgentId === record.id) return true;
    if (this.openAgentId) {
      this.ui.notify("Close the open BTW conversation before opening another.", "info");
      return false;
    }

    const ui = this.ui;
    const session = record.session;
    this.autoOpen.delete(record.id);
    this.openAgentId = record.id;

    void ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.closeOverlay = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          this.options.getActivity?.(record.id),
          theme,
          done,
          undefined,
          keybindings,
          (message) => this.reply(record, message),
          {
            allowReplyWhenFinished: true,
            replyLabel: "reply",
            onFocus: this.options.focusAgent
              ? () => queueMicrotask(() => this.options.focusAgent?.(record, tui, theme))
              : undefined,
          },
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(
      () => this.clearOverlay(record.id),
      () => this.clearOverlay(record.id),
    );
    return true;
  }

  /** Completion never steals focus after the user dismissed the overlay. */
  onAgentComplete(record: AgentRecord): void {
    if (!record.sideConversation) return;
    this.autoOpen.delete(record.id);
    if (this.openAgentId === record.id) return;
    const handle = record.alias ?? record.handle ?? record.id;
    this.ui?.notify(`BTW @${handle} finished. Run /btw to open it.`, record.status === "error" ? "warning" : "info");
  }

  isOpen(id?: string): boolean {
    return id === undefined ? this.openAgentId !== undefined : this.openAgentId === id;
  }

  dismiss(): void {
    this.closeOverlay?.();
  }

  dispose(): void {
    this.autoOpen.clear();
    this.dismiss();
    this.ui = undefined;
  }

  private reply(record: AgentRecord, message: string): void {
    record.resultConsumed = false;
    if (record.status === "running" || record.status === "queued") {
      if (this.manager.steer(record.id, message)) {
        this.options.onSteered?.(record.id, message);
      }
      return;
    }

    void this.manager.resume(record.id, message, undefined, { isBackground: true })
      .then((resumed) => {
        if (!resumed) this.ui?.notify("This BTW conversation cannot be resumed.", "warning");
      })
      .catch((error) => {
        this.ui?.notify(
          `Could not resume BTW conversation: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      });
  }

  private clearOverlay(id: string): void {
    if (this.openAgentId !== id) return;
    this.openAgentId = undefined;
    this.closeOverlay = undefined;
  }
}
