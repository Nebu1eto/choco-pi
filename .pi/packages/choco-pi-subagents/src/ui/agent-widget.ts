/**
 * agent-widget.ts — Shared agent-row rendering helpers.
 *
 * Formats agent labels, activity, durations, and token usage without UI ownership.
 */

import { renderAgentName, renderAgentNameLabel, type AgentNameStyle } from "../agent-color.ts";
import { getConfig } from "../agent-types.ts";
import type { AgentInvocation, AgentRecord, SubagentType } from "../types.ts";
import { type LifetimeUsage, type SessionLike } from "../usage.ts";

// ---- Constants ----

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set([
  "error",
  "aborted",
  "steered",
  "stopped",
  "budget_exceeded",
  "watchdog_stopped",
]);

/** Tool name → human-readable action for activity descriptions. */
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

// ---- Types ----

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

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Lifetime usage breakdown — see LifetimeUsage docs. */
  lifetimeUsage: LifetimeUsage;
}

/** Metadata attached to Agent tool results for custom rendering. */
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
    | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

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

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styleStart = removeForegroundResets(theme.fg(color, ""));
  return theme.fg(color, restoreForegroundAfterResets(text, styleStart));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/** Format a token count compactly for agent rows, without a redundant unit label. */
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

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  return formatAnnotatedTokens(formatTokens(tokens), percent, theme, compactions);
}

/** Row-only session token stat; completion notifications retain their unit wording. */
export function formatRowSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  return formatAnnotatedTokens(formatRowTokens(tokens), percent, theme, compactions);
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Render an alias in place of the role, using the role's exact row styling. */
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

/** Build the invocation metadata shown by Agent tool results and conversation views. */
export function buildInvocationTags(invocation: AgentInvocation | undefined): InvocationTags {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  if (invocation.timeoutMs != null) tags.push(`timeout: ${invocation.timeoutMs}ms`);
  if (invocation.maxToolCalls != null) tags.push(`max tools: ${invocation.maxToolCalls}`);
  if (invocation.maxTokens != null) tags.push(`max tokens: ${invocation.maxTokens}`);
  if (invocation.idleTimeoutMs != null) tags.push(`idle: ${invocation.idleTimeoutMs}ms`);
  return { modelName: invocation.modelName, tags };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
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

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

// ---- Widget manager ----
