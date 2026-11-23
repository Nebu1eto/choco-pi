import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describePath } from "../session-status.ts";
import { isJsonRecord, isNumber, isString, type RuntimeValue } from "./runtime-values.ts";
import type { ReportRow } from "./host-bridge/report-schema.ts";

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type CostEntry = { key: string; cost: number; tokens: number };

export type MessageCounts = {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
};

export type CacheWaste = { missedTokens: number; missedCost: number; missCount: number };

export type CachePriceSource = {
  find(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
};

export type MainUsage = {
  counts: MessageCounts;
  totals: UsageTotals;
  breakdown: CostEntry[];
  warming: { count: number; usage: UsageTotals; cost: number };
};

export type SubagentUsage = {
  agents: number;
  totals: UsageTotals;
  breakdown: CostEntry[];
  directories: string[];
};

type UsageRecord = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(totals: UsageTotals, usage: UsageRecord): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

const OTHER_USAGE_KEY = "Tools/summaries";

function accumulate(byKey: Map<string, UsageTotals>, key: string, usage: UsageRecord): void {
  let totals = byKey.get(key);
  if (!totals) {
    totals = createUsageTotals();
    byKey.set(key, totals);
  }
  addUsage(totals, usage);
}

function toBreakdown(byKey: Map<string, UsageTotals>): CostEntry[] {
  return [...byKey]
    .map(([key, totals]) => ({ key, cost: totals.cost, tokens: totalTokens(totals) }))
    .filter((entry) => entry.cost > 0 || entry.tokens > 0)
    .sort((left, right) => right.cost - left.cost);
}

export function summarizeMainUsage(entries: readonly SessionEntry[]): MainUsage {
  const counts: MessageCounts = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0 };
  const totals = createUsageTotals();
  const warmingUsage = createUsageTotals();
  let warmingCount = 0;
  const byKey = new Map<string, UsageTotals>();

  for (const entry of entries) {
    if (entry.type === "usage") {
      if (entry.kind === "cache_warm") {
        warmingCount += 1;
        addUsage(warmingUsage, entry.usage);
      }
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.usage) {
        addUsage(totals, entry.usage);
        accumulate(byKey, OTHER_USAGE_KEY, entry.usage);
      }
      continue;
    }
    if (entry.type !== "message") continue;
    counts.total += 1;
    const message = entry.message;
    if (message.role === "user") {
      counts.user += 1;
      continue;
    }
    if (message.role === "toolResult") {
      counts.toolResults += 1;
      if (message.usage) {
        addUsage(totals, message.usage);
        accumulate(byKey, OTHER_USAGE_KEY, message.usage);
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    counts.assistant += 1;
    if (Array.isArray(message.content)) {
      counts.toolCalls += message.content.filter((part) => part.type === "toolCall").length;
    }
    addUsage(totals, message.usage);
    accumulate(
      byKey,
      `${message.provider}/${message.responseModel ?? message.model}`,
      message.usage,
    );
  }

  return {
    counts,
    totals,
    breakdown: toBreakdown(byKey),
    warming: { count: warmingCount, usage: warmingUsage, cost: warmingUsage.cost },
  };
}

const CACHE_NOISE_FLOOR_TOKENS = 1024;
const CACHE_MISS_MATERIALITY_RATIO = 0.01;

type PreviousRequest = { promptTokens: number; reportedCache: boolean };

export function computeCacheWaste(
  entries: readonly SessionEntry[],
  models: CachePriceSource,
): CacheWaste {
  const waste: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };
  let previous: PreviousRequest | undefined;

  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      previous = undefined;
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    const usage = message.usage;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const cacheActivity = usage.cacheRead + usage.cacheWrite;
    if (previous && promptTokens > 0 && (cacheActivity > 0 || previous.reportedCache)) {
      const reusableTokens = Math.min(previous.promptTokens, promptTokens);
      const missed = reusableTokens - usage.cacheRead;
      const isMaterialMiss =
        missed > CACHE_NOISE_FLOOR_TOKENS && missed / reusableTokens > CACHE_MISS_MATERIALITY_RATIO;
      if (isMaterialMiss) {
        const paidTokens = usage.input + usage.cacheWrite;
        const paidPerToken =
          paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
        const readPerToken =
          usage.cacheRead > 0
            ? usage.cost.cacheRead / usage.cacheRead
            : (models.find(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
        waste.missedTokens += missed;
        waste.missedCost += missed * Math.max(0, paidPerToken - readPerToken);
        waste.missCount += 1;
      }
    }
    if (promptTokens > 0) {
      previous = {
        promptTokens,
        reportedCache: (previous?.reportedCache ?? false) || cacheActivity > 0,
      };
    }
  }

  return waste;
}

function readUsage(value: RuntimeValue): UsageRecord | undefined {
  if (!isJsonRecord(value)) return undefined;
  const cost = value["cost"];
  if (!isJsonRecord(cost)) return undefined;
  const buckets = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const tokens = buckets.map((bucket) => value[bucket]);
  const costs = buckets.map((bucket) => cost[bucket]);
  const total = cost["total"];
  if (!isNumber(total) || !tokens.every(isNumber) || !costs.every(isNumber)) return undefined;
  const [input, output, cacheRead, cacheWrite] = tokens;
  const [costInput, costOutput, costCacheRead, costCacheWrite] = costs;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total,
    },
  };
}

function transcriptModelKey(message: RuntimeValue): string {
  if (!isJsonRecord(message)) return OTHER_USAGE_KEY;
  const provider = message["provider"];
  const responseModel = message["responseModel"];
  const model = isString(responseModel) ? responseModel : message["model"];
  if (!isString(provider) || !isString(model)) return OTHER_USAGE_KEY;
  return `${provider}/${model}`;
}

export function subagentTranscriptDirs(sessionId: string): string[] {
  if (sessionId.length === 0 || sessionId.includes("/") || sessionId.includes("\\")) return [];
  const root = path.join(tmpdir(), `choco-pi-subagents-${process.getuid?.() ?? 0}`);
  let encodedCwds: string[];
  try {
    encodedCwds = readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [entry.name] : [],
    );
  } catch {
    return [];
  }
  return encodedCwds
    .map((name) => path.join(root, name, sessionId, "tasks"))
    .filter((dir) => existsSync(dir));
}

function transcriptFiles(directories: readonly string[]): Map<string, string> {
  const byAgent = new Map<string, { file: string; size: number }>();
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".output")) continue;
      const file = path.join(directory, name);
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const agentId = name.slice(0, -".output".length);
      const previous = byAgent.get(agentId);
      if (!previous || previous.size < size) byAgent.set(agentId, { file, size });
    }
  }
  return new Map([...byAgent].map(([agentId, entry]) => [agentId, entry.file]));
}

export function summarizeSubagentUsage(sessionId: string): SubagentUsage {
  const directories = subagentTranscriptDirs(sessionId);
  const totals = createUsageTotals();
  const byKey = new Map<string, UsageTotals>();
  let agents = 0;

  for (const file of transcriptFiles(directories).values()) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let counted = false;
    for (const line of contents.split("\n")) {
      if (line.length === 0 || !line.includes('"usage"')) continue;
      let parsed: RuntimeValue;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isJsonRecord(parsed)) continue;
      const message = parsed["message"];
      if (!isJsonRecord(message)) continue;
      const usage = readUsage(message["usage"]);
      if (!usage) continue;
      addUsage(totals, usage);
      accumulate(byKey, transcriptModelKey(message), usage);
      counted = true;
    }
    if (counted) agents += 1;
  }

  return { agents, totals, breakdown: toBreakdown(byKey), directories };
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatCompactTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export type SessionInfoStyle = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type SessionInfoInput = {
  sessionName: string | undefined;
  sessionFile: string | undefined;
  cwd?: string;
  sessionId: string;
  main: MainUsage;
  cacheWaste: CacheWaste;
  subagents: SubagentUsage;
  subagentsRunning: boolean;
  cacheWarming: {
    summary: string;
    missCost?: number;
    warmCost?: number;
  };
};

type Painter = {
  label: (text: string) => string;
  value: (text: string) => string;
  dim: (text: string) => string;
  head: (text: string) => string;
  money: (text: string) => string;
  good: (text: string) => string;
  warn: (text: string) => string;
  bad: (text: string) => string;
  accent: (text: string) => string;
};

function painter(style: SessionInfoStyle | undefined): Painter {
  const plain = (text: string): string => text;
  if (!style) {
    return {
      label: plain,
      value: plain,
      dim: plain,
      head: plain,
      money: plain,
      good: plain,
      warn: plain,
      bad: plain,
      accent: plain,
    };
  }
  const color = (name: string, text: string): string => {
    try {
      return style.fg(name, text);
    } catch {
      return text;
    }
  };
  return {
    label: (text) => color("muted", text),
    value: (text) => color("text", text),
    dim: (text) => color("dim", text),
    head: (text) => style.bold(color("accent", text)),
    money: (text) => color("warning", text),
    good: (text) => color("success", text),
    warn: (text) => color("warning", text),
    bad: (text) => color("error", text),
    accent: (text) => color("accent", text),
  };
}

const SESSION_LABEL_WIDTH = 10;

function sessionLabel(label: string, paint: Painter): string {
  return `${paint.label(label.padEnd(SESSION_LABEL_WIDTH))}  `;
}

function modelName(key: string): string {
  if (key === OTHER_USAGE_KEY) return key;
  const separator = key.indexOf("/");
  return separator === -1 ? key : key.slice(separator + 1);
}

function cacheRate(paint: Painter, percentage: number): string {
  const value = `${percentage.toFixed(1)}%`;
  if (percentage >= 90) return paint.good(value);
  if (percentage >= 50) return paint.warn(value);
  return paint.bad(value);
}

function costEntryLine(entry: CostEntry, paint: Painter, prefix: string, indent = ""): string {
  return `${indent}${paint.label(prefix)}  ${paint.accent(modelName(entry.key))}  ${paint.money(
    formatCost(entry.cost),
  )} ${paint.dim(`· ${formatCompactTokens(entry.tokens)} tok`)}`;
}

export function formatSessionInfo(
  input: SessionInfoInput,
  style?: SessionInfoStyle,
  expanded = true,
): string {
  const paint = painter(style);
  const lines: string[] = [paint.head("Session Info"), ""];

  if (input.sessionName)
    lines.push(`${sessionLabel("Name", paint)}${paint.value(input.sessionName)}`);
  const file = input.sessionFile
    ? describePath(input.sessionFile, input.cwd ?? process.cwd())
    : "In-memory";
  lines.push(`${sessionLabel("File", paint)}${paint.value(file)}`);
  lines.push(`${sessionLabel("ID", paint)}${paint.value(input.sessionId)}`, "");

  const counts = input.main.counts;
  lines.push(
    `${sessionLabel("Messages", paint)}${paint.value(counts.total.toString())} ${paint.dim(
      "total · ",
    )}${paint.value(counts.user.toString())} ${paint.dim("user · ")}${paint.value(
      counts.assistant.toString(),
    )} ${paint.dim("assistant · ")}${paint.value(counts.toolCalls.toString())} ${paint.dim(
      "tool calls",
    )}`,
  );

  const totals = input.main.totals;
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  const tokenLine = [
    `${sessionLabel("Tokens", paint)}${paint.value(formatCompactTokens(promptTokens))} ${paint.dim("in")}`,
  ];
  if (promptTokens > 0 && totals.cacheRead + totals.cacheWrite > 0) {
    const hitRate = (totals.cacheRead / promptTokens) * 100;
    tokenLine.push(`${cacheRate(paint, hitRate)} ${paint.dim("cached")}`);
  }
  tokenLine.push(`${paint.value(formatCompactTokens(totals.output))} ${paint.dim("out")}`);
  lines.push(tokenLine.join(paint.dim(" · ")));

  lines.push(`${sessionLabel("Cache warming", paint)}${paint.value(input.cacheWarming.summary)}`);
  if (expanded && input.cacheWarming.missCost !== undefined) {
    lines.push(
      `${sessionLabel("Miss penalty", paint)}${paint.money(`$${input.cacheWarming.missCost.toFixed(3)}`)}`,
      `${sessionLabel("Refresh cost", paint)}${paint.money(`$${input.cacheWarming.warmCost?.toFixed(3) ?? "0.000"}`)}`,
    );
  }
  const warming = input.main.warming;
  if (warming.count > 0) {
    const refreshes = warming.count === 1 ? "1 refresh" : `${warming.count} refreshes`;
    lines.push(
      `${sessionLabel("Warming usage", paint)}${paint.value(refreshes)}, ${paint.money(`$${warming.cost.toFixed(3)}`)}`,
    );
  }

  const sub = input.subagents;
  const hasSubagents = sub.agents > 0 || sub.totals.cost > 0;
  const waste = input.cacheWaste;
  if (totals.cost > 0 || hasSubagents || waste.missedTokens > 0) {
    lines.push(
      "",
      `${sessionLabel("Cost", paint)}${paint.money(formatCost(totals.cost + sub.totals.cost))} ${paint.dim(
        warming.count > 0 ? "total (excl. warming)" : "total",
      )}`,
    );
    if (input.main.breakdown.length > 0) {
      lines.push(...input.main.breakdown.map((entry) => costEntryLine(entry, paint, "main", "  ")));
    } else if (totals.cost > 0) {
      lines.push(
        `  ${paint.label("main")}  ${paint.money(formatCost(totals.cost))} ${paint.dim(
          `· ${formatCompactTokens(totalTokens(totals))} tok`,
        )}`,
      );
    }
    if (hasSubagents) {
      const agentLabel = sub.agents === 1 ? "1 agent" : `${sub.agents} agents`;
      lines.push(
        `  ${paint.label(`sub (${agentLabel}; transcripts)`)}  ${paint.money(
          formatCost(sub.totals.cost),
        )} ${paint.dim(`· ${formatCompactTokens(totalTokens(sub.totals))} tok`)}`,
      );
      lines.push(...sub.breakdown.map((entry) => costEntryLine(entry, paint, "", "    ")));
    }
    if (waste.missedTokens > 0) {
      const missLabel = waste.missCount === 1 ? "1 miss" : `${waste.missCount} misses`;
      const amount = waste.missedCost >= 0.0001 ? `${formatCost(waste.missedCost)} · ` : "";
      lines.push(
        `  ${paint.warn("cache re-billed")}  ${paint.money(amount)}${paint.warn(
          `${formatCompactTokens(waste.missedTokens)} tok · ${missLabel}`,
        )}`,
      );
    }
  }

  const notes = expanded ? subagentNotes(input) : [];
  if (notes.length > 0) lines.push("", ...notes.map((note) => paint.dim(note)));

  return lines.join("\n");
}

function subagentNotes(input: SessionInfoInput): string[] {
  const sub = input.subagents;
  const notes: string[] = [];
  if (sub.agents > 0) {
    notes.push("Sub-agent cost is read from agent transcripts, not from a live meter.");
  } else if (input.subagentsRunning) {
    notes.push("Sub-agents are running; no transcript turns have been written yet.");
  } else if (sub.directories.length > 0) {
    notes.push("Sub-agent transcripts for this session record no usage.");
  }
  if (input.subagentsRunning && sub.agents > 0) {
    notes.push("A running agent's current turn is counted only once that turn ends.");
  }
  return notes;
}

export function sessionInfoRows(input: SessionInfoInput): ReportRow[] {
  const paint = painter(undefined);
  const rows: ReportRow[] = [];
  if (input.sessionName) rows.push({ label: "Name", value: input.sessionName });
  rows.push({
    label: "File",
    value: input.sessionFile
      ? describePath(input.sessionFile, input.cwd ?? process.cwd())
      : "In-memory",
  });
  rows.push({ label: "ID", value: input.sessionId });
  const counts = input.main.counts;
  rows.push({
    label: "Messages",
    value: `${counts.total} total · ${counts.user} user · ${counts.assistant} assistant · ${counts.toolCalls} tool calls`,
  });
  const totals = input.main.totals;
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  const tokenParts = [`${formatCompactTokens(promptTokens)} in`];
  if (promptTokens > 0 && totals.cacheRead + totals.cacheWrite > 0)
    tokenParts.push(`${cacheRate(paint, (totals.cacheRead / promptTokens) * 100)} cached`);
  tokenParts.push(`${formatCompactTokens(totals.output)} out`);
  rows.push({ label: "Tokens", value: tokenParts.join(" · ") });
  rows.push({ label: "Cache warming", value: input.cacheWarming.summary });
  if (input.cacheWarming.missCost !== undefined) {
    rows.push(
      { label: "Miss penalty", value: `$${input.cacheWarming.missCost.toFixed(3)}` },
      {
        label: "Refresh cost",
        value: `$${input.cacheWarming.warmCost?.toFixed(3) ?? "0.000"}`,
      },
    );
  }
  const warming = input.main.warming;
  if (warming.count > 0) {
    const refreshes = warming.count === 1 ? "1 refresh" : `${warming.count} refreshes`;
    rows.push({ label: "Warming usage", value: `${refreshes}, $${warming.cost.toFixed(3)}` });
  }
  const sub = input.subagents;
  const hasSubagents = sub.agents > 0 || sub.totals.cost > 0;
  const waste = input.cacheWaste;
  if (totals.cost > 0 || hasSubagents || waste.missedTokens > 0) {
    const detail: string[] = [];
    if (input.main.breakdown.length > 0) {
      detail.push(...input.main.breakdown.map((entry) => costEntryLine(entry, paint, "main")));
    } else if (totals.cost > 0) {
      detail.push(
        `main  ${formatCost(totals.cost)} · ${formatCompactTokens(totalTokens(totals))} tok`,
      );
    }
    if (hasSubagents) {
      const agentLabel = sub.agents === 1 ? "1 agent" : `${sub.agents} agents`;
      detail.push(
        `sub (${agentLabel}; transcripts)  ${formatCost(sub.totals.cost)} · ${formatCompactTokens(totalTokens(sub.totals))} tok`,
      );
      detail.push(...sub.breakdown.map((entry) => costEntryLine(entry, paint, "", "  ")));
    }
    if (waste.missedTokens > 0) {
      const missLabel = waste.missCount === 1 ? "1 miss" : `${waste.missCount} misses`;
      const amount = waste.missedCost >= 0.0001 ? `${formatCost(waste.missedCost)} · ` : "";
      detail.push(
        `cache re-billed  ${amount}${formatCompactTokens(waste.missedTokens)} tok · ${missLabel}`,
      );
    }
    detail.push(...subagentNotes(input));
    const row: ReportRow = {
      label: "Cost",
      value: `${formatCost(totals.cost + sub.totals.cost)} ${warming.count > 0 ? "total (excl. warming)" : "total"}`,
    };
    if (detail.length > 0) row.hint = detail.join("\n");
    rows.push(row);
  } else {
    const notes = subagentNotes(input);
    if (notes.length > 0) rows.push({ label: "Sub-agents", value: notes.join(" ") });
  }
  return rows;
}
