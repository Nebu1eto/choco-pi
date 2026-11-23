import type { Theme as PiTheme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { arr, compile, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { sanitizeTerminalText } from "../../../profile/extensions/lib/changes/terminal-text.ts";
import {
  analyzeVerdictText,
  layoutNotice,
  layoutSummary,
  messageLines,
  wrapText,
  type SummaryLine,
  type SummaryTone,
  type VerdictTextAnalysis,
} from "../../../profile/extensions/lib/verdict-summary.ts";
import { hasAgentBadge, renderAgentName } from "./agent-color.ts";
import { hostParams } from "./schema-bridge.ts";
import type { AgentRecord, NotificationDetails } from "./types.ts";
import { renderSubagentNotification } from "./ui/notification-render.ts";
import { getLifetimeTotal, type LifetimeUsage } from "./usage.ts";
import { finiteNum } from "./value-guards.ts";
import { VERDICT_RECORD_PREFIX } from "./verdict-record.ts";
import {
  type AgentActivity,
  type AgentDetails,
  type Theme,
  buildInvocationTags,
  fgPreservingNestedStyles,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  SPINNER,
} from "./ui/agent-widget.ts";

const isAgentDetails = compile(
  obj(
    {
      displayName: str(),
      description: str(),
      subagentType: str(),
      toolUses: finiteNum(),
      tokens: str(),
      durationMs: finiteNum(),
      status: oneOf([
        "queued",
        "running",
        "completed",
        "steered",
        "aborted",
        "stopped",
        "budget_exceeded",
        "watchdog_stopped",
        "error",
        "waiting_for_reset",
        "interrupted",
        "background",
      ] as const),
      modelName: opt(str()),
      tags: opt(arr(str())),
      turnCount: opt(finiteNum()),
      maxTurns: opt(finiteNum()),
      agentId: opt(str()),
      error: opt(str()),
      activity: opt(str()),
      spinnerFrame: opt(finiteNum()),
    },
    { open: true },
  ),
).check;
export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0),
  );
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: AgentDetails["status"];
    error?: string;
    id?: string;
    outputFile?: string;
    session?: AgentRecord["session"];
    lifetimeUsage: LifetimeUsage;
    pendingDependents?: AgentRecord["pendingDependents"];
  },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
) {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status,
    agentId: record.id,
    error: record.error,
    outputFile: record.outputFile,
    ...(record.pendingDependents && { pendingDependents: record.pendingDependents }),
    ...overrides,
  };
}

export function buildRecordDetails(record: AgentRecord, background = false, resumed = false) {
  const invocation = buildInvocationTags(record.invocation ?? {});
  const base = {
    displayName: getDisplayName(record.type),
    description: record.description,
    subagentType: record.type,
    modelName: invocation.modelName,
    tags: invocation.tags.length > 0 ? invocation.tags : undefined,
  };
  return {
    ...buildDetails(
      base,
      record,
      undefined,
      background
        ? {
            status: "background",
            toolUses: resumed ? record.toolUses : 0,
            tokens: "",
            durationMs: 0,
          }
        : undefined,
    ),
  };
}

const DelegationRenderArguments = hostParams(
  obj({ subagent_type: opt(str()), description: opt(str()), agent_id: opt(str()) }, { open: true }),
);
type DelegationRenderers = Required<
  Pick<
    ToolDefinition<typeof DelegationRenderArguments, unknown, unknown>,
    "renderCall" | "renderResult"
  >
>;

export const delegationRenderers: DelegationRenderers = {
  renderCall(args, theme, context) {
    const rowBackground = hasAgentBadge(args.subagent_type ?? "Agent")
      ? theme.getBgAnsi(
          context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg",
        )
      : "";
    const desc = args.description ?? "";
    const name = renderAgentName(args.subagent_type ?? "Agent", theme, {
      fallbackColor: "toolTitle",
      restoreBackground: rowBackground,
      bold: true,
    });
    return new Text(
      rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""),
      0,
      0,
    );
  },

  renderResult(result, { expanded, isPartial }, theme, renderContext) {
    const details = isAgentDetails(result.details) ? result.details : undefined;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    if (renderContext.isError || !details?.status) {
      return new Text(text, 0, 0);
    }

    const stats = (d: AgentDetails) => {
      const parts: string[] = [];
      if (d.modelName) parts.push(d.modelName);
      if (d.tags) parts.push(...d.tags);
      if (d.turnCount != null && d.turnCount > 0) {
        parts.push(formatTurns(d.turnCount, d.maxTurns));
      }
      if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
      if (d.tokens) parts.push(d.tokens);
      return parts
        .map((p) => fgPreservingNestedStyles(theme, "dim", p))
        .join(" " + theme.fg("dim", "·") + " ");
    };

    if (isPartial) {
      const frame = SPINNER[details.spinnerFrame ?? 0];
      const s = stats(details);
      return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
    }

    if (details.status === "running" || details.status === "queued") {
      const s = stats(details);
      const output = expanded ? text : text.split("\n")[0];
      return new Text((s ? s + "\n" : "") + theme.fg("dim", output), 0, 0);
    }

    if (details.status === "background") {
      return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
    }

    if (details.status === "completed" || details.status === "steered") {
      const duration = formatMs(details.durationMs);
      const isSteered = details.status === "steered";
      const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
      const s = stats(details);
      let line = icon + (s ? " " + s : "");
      line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

      const rest: string[] = [];
      if (expanded) {
        const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
        if (resultText) {
          const lines = resultText.split("\n").slice(0, 50);
          for (const l of lines) {
            rest.push(theme.fg("dim", `  ${l}`));
          }
          if (resultText.split("\n").length > 50) {
            rest.push(
              theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)"),
            );
          }
        }
      } else {
        const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
        rest.push(theme.fg("dim", `  ⎿  ${doneText}`));
      }
      const verdictView = viewReplyVerdict(text);
      if (verdictView !== undefined) {
        return completedVerdictCard(verdictView, line, rest.join("\n"), expanded, theme);
      }
      for (const l of rest) line += "\n" + l;
      return new Text(line, 0, 0);
    }

    if (details.status === "stopped") {
      const s = stats(details);
      let line = theme.fg("dim", "■") + (s ? " " + s : "");
      line += "\n" + theme.fg("dim", "  ⎿  Stopped");
      return new Text(line, 0, 0);
    }

    if (details.status === "budget_exceeded" || details.status === "watchdog_stopped") {
      const s = stats(details);
      let line = theme.fg("warning", "■") + (s ? " " + s : "");
      line +=
        "\n" +
        theme.fg(
          "warning",
          `  ⎿  ${details.status === "budget_exceeded" ? "Budget exceeded" : "Idle watchdog stopped"}: ${details.error ?? "unknown"}`,
        );
      return new Text(line, 0, 0);
    }

    if (details.status !== "error" && details.status !== "aborted") {
      return new Text(text, 0, 0);
    }

    const s = stats(details);
    let line = theme.fg("error", "✗") + (s ? " " + s : "");

    if (details.status === "error") {
      line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
    } else {
      line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
    }

    return new Text(line, 0, 0);
  },
};

const CONVERSATION_MARKER = "\n\n--- Agent Conversation ---\n";
const RECORD_STATUS = /^Verdict record: (parsed|MISSING|INVALID|FAILED)\b/;
const CARD_MAX_ENTRIES = 10;
const NOTIFICATION_MAX_ENTRIES = 6;
const NOTIFICATION_INDENT = "      ";

export interface ReplyVerdictView {
  analysis: VerdictTextAnalysis;
  record?: { line: string; status: string };
  withoutBlocks?: string;
}

export function viewReplyVerdict(text: string): ReplyVerdictView | undefined {
  const markerAt = text.indexOf(CONVERSATION_MARKER);
  const lines = (markerAt === -1 ? text : text.slice(0, markerAt)).split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last -= 1;
  let record: ReplyVerdictView["record"];
  let replyLines = lines;
  const lastLine = last >= 0 ? lines[last].trim() : "";
  if (lastLine.startsWith(VERDICT_RECORD_PREFIX)) {
    record = {
      line: sanitizeTerminalText(lastLine),
      status: RECORD_STATUS.exec(lastLine)?.[1] ?? "unknown",
    };
    replyLines = lines.slice(0, last);
  }
  const reply = replyLines.join("\n");
  const analysis = analyzeVerdictText(reply);
  if (record === undefined && (analysis.state === "absent" || analysis.state === "unterminated")) {
    return undefined;
  }
  const view: ReplyVerdictView = { analysis };
  if (record !== undefined) view.record = record;
  if (analysis.state === "parsed") {
    const kept = messageLines(reply).filter(
      (_line, index) =>
        !analysis.blocks.some((block) => index >= block.startLine && index <= block.endLine),
    );
    if (record !== undefined) kept.push("", record.line);
    view.withoutBlocks = kept.join("\n");
  }
  return view;
}

export function replyVerdictLines(
  view: ReplyVerdictView,
  width: number,
  options: { maxEntries?: number; noticesOnly?: boolean } = {},
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const record = view.record;
  const recordFailed = record !== undefined && record.status !== "parsed";
  if (recordFailed) {
    for (const text of wrapText(record.line, width, "  ")) {
      lines.push({ text, tone: "error", role: "notice" });
    }
  }
  const { analysis } = view;
  if (analysis.state === "invalid") {
    for (const notice of analysis.notices) {
      const reason =
        record?.status === "INVALID"
          ? "the verdict record above gives the parser's reason"
          : notice.reason;
      lines.push(...layoutNotice({ info: notice.info, reason }, width));
    }
  } else if (analysis.state === "parsed") {
    if (recordFailed) {
      for (const block of analysis.blocks) {
        lines.push(
          ...layoutNotice(
            {
              info: block.summary.info,
              reason:
                "the verdict record says " +
                record.status +
                ", so the block is not shown as recorded",
            },
            width,
          ),
        );
      }
    } else if (!options.noticesOnly) {
      for (const block of analysis.blocks) {
        lines.push(...layoutSummary(block.summary, width, { maxEntries: options.maxEntries }));
      }
      if (record === undefined) {
        lines.push(
          ...wrapText("No verdict record for this reply.", width, "  ").map(
            (text): SummaryLine => ({ text, tone: "muted", role: "footer" }),
          ),
        );
      }
    }
  }
  return lines;
}

const TONE_COLORS = {
  error: "error",
  warning: "warning",
  success: "success",
  muted: "dim",
  normal: "toolOutput",
} satisfies Record<SummaryTone, string>;

function styleLine(line: SummaryLine, theme: Theme): string {
  const colored = theme.fg(TONE_COLORS[line.tone], line.text);
  return line.role === "headline" || line.role === "notice" ? theme.bold(colored) : colored;
}

class WidthLines implements Component {
  private readonly build: (width: number) => readonly string[];
  private cache: { width: number; lines: readonly string[] } | undefined;

  constructor(build: (width: number) => readonly string[]) {
    this.build = build;
  }

  render(width: number): readonly string[] {
    if (this.cache?.width !== width) this.cache = { width, lines: this.build(width) };
    return this.cache.lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

function indentedLines(
  view: ReplyVerdictView,
  indent: string,
  theme: Theme,
  options: { maxEntries?: number; noticesOnly?: boolean },
): WidthLines {
  return new WidthLines((width) =>
    replyVerdictLines(view, Math.max(1, width - indent.length), options).map(
      (line) => indent + styleLine(line, theme),
    ),
  );
}

function completedVerdictCard(
  view: ReplyVerdictView,
  head: string,
  rest: string,
  expanded: boolean,
  theme: Theme,
): Container {
  const container = new Container();
  container.addChild(new Text(head, 0, 0));
  if (expanded) {
    container.addChild(indentedLines(view, "  ", theme, { noticesOnly: true }));
    if (rest !== "") container.addChild(new Text(rest, 0, 0));
  } else {
    if (rest !== "") container.addChild(new Text(rest, 0, 0));
    container.addChild(indentedLines(view, "    ", theme, { maxEntries: CARD_MAX_ENTRIES }));
  }
  return container;
}

export const NOTIFICATION_REPLY_MAX_BYTES = 64 * 1024;

export function notificationVerdictReply(
  result: string | undefined,
  preview: string,
): string | undefined {
  if (result === undefined || result === preview) return undefined;
  if (Buffer.byteLength(result, "utf8") > NOTIFICATION_REPLY_MAX_BYTES) return undefined;
  return viewReplyVerdict(result) === undefined ? undefined : result;
}

export const KeptReplySchema = obj({ verdictReply: str() }, { open: true });
const hasKeptReply = compile(KeptReplySchema).check;

function notificationReply(item: NotificationDetails): string {
  const preview = item.resultPreview;
  if (!hasKeptReply(item)) return preview;
  const kept = item.verdictReply;
  const stem = preview.endsWith("…") ? preview.slice(0, -1) : preview;
  return kept.startsWith(stem) ? kept : preview;
}

export function renderVerdictNotification(
  details: NotificationDetails,
  expanded: boolean,
  theme: PiTheme,
): Component | undefined {
  const items = [details, ...(details.others ?? [])];
  const views = items.map((item) => viewReplyVerdict(notificationReply(item)));
  if (views.every((view) => view === undefined)) return undefined;
  return new WidthLines((width) => {
    const rendered = items.map((item, index) => {
      const view = views[index];
      const single: NotificationDetails = {
        ...item,
        others: [],
        resultPreview:
          view?.withoutBlocks !== undefined && !expanded ? view.withoutBlocks : item.resultPreview,
      };
      const text = renderSubagentNotification(single, { expanded }, theme);
      if (view === undefined) return text;
      const lines = text.split("\n");
      const band = lines.pop() ?? "";
      const summary = replyVerdictLines(view, Math.max(1, width - NOTIFICATION_INDENT.length), {
        maxEntries: NOTIFICATION_MAX_ENTRIES,
        noticesOnly: expanded,
      }).map((line) => band + NOTIFICATION_INDENT + styleLine(line, theme));
      return [...lines, ...summary, band].join("\n");
    });
    return new Text(rendered.join("\n"), 0, 0).render(width);
  });
}
