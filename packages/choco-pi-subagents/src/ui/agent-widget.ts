import { renderAgentName, renderAgentNameLabel, type AgentNameStyle } from "../agent-color.ts";
import { getConfig } from "../agent-types.ts";
import type { AgentInvocation, AgentRecord, SubagentType } from "../types.ts";
import { type LifetimeUsage, type SessionLike } from "../usage.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const ERROR_STATUSES = new Set([
  "error",
  "aborted",
  "steered",
  "stopped",
  "budget_exceeded",
  "watchdog_stopped",
]);

const TOOL_DISPLAY = new Map(
  Object.entries({
    read: "reading",
    bash: "running command",
    edit: "editing",
    write: "writing",
    grep: "searching",
    find: "finding files",
    ls: "listing",
  }),
);

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

export interface AgentTreeLabelStyle {
  topLevel?: AgentNameStyle;
}

export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  turnCount: number;
  maxTurns?: number;
  lifetimeUsage: LifetimeUsage;
}

export interface InvocationTags {
  modelName?: string;
  tags: string[];
}

export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status:
    | "queued"
    | "running"
    | "completed"
    | "steered"
    | "aborted"
    | "stopped"
    | "budget_exceeded"
    | "watchdog_stopped"
    | "error"
    | "waiting_for_reset"
    | "interrupted"
    | "background";
  activity?: string;
  spinnerFrame?: number;
  modelName?: string;
  tags?: string[];
  turnCount?: number;
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

const ANSI_FULL_RESET = "\u001b[0m";
const ANSI_FOREGROUND_RESET = "\u001b[39m";

function removeForegroundResets(text: string): string {
  return text.replaceAll(ANSI_FULL_RESET, "").replaceAll(ANSI_FOREGROUND_RESET, "");
}

function restoreForegroundAfterResets(text: string, styleStart: string): string {
  return text
    .replaceAll(ANSI_FULL_RESET, `${ANSI_FULL_RESET}${styleStart}`)
    .replaceAll(ANSI_FOREGROUND_RESET, `${ANSI_FOREGROUND_RESET}${styleStart}`);
}

export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styleStart = removeForegroundResets(theme.fg(color, ""));
  return theme.fg(color, restoreForegroundAfterResets(text, styleStart));
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

export function formatRowTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

function formatAnnotatedTokens(
  tokenStr: string,
  percent: number | null,
  theme: Theme,
  compactions: number,
): string {
  const annot: string[] = [];
  if (percent !== null) {
    let color = "dim";
    if (percent >= 85) color = "error";
    else if (percent >= 70) color = "warning";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  return formatAnnotatedTokens(formatTokens(tokens), percent, theme, compactions);
}

export function formatRowSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  return formatAnnotatedTokens(formatRowTokens(tokens), percent, theme, compactions);
}

export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

export function renderAgentTreeLabel(
  agent: Pick<AgentRecord, "type" | "handle" | "alias">,
  depth: number,
  theme: Theme,
  style: AgentTreeLabelStyle = {},
): string {
  void depth;
  if (!agent.alias) return renderAgentName(agent.type, theme, style.topLevel);
  return renderAgentNameLabel(`@${agent.alias}`, getConfig(agent.type).color, theme, {
    ...style.topLevel,
    bold: true,
  });
}

export function buildInvocationTags(invocation: AgentInvocation | undefined): InvocationTags {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.fastMode) tags.push("fast");
  if (invocation.daybreak) tags.push("daybreak");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  if (invocation.timeoutMs != null) tags.push(`timeout: ${invocation.timeoutMs}ms`);
  if (invocation.maxToolCalls != null) tags.push(`max tools: ${invocation.maxToolCalls}`);
  if (invocation.maxTokens != null) tags.push(`max tokens: ${invocation.maxTokens}`);
  if (invocation.idleTimeoutMs != null) tags.push(`idle: ${invocation.idleTimeoutMs}ms`);
  return { modelName: invocation.modelName, tags };
}

function truncateLine(text: string, len = 60): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY.get(toolName) ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}
