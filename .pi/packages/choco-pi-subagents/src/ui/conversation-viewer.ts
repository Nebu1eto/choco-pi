/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  getMarkdownTheme,
  type MarkdownTransformer,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  matchesKey,
  type MarkdownTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { renderAgentName } from "../agent-color.ts";
import { extractText } from "../context.ts";
import type { AgentRecord } from "../types.ts";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.ts";
import type { Theme } from "./agent-widget.ts";
import {
  type AgentActivity,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatDuration,
  formatSessionTokens,
} from "./agent-widget.ts";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.ts";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

/**
 * Frame budget for the streaming tail. pi-tui paints up to ~60 fps; re-parsing
 * the growing tail's markdown on every streamed token is the per-frame cost
 * that stalls the whole TUI, so the tail re-renders at ~10 fps and keeps its
 * cached lines in between. Settling always gets one final full render.
 */
const TAIL_RENDER_INTERVAL_MS = 100;

interface HostBashExecutionTrace {
  role?: any;
  command?: any;
  output?: any;
  exitCode?: any;
  cancelled?: any;
  truncated?: any;
  fullOutputPath?: any;
  excludeFromContext?: any;
}

const HostStringSchema = Type.String();
const HostNumberSchema = Type.Number();
const HostBooleanSchema = Type.Boolean();

function parseHostString(value: any): string | undefined {
  return Value.Check(HostStringSchema, value) ? value : undefined;
}

interface BashExecutionTrace {
  command: string;
  output?: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext: boolean;
}

function parseBashExecution(message: HostBashExecutionTrace): BashExecutionTrace | undefined {
  if (message.role !== "bashExecution") return undefined;
  const command = parseHostString(message.command);
  if (command === undefined) return undefined;
  return {
    command,
    output: parseHostString(message.output),
    exitCode: Value.Check(HostNumberSchema, message.exitCode) ? message.exitCode : undefined,
    cancelled: Value.Check(HostBooleanSchema, message.cancelled) ? message.cancelled : false,
    truncated: Value.Check(HostBooleanSchema, message.truncated) ? message.truncated : false,
    fullOutputPath: parseHostString(message.fullOutputPath),
    excludeFromContext: Value.Check(HostBooleanSchema, message.excludeFromContext)
      ? message.excludeFromContext
      : false,
  };
}

export type ConversationViewerOptions = {
  /** Overlay keeps the modal viewport; focus yields its full transcript to Pi's main scroll view. */
  profile?: "overlay" | "focus";
  /** Enter fullscreen focus while preserving the overlay as the default viewer. */
  onFocus?: () => void;
  /** Side conversations can start another turn after the prior run settled. */
  allowReplyWhenFinished?: boolean;
  /** User-facing verb for the composer affordance. */
  replyLabel?: "steer" | "reply";
};

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;

  /**
   * Transcript message components, keyed by message object identity. Every
   * message renders through the exact components the main Pi transcript uses
   * (UserMessageComponent, AssistantMessageComponent, ToolExecutionComponent,
   * BashExecutionComponent), so a zentui install restyles this overlay the
   * same way it restyles the main agent.
   */
  private messageComponents = new Map<object, Array<{ render(w: number): string[] }>>();
  /** Rendered lines per message + width; dropped when a tool result lands. */
  private messageLineCache = new Map<object, { width: number; lines: string[] }>();
  private toolComponents = new Map<string, ToolExecutionComponent>();
  /** Tool calls whose result (real or synthesized error) has been applied. */
  private settledTools = new Set<string>();
  /** toolCallId -> owning assistant message, for line-cache invalidation. */
  private toolOwners = new Map<string, object>();

  /** Wall-clock stamp of the last streaming-tail render, for throttling. */
  private lastTailRenderAt = 0;
  /**
   * Messages whose head component was built with the streaming-fast markdown
   * theme (no syntax highlighting). Rebuilt at full fidelity once they are no
   * longer the streaming tail.
   */
  private fastAssistantHeads = new Set<object>();

  /**
   * Whole-transcript line cache. buildContentLines runs on every TUI frame
   * (up to ~60 fps during streaming), so between session events the joined
   * array, block spacing and the empty-state are reused; a session event,
   * a throttle tick or a width change marks it dirty.
   */
  private contentCache: { width: number; lines: string[] } | undefined;
  private contentDirty = true;

  /** Last seen running state, so settle transitions invalidate the cache. */
  private wasRunning: boolean;

  // choco-pi fork: parameter properties desugared to explicit fields (see the
  // note in `group-join.ts`) so this file stays erasable-syntax-only. The
  // assignments below run before the original constructor body, exactly where
  // TypeScript would have emitted them.
  private tui: TUI;
  private session: AgentSession;
  private record: AgentRecord;
  private activity: AgentActivity | undefined;
  private theme: Theme;
  private done: (result: undefined) => void;
  /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
  private onStop?: () => void;
  /** Send a steering message to the agent. Omitted → no compose affordance. */
  private onSteer?: (message: string) => void;
  private profile: "overlay" | "focus";
  private onFocus?: () => void;
  private allowReplyWhenFinished: boolean;
  private replyLabel: "steer" | "reply";

  constructor(
    tui: TUI,
    session: AgentSession,
    record: AgentRecord,
    activity: AgentActivity | undefined,
    theme: Theme,
    done: (result: undefined) => void,
    onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    onSteer?: (message: string) => void,
    options: ConversationViewerOptions = {},
  ) {
    this.tui = tui;
    this.session = session;
    this.record = record;
    this.activity = activity;
    this.theme = theme;
    this.done = done;
    this.onStop = onStop;
    this.onSteer = onSteer;
    this.profile = options.profile ?? "overlay";
    this.onFocus = options.onFocus;
    this.allowReplyWhenFinished = options.allowReplyWhenFinished === true;
    this.replyLabel = options.replyLabel ?? "steer";

    this.wasRunning = this.record.status === "running";
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.contentDirty = true;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "f") && this.onFocus) {
      this.closed = true;
      this.done(undefined);
      this.onFocus();
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    if (this.profile === "focus") {
      // Focus takes over Pi's whole conversation area; any chrome of our own
      // (box, header, footer) would break the illusion that this IS the main
      // transcript. The focus widget above the editor carries the hints.
      return this.buildContentLines(width);
    }
    return this.renderOverlay(width);
  }

  private renderOverlay(width: number): string[] {
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") +
      " " +
      truncateToWidth(pad(content, innerW), innerW, "...", true) +
      " " +
      th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const statusIcon =
      this.record.status === "running"
        ? th.fg("accent", "●")
        : this.record.status === "completed"
          ? th.fg("success", "✓")
          : this.record.status === "error"
            ? th.fg("error", "✗")
            : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    const sideTag = this.record.sideConversation ? `${th.fg("accent", "[btw]")} ` : "";
    lines.push(
      row(
        `${statusIcon} ${sideTag}${renderAgentName(this.record.type, th, { bold: true })}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
      ),
    );
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    // Pi's main transcript already owns clipping, native scrolling and follow-
    // end behavior. In focus mode give it the whole subagent transcript instead
    // of imposing the modal's 70% viewport inside that scroll view.
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", `✎ ${this.replyLabel}`);
      const composeGap = Math.max(
        1,
        innerW - visibleWidth(composeLeft) - visibleWidth(composeHint),
      );
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", `Enter ${this.replyLabel}`));
      if (this.onFocus) actions.push(th.fg("dim", "f focus"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const scrollPct =
        contentLines.length <= viewportHeight
          ? "100%"
          : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft =
        visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
          ? withCount
          : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  private isAgentActive(): boolean {
    return this.record.status === "running" || this.record.status === "queued";
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && this.isAgentActive();
  }

  /**
   * Ordinary viewers steer only an active run. A side-conversation viewer may
   * also accept a reply after settlement; its owner resumes the same session.
   */
  private canSteer(): boolean {
    return !!this.onSteer && (this.isAgentActive() || this.allowReplyWhenFinished);
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.messageComponents.clear();
    this.messageLineCache.clear();
    this.toolComponents.clear();
    this.settledTools.clear();
    this.toolOwners.clear();
    this.lastTailRenderAt = 0;
    this.fastAssistantHeads.clear();
    this.contentCache = undefined;
    this.contentDirty = true;
  }

  dispose(): void {
    this.closed = true;
    this.invalidate();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const running = this.record.status === "running";
    if (running !== this.wasRunning) {
      // Settling flips the tail out of streaming mode and rebuilds it at full
      // fidelity; that transition alone must refresh the cached lines.
      this.wasRunning = running;
      this.contentDirty = true;
    }

    const now = Date.now();
    const streaming = running;
    const renderTail = streaming && now - this.lastTailRenderAt >= TAIL_RENDER_INTERVAL_MS;
    if (renderTail) this.contentDirty = true;

    if (!this.contentDirty && this.contentCache && this.contentCache.width === width) {
      return this.contentCache.lines;
    }
    this.contentDirty = false;

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      this.contentCache = { width, lines };
      return lines;
    }

    this.syncComponents(renderTail);

    messages.forEach((msg, index) => {
      const isTail = streaming && index === messages.length - 1;
      let block: string[];
      const cached = this.messageLineCache.get(msg);
      const reusable = !!cached && cached.width === width;
      if (isTail) {
        // Inside the frame budget the tail keeps its last lines; a budget tick
        // or a width change re-renders it. Either way the lines get cached.
        if (renderTail || !reusable) {
          block = this.renderMessage(msg, width);
          this.messageLineCache.set(msg, { width, lines: block });
          this.lastTailRenderAt = now;
        } else {
          block = cached.lines;
        }
      } else if (reusable) {
        block = cached.lines;
      } else {
        block = this.renderMessage(msg, width);
        this.messageLineCache.set(msg, { width, lines: block });
      }
      if (block.length === 0) return;
      // Pi spaces transcript blocks with a blank row before user messages;
      // one row between rendered blocks reads the same inside this overlay.
      if (lines.length > 0) lines.push("");
      lines.push(...block);
    });

    // Streaming indicator for running agents
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    // Rows are truncated at paint time; clipping every line here would be
    // redundant per-frame work on the whole transcript.
    this.contentCache = { width, lines };
    return lines;
  }

  /**
   * Bring message components level with the session transcript. Idempotent:
   * an unchanged message keeps its components; only new messages, a streaming
   * tail and freshly landed tool results do work. Runs before any rendering,
   * so a result arriving in the same frame as its call still settles first.
   */
  private syncComponents(renderTail: boolean): void {
    const messages = this.session.messages;
    const streaming = this.record.status === "running";
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isTail = streaming && i === messages.length - 1;

      if (msg.role === "user") {
        const text = Array.isArray(msg.content) ? extractText(msg.content) : msg.content;
        if (!text.trim()) continue;
        if (!this.messageComponents.has(msg)) {
          this.messageComponents.set(msg, [
            new UserMessageComponent(
              text.trim(),
              getMarkdownTheme(),
              1,
              this.markdownTransformers(),
            ),
          ]);
        }
        continue;
      }

      if (msg.role === "assistant") {
        let components = this.messageComponents.get(msg);
        const wantFastTheme = isTail;
        if (!components || this.fastAssistantHeads.has(msg) !== wantFastTheme) {
          // (Re)build the head. While the message is the streaming tail it
          // uses a theme without syntax highlighting — re-highlighting every
          // code block on each tick is the streaming hot path; once the
          // message stops being the tail it is rebuilt highlighted, exactly
          // like the main transcript's final render.
          components = [
            new AssistantMessageComponent(
              msg,
              false,
              this.markdownThemeFor(wantFastTheme),
              undefined,
              1,
              this.markdownTransformers(),
            ),
          ];
          if (wantFastTheme) this.fastAssistantHeads.add(msg);
          else this.fastAssistantHeads.delete(msg);
          this.messageLineCache.delete(msg);
          for (const content of msg.content) {
            if (content.type !== "toolCall") continue;
            let tool = this.toolComponents.get(content.id);
            if (!tool) {
              tool = new ToolExecutionComponent(
                content.name,
                content.id,
                content.arguments,
                undefined,
                this.toolDefinition(content.name),
                this.tui,
                this.cwd(),
              );
              tool.setArgsComplete();
              tool.markExecutionStarted();
              this.toolComponents.set(content.id, tool);
              this.toolOwners.set(content.id, msg);
            }
            components.push(tool);
          }
          this.messageComponents.set(msg, components);
        }
        const head = components[0];
        if (isTail && renderTail && head instanceof AssistantMessageComponent) {
          head.updateContent(msg, true);
        }
        // A run that died mid-tool settles the call with its error instead of
        // spinning forever — the main transcript rows read the same way.
        if (msg.stopReason === "aborted" || msg.stopReason === "error") {
          const errorText =
            msg.stopReason === "error" ? msg.errorMessage || "Error" : "Operation aborted";
          for (const content of msg.content) {
            if (content.type !== "toolCall" || this.settledTools.has(content.id)) continue;
            this.toolComponents
              .get(content.id)
              ?.updateResult(
                { content: [{ type: "text", text: errorText }], isError: true },
                false,
              );
            this.settledTools.add(content.id);
          }
        }
        continue;
      }

      if (msg.role === "toolResult") {
        // Results render inside their tool component; no standalone block.
        const tool = this.toolComponents.get(msg.toolCallId);
        if (tool && !this.settledTools.has(msg.toolCallId)) {
          tool.updateResult(
            {
              // SAFETY: pi-ai tool results carry exactly this content-item shape.
              content: msg.content as Array<{ type: string; text?: string; data?: string }>,
              details: msg.details,
              isError: msg.isError,
            },
            false,
          );
          this.settledTools.add(msg.toolCallId);
          const owner = this.toolOwners.get(msg.toolCallId);
          if (owner) this.messageLineCache.delete(owner);
        }
        continue;
      }

      const bash = parseBashExecution(msg);
      if (!bash) continue;
      // A streaming bash message keeps mutating in place; rebuild it each
      // budget tick. Settled ones keep their component (and its cache).
      if (!this.messageComponents.has(msg) || (isTail && renderTail)) {
        const component = new BashExecutionComponent(
          bash.command,
          this.tui,
          bash.excludeFromContext,
        );
        if (bash.output) component.appendOutput(bash.output);
        // SAFETY: the wire message carries only the truncated flag, and the
        // component reads only that flag from this value.
        const truncation = bash.truncated
          ? ({ truncated: true } as Parameters<BashExecutionComponent["setComplete"]>[2])
          : undefined;
        component.setComplete(bash.exitCode, bash.cancelled, truncation, bash.fullOutputPath);
        this.messageComponents.set(msg, [component]);
        this.messageLineCache.delete(msg);
      }
    }
  }

  private renderMessage(msg: AgentSession["messages"][number], width: number): string[] {
    const components = this.messageComponents.get(msg);
    if (!components) return [];
    const lines: string[] = [];
    for (const component of components) {
      lines.push(...component.render(width));
    }
    return lines;
  }

  /** Registered tool renderers, exactly what the main transcript passes. */
  private toolDefinition(name: string): ConstructorParameters<typeof ToolExecutionComponent>[4] {
    try {
      return this.session.getToolDefinition(name);
    } catch {
      return undefined;
    }
  }

  /**
   * Markdown theme for an assistant component. The streaming variant skips
   * syntax highlighting: cli-highlight re-runs on every code block for each
   * streaming tick, dominating the tail's per-frame cost. The settle-time
   * rebuild restores full highlighting.
   */
  private markdownThemeFor(streamingTail: boolean): MarkdownTheme {
    const theme = getMarkdownTheme();
    if (!streamingTail) return theme;
    return {
      ...theme,
      highlightCode: (code: string) => code.split("\n"),
    };
  }

  private cwd(): string {
    try {
      return this.session.sessionManager.getCwd();
    } catch {
      return process.cwd();
    }
  }

  /** Extension markdown transformers (e.g. diagrams) registered on the child session. */
  private markdownTransformers(): readonly MarkdownTransformer[] {
    try {
      // SAFETY: extensionRunner exposes this accessor in the pi runtime; the
      // optional-chain guards sessions that do not carry one.
      const runner = this.session.extensionRunner as
        | { getMarkdownTransformers?: () => MarkdownTransformer[] }
        | undefined;
      const transformers = runner?.getMarkdownTransformers?.();
      return Array.isArray(transformers) ? transformers : [];
    } catch {
      return [];
    }
  }
}
