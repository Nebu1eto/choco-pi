import {
  type AgentSession,
  type AgentSessionEvent,
  AssistantMessageComponent,
  BashExecutionComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomMessageComponent,
  getMarkdownTheme,
  type MarkdownTransformer,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  matchesKey,
  type MarkdownTheme,
  Text,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { dispatchMouseEvent } from "@earendil-works/pi-tui/dist/tui.js";
import { arr, compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { isBoolean, isFiniteNumber, isString } from "../value-guards.ts";
import { renderAgentName } from "../agent-color.ts";
import { extractText } from "../context.ts";
import { parseAgentMessage } from "../messaging.ts";
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

const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
export const VIEWPORT_HEIGHT_PCT = 70;

const TAIL_RENDER_INTERVAL_MS = 100;

type AssistantMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;
type ToolRendererDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];
type MessageLayout = { component: Component; y: number; height: number };
type MessageRender = { width: number; lines: string[]; layout: MessageLayout[] };

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

const PartialToolResultSchema = obj(
  {
    content: arr(
      obj(
        {
          type: str(),
          text: opt(str()),
          data: opt(str()),
          mimeType: opt(str()),
        },
        { open: true },
      ),
    ),
    details: opt(unknown()),
  },
  { open: true },
);
const isPartialToolResult = compile(PartialToolResultSchema).check;
type PartialToolResult = Static<typeof PartialToolResultSchema>;

function parseHostString(value: any): string | undefined {
  return isString(value) ? value : undefined;
}

function firstTerminalLine(text: string): string {
  const newlineIndex = text.indexOf("\n");
  return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
}

function composerTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  };
}

function fitComposerLines(lines: string[], maxRows: number): string[] {
  const body = lines.slice(1, -1);
  const window = Math.max(1, maxRows);
  if (body.length <= window) return body;
  const cursor = Math.max(
    0,
    body.findIndex((line) => line.includes(CURSOR_MARKER)),
  );
  const start = Math.min(Math.max(0, cursor - window + 1), body.length - window);
  return body.slice(start, start + window);
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
    exitCode: isFiniteNumber(message.exitCode) ? message.exitCode : undefined,
    cancelled: isBoolean(message.cancelled) ? message.cancelled : false,
    truncated: isBoolean(message.truncated) ? message.truncated : false,
    fullOutputPath: parseHostString(message.fullOutputPath),
    excludeFromContext: isBoolean(message.excludeFromContext) ? message.excludeFromContext : false,
  };
}

export type ConversationViewerOptions = {
  profile?: "overlay" | "focus";
  onFocus?: () => void;
  allowReplyWhenFinished?: boolean;
  replyLabel?: "steer" | "reply";
  toolOutputExpanded?: boolean;
  hideThinkingBlock?: boolean;
  hostMarkdownTransformers?: readonly MarkdownTransformer[];
};

export class ConversationViewer implements Component {
  private liveAssistant: AssistantMessage | undefined;
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private keys: ViewerKeys;
  private composer: Editor | undefined;

  private messageComponents = new Map<object, Component[]>();
  private messageLineCache = new Map<object, MessageRender>();
  private mouseLayout: Array<MessageLayout & { msg: object }> = [];
  private toolComponents = new Map<string, ToolExecutionComponent>();
  private builtInToolDefinitions = new Map<string, ToolRendererDefinition>();
  private expandableComponents = new Set<
    ToolExecutionComponent | BashExecutionComponent | CustomMessageComponent
  >();
  private toolOutputExpanded: boolean;
  private hideThinkingBlock: boolean;
  private hostMarkdownTransformers: readonly MarkdownTransformer[];
  private settledTools = new Set<string>();
  private completedToolArgs = new Set<string>();
  private toolOwners = new Map<string, object>();

  private lastTailRenderAt = 0;
  private fastAssistantHeads = new Set<object>();

  private contentCache: { width: number; lines: string[] } | undefined;
  private contentDirty = true;

  private wasRunning: boolean;

  private tui: TUI;
  private session: AgentSession;
  private record: AgentRecord;
  private activity: AgentActivity | undefined;
  private theme: Theme;
  private done: (result: undefined) => void;
  private onStop?: () => void;
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
    this.toolOutputExpanded = options.toolOutputExpanded === true;
    this.hideThinkingBlock = options.hideThinkingBlock === true;
    this.hostMarkdownTransformers = options.hostMarkdownTransformers ?? [];

    const streamingMessage = session.agent?.state.streamingMessage;
    if (streamingMessage?.role === "assistant") this.liveAssistant = streamingMessage;
    this.wasRunning = this.record.status === "running";
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
  }

  handleInput(data: string): void {
    if (this.composer) {
      if (matchesKey(data, "escape") && !this.composer.isShowingAutocomplete()) {
        this.composer = undefined;
      } else {
        this.composer.handleInput(data);
      }
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

    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

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
    if (width < 6) return [];
    if (this.profile === "focus") {
      return this.buildContentLines(width);
    }
    return this.renderOverlay(width);
  }

  toggleToolOutputExpanded(): void {
    this.setToolOutputExpanded(!this.toolOutputExpanded);
  }

  setToolOutputExpanded(expanded: boolean): void {
    this.toolOutputExpanded = expanded;
    for (const component of this.expandableComponents) component.setExpanded(expanded);
    this.refreshMessageRendering();
  }

  getToolOutputExpanded(): boolean {
    return this.toolOutputExpanded;
  }

  toggleThinkingVisibility(): void {
    this.hideThinkingBlock = !this.hideThinkingBlock;
    for (const components of this.messageComponents.values()) {
      const head = components[0];
      if (head instanceof AssistantMessageComponent) {
        head.setHideThinkingBlock(this.hideThinkingBlock);
      }
    }
    this.refreshMessageRendering();
  }

  private refreshMessageRendering(): void {
    this.messageLineCache.clear();
    this.contentCache = undefined;
    this.contentDirty = true;
    this.tui.requestRender();
  }

  renderPendingMessages(width: number): string[] {
    const steeringMessages = this.session.getSteeringMessages();
    const followUpMessages = this.session.getFollowUpMessages();
    if (steeringMessages.length === 0 && followUpMessages.length === 0) return [];

    const lines = [""];
    for (const message of steeringMessages) {
      const line = firstTerminalLine(message);
      lines.push(truncateToWidth(` ${this.theme.fg("dim", `Steering: ${line}`)}`, width));
    }
    for (const message of followUpMessages) {
      const line = firstTerminalLine(message);
      lines.push(truncateToWidth(` ${this.theme.fg("dim", `Follow-up: ${line}`)}`, width));
    }
    return lines;
  }

  private renderOverlay(width: number): string[] {
    const th = this.theme;
    const innerW = width - 4;
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

    lines.push(hrTop);
    let statusIcon: string;
    if (this.record.status === "running") statusIcon = th.fg("accent", "●");
    else if (this.record.status === "completed") statusIcon = th.fg("success", "✓");
    else if (this.record.status === "error") statusIcon = th.fg("error", "✗");
    else statusIcon = th.fg("dim", "○");
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

    const contentLines = this.buildContentLines(innerW);
    const composerLines = this.composer
      ? fitComposerLines(this.composer.render(innerW), this.composerRowBudget())
      : [];
    const viewportHeight = this.viewportHeight(composerLines.length);
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    lines.push(hrMid);
    if (this.composer) {
      for (const line of composerLines) lines.push(row(line));
      const composeHint = th.fg("dim", "Enter send · Shift+Enter newline · Esc cancel");
      const composeLeft = th.fg("accent", `✎ ${this.replyLabel}`);
      const composeGap = Math.max(
        1,
        innerW - visibleWidth(composeLeft) - visibleWidth(composeHint),
      );
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", `Enter ${this.replyLabel}`));
      if (this.onFocus) actions.push(th.fg("dim", "f focus"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

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

  private isStoppable(): boolean {
    return !!this.onStop && this.isAgentActive();
  }

  private canSteer(): boolean {
    return !!this.onSteer && (this.isAgentActive() || this.allowReplyWhenFinished);
  }

  private openComposer(): void {
    const editor = new Editor(this.tui, composerTheme(this.theme));
    editor.focused = true;
    editor.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    this.composer = editor;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.messageComponents.clear();
    this.messageLineCache.clear();
    this.toolComponents.clear();
    this.expandableComponents.clear();
    this.settledTools.clear();
    this.completedToolArgs.clear();
    this.toolOwners.clear();
    this.lastTailRenderAt = 0;
    this.fastAssistantHeads.clear();
    this.contentCache = undefined;
    this.contentDirty = true;
    this.mouseLayout = [];
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.closed || this.profile !== "focus" || this.contentCache?.width !== event.width) {
      return undefined;
    }
    const hit = this.mouseLayout.find(({ y, height }) => event.y >= y && event.y < y + height);
    if (!hit) return undefined;
    const result = dispatchMouseEvent(hit.component, {
      ...event,
      y: event.y - hit.y,
      height: hit.height,
    });
    if (result) {
      this.messageLineCache.delete(hit.msg);
      this.contentCache = undefined;
      this.contentDirty = true;
      this.tui.requestRender();
    }
    return result;
  }

  dispose(): void {
    this.closed = true;
    this.liveAssistant = undefined;
    this.invalidate();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (event.message.role === "assistant") this.trackLiveAssistant(event.message);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.commitLiveAssistant(event.message);
        break;
      case "tool_execution_start":
        this.syncComponents(false);
        this.toolComponents.get(event.toolCallId)?.markExecutionStarted();
        break;
      case "tool_execution_update": {
        this.syncComponents(false);
        const partialResult: unknown = event.partialResult;
        if (isPartialToolResult(partialResult)) {
          this.applyPartialToolResult(event.toolCallId, partialResult);
        }
        break;
      }
    }
    this.contentDirty = true;
    this.tui.requestRender();
  }

  private trackLiveAssistant(message: AssistantMessage): void {
    const previous = this.liveAssistant;
    this.liveAssistant = message;
    if (previous && previous !== message) {
      const components = this.messageComponents.get(previous);
      const cached = this.messageLineCache.get(previous);
      if (components) this.messageComponents.set(message, components);
      if (cached) this.messageLineCache.set(message, cached);
      if (this.fastAssistantHeads.has(previous)) this.fastAssistantHeads.add(message);
      this.forgetAssistant(previous);
    }
  }

  private commitLiveAssistant(message: AssistantMessage): void {
    if (this.liveAssistant) this.forgetAssistant(this.liveAssistant);
    this.liveAssistant = undefined;
    this.forgetAssistant(message);
  }

  private applyPartialToolResult(toolCallId: string, partialResult: PartialToolResult): void {
    const tool = this.toolComponents.get(toolCallId);
    if (tool && !this.settledTools.has(toolCallId)) {
      tool.updateResult({ ...partialResult, isError: false }, true);
      const owner = this.toolOwners.get(toolCallId);
      if (owner) this.messageLineCache.delete(owner);
    }
  }

  private forgetAssistant(message: AssistantMessage): void {
    this.messageComponents.delete(message);
    this.messageLineCache.delete(message);
    this.fastAssistantHeads.delete(message);
  }

  private transcriptMessages(): AgentSession["messages"] {
    const messages = this.ownMessages(this.session.messages);
    const live = this.liveAssistant;
    return live && !messages.includes(live) ? [...messages, live] : messages;
  }

  private ownMessages(messages: AgentSession["messages"]): AgentSession["messages"] {
    const start = this.record.transcriptStartAt;
    if (start === undefined) return messages;
    return messages.filter((message) => message.timestamp >= start);
  }

  private overlayRows(): number {
    return Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
  }

  private viewportHeight(composerRows = 0): number {
    return Math.max(MIN_VIEWPORT, this.overlayRows() - this.chromeLines() - composerRows);
  }

  private composerRowBudget(): number {
    return Math.max(1, this.overlayRows() - this.chromeLines() - MIN_VIEWPORT);
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0);
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
    const messages = this.transcriptMessages();
    const lines: string[] = [];
    this.mouseLayout = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      this.contentCache = { width, lines };
      return lines;
    }

    this.syncComponents(renderTail);

    messages.forEach((msg, index) => {
      const isTail = streaming && index === messages.length - 1;
      let rendered: MessageRender;
      const cached = this.messageLineCache.get(msg);
      const reusable = !!cached && cached.width === width;
      if (isTail) {
        if (renderTail || !reusable) {
          rendered = this.renderMessage(msg, width);
          this.messageLineCache.set(msg, rendered);
          this.lastTailRenderAt = now;
        } else {
          rendered = cached;
        }
      } else if (reusable) {
        rendered = cached;
      } else {
        rendered = this.renderMessage(msg, width);
        this.messageLineCache.set(msg, rendered);
      }
      const block = rendered.lines;
      if (block.length === 0) return;
      if (lines.length > 0) lines.push("");
      for (const entry of rendered.layout) {
        this.mouseLayout.push({ ...entry, msg, y: lines.length + entry.y });
      }
      lines.push(...block);
    });

    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    this.contentCache = { width, lines };
    return lines;
  }

  private syncComponents(renderTail: boolean): void {
    const messages = this.transcriptMessages();
    const streaming = this.record.status === "running";
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isTail = streaming && i === messages.length - 1;

      if (msg.role === "user") {
        const text = Array.isArray(msg.content) ? extractText(msg.content) : msg.content;
        if (!text.trim()) continue;
        if (!this.messageComponents.has(msg)) {
          const envelope = parseAgentMessage(text.trim());
          this.messageComponents.set(
            msg,
            envelope
              ? [
                  new Text(this.theme.fg("accent", `✉ ${envelope.from} [${envelope.type}]`), 0, 0),
                  new Text(envelope.body, 2, 0),
                ]
              : [
                  new UserMessageComponent(
                    text.trim(),
                    getMarkdownTheme(),
                    1,
                    this.markdownTransformers(),
                  ),
                ],
          );
        }
        continue;
      }

      if (msg.role === "custom") {
        if (msg.display && !this.messageComponents.has(msg)) {
          const renderer = this.session.extensionRunner?.getMessageRenderer(msg.customType);
          const component = new CustomMessageComponent(msg, renderer, getMarkdownTheme(), 1);
          component.setExpanded(this.toolOutputExpanded);
          this.messageComponents.set(msg, [component]);
          this.expandableComponents.add(component);
        }
        continue;
      }

      if (msg.role === "assistant") {
        let components = this.messageComponents.get(msg);
        const wantFastTheme = isTail && msg === this.liveAssistant;
        if (!components || this.fastAssistantHeads.has(msg) !== wantFastTheme) {
          components = [
            new AssistantMessageComponent(
              msg,
              this.hideThinkingBlock,
              this.markdownThemeFor(wantFastTheme),
              undefined,
              1,
              this.markdownTransformers(),
            ),
          ];
          if (wantFastTheme) this.fastAssistantHeads.add(msg);
          else this.fastAssistantHeads.delete(msg);
          this.messageLineCache.delete(msg);
          this.messageComponents.set(msg, components);
        }
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
            if (msg !== this.liveAssistant) {
              tool.setArgsComplete();
              this.completedToolArgs.add(content.id);
              tool.markExecutionStarted();
            }
            tool.setExpanded(this.toolOutputExpanded);
            this.toolComponents.set(content.id, tool);
            this.expandableComponents.add(tool);
          } else if (msg === this.liveAssistant) {
            tool.updateArgs(content.arguments);
          } else if (!this.completedToolArgs.has(content.id)) {
            tool.setArgsComplete();
            this.completedToolArgs.add(content.id);
          }
          this.toolOwners.set(content.id, msg);
          if (!components.includes(tool)) {
            components.push(tool);
            this.messageLineCache.delete(msg);
          }
        }
        const head = components[0];
        if (wantFastTheme && renderTail && head instanceof AssistantMessageComponent) {
          head.updateContent(msg, true);
        }
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
      if (!this.messageComponents.has(msg) || (isTail && renderTail)) {
        const previous = this.messageComponents.get(msg)?.[0];
        if (previous instanceof BashExecutionComponent) {
          this.expandableComponents.delete(previous);
        }
        const component = new BashExecutionComponent(
          bash.command,
          this.tui,
          bash.excludeFromContext,
        );
        if (bash.output) component.appendOutput(bash.output);
        // SAFETY: the wire message carries only the truncated flag, and the
        const truncation = bash.truncated
          ? ({ truncated: true } as Parameters<BashExecutionComponent["setComplete"]>[2])
          : undefined;
        component.setComplete(bash.exitCode, bash.cancelled, truncation, bash.fullOutputPath);
        component.setExpanded(this.toolOutputExpanded);
        this.messageComponents.set(msg, [component]);
        this.expandableComponents.add(component);
        this.messageLineCache.delete(msg);
      }
    }
  }

  private renderMessage(msg: AgentSession["messages"][number], width: number): MessageRender {
    const components = this.messageComponents.get(msg);
    const lines: string[] = [];
    const layout: MessageLayout[] = [];
    for (const component of components ?? []) {
      const rendered = component.render(width);
      layout.push({ component, y: lines.length, height: rendered.length });
      lines.push(...rendered);
    }
    return { width, lines, layout };
  }

  private toolDefinition(name: string): ToolRendererDefinition {
    const runner = this.session.extensionRunner;
    return runner
      ? runner.resolveToolRenderers(name, () => this.baseToolDefinition(name))
      : this.baseToolDefinition(name);
  }

  private baseToolDefinition(name: string): ToolRendererDefinition {
    let definition: ToolRendererDefinition;
    try {
      definition = this.session.getToolDefinition(name);
    } catch {
      definition = undefined;
    }

    const builtIn = this.builtInToolDefinition(name);
    if (!definition) return builtIn;
    if (!builtIn) return definition;
    return {
      ...definition,
      renderCall: definition.renderCall ?? builtIn.renderCall,
      renderResult: definition.renderResult ?? builtIn.renderResult,
    };
  }

  private builtInToolDefinition(name: string): ToolRendererDefinition {
    if (this.builtInToolDefinitions.has(name)) return this.builtInToolDefinitions.get(name);

    let definition: ToolRendererDefinition;
    try {
      const cwd = this.cwd();
      switch (name) {
        case "read":
          definition = createReadToolDefinition(cwd);
          break;
        case "bash":
          definition = createBashToolDefinition(cwd);
          break;
        case "powershell":
          definition = createPowerShellToolDefinition(cwd);
          break;
        case "edit":
          definition = createEditToolDefinition(cwd);
          break;
        case "write":
          definition = createWriteToolDefinition(cwd);
          break;
        case "grep":
          definition = createGrepToolDefinition(cwd);
          break;
        case "find":
          definition = createFindToolDefinition(cwd);
          break;
        case "ls":
          definition = createLsToolDefinition(cwd);
          break;
        default:
          definition = undefined;
      }
    } catch {
      definition = undefined;
    }
    this.builtInToolDefinitions.set(name, definition);
    return definition;
  }

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

  private markdownTransformers(): readonly MarkdownTransformer[] {
    try {
      // SAFETY: extensionRunner exposes this accessor in the pi runtime; the
      const runner = this.session.extensionRunner as
        | { getMarkdownTransformers?: () => MarkdownTransformer[] }
        | undefined;
      const transformers = runner?.getMarkdownTransformers?.();
      const extensionTransformers = Array.isArray(transformers) ? transformers : [];
      return [...this.hostMarkdownTransformers, ...extensionTransformers];
    } catch {
      return this.hostMarkdownTransformers;
    }
  }
}
