import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonRecord, isNumber, isString, type RuntimeValue } from "./runtime-values.ts";

/**
 * Session accounting for the `/status` Session Info block.
 *
 * Pi's own `/session` command computes these numbers inside interactive mode,
 * where no extension can reach them, so the arithmetic is reproduced here from
 * the session entries every extension already receives. Two additions matter:
 * the totals cover every sub-agent this session spawned, and the main agent's
 * share stays visible next to theirs instead of merging into one figure.
 */

/** The five numbers every usage record carries, summed over a set of messages. */
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

/** Cost and token volume attributed to one `provider/model` key. */
export type CostEntry = { key: string; cost: number; tokens: number };

export type MessageCounts = {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
};

/** Prompt tokens re-billed because a cache read was expected but did not happen. */
export type CacheWaste = { missedTokens: number; missedCost: number; missCount: number };

/** What one model charges per million tokens for a cache read. */
export type CachePriceSource = {
  find(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
};

export type MainUsage = {
  counts: MessageCounts;
  totals: UsageTotals;
  breakdown: CostEntry[];
};

export type SubagentUsage = {
  /** Agents with a readable transcript; each contributed at least one message. */
  agents: number;
  totals: UsageTotals;
  breakdown: CostEntry[];
  /** Transcript directories the numbers were read from. Empty means nothing was found. */
  directories: string[];
};

/** The minimum a usage record must carry to be counted. */
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

/** Bucket key for usage that no assistant message accounts for. */
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

/**
 * Message counts, token totals, and per-model cost for the current session
 * branch. Usage that belongs to no assistant message — tool executions,
 * compaction and branch summaries — is grouped separately so the breakdown
 * still reconciles with the total.
 */
export function summarizeMainUsage(entries: readonly SessionEntry[]): MainUsage {
  const counts: MessageCounts = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0 };
  const totals = createUsageTotals();
  const byKey = new Map<string, UsageTotals>();

  for (const entry of entries) {
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

  return { counts, totals, breakdown: toBreakdown(byKey) };
}

/** Per-turn misses at or below this are cache breakpoint granularity, not waste. */
const CACHE_NOISE_FLOOR_TOKENS = 1024;

type PreviousRequest = { promptTokens: number; reportedCache: boolean };

/**
 * Prompt tokens that were already in the previous turn's prompt but were billed
 * again instead of read from cache, and the extra dollars that cost.
 *
 * Compaction and branch summaries reset the comparison: the next prompt is new
 * content, not re-billed content. A model switch is not exempt, because it does
 * re-bill the whole prompt.
 */
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
    // A zero-cache turn only counts once caching was reported at least once:
    // on a provider that never caches it means nothing.
    if (previous && promptTokens > 0 && (cacheActivity > 0 || previous.reportedCache)) {
      const missed = Math.min(previous.promptTokens, promptTokens) - usage.cacheRead;
      if (missed > CACHE_NOISE_FLOOR_TOKENS) {
        // The missed tokens landed in the input or cacheWrite buckets, so this
        // message's own cost breakdown gives the rate that was actually paid.
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

/** Read a usage record out of parsed transcript JSON, or reject it. */
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

/** The `provider/model` key an assistant transcript line was billed under. */
function transcriptModelKey(message: RuntimeValue): string {
  if (!isJsonRecord(message)) return OTHER_USAGE_KEY;
  const provider = message["provider"];
  const responseModel = message["responseModel"];
  const model = isString(responseModel) ? responseModel : message["model"];
  if (!isString(provider) || !isString(model)) return OTHER_USAGE_KEY;
  return `${provider}/${model}`;
}

/**
 * Sub-agent transcript directories for one root session.
 *
 * choco-pi-subagents writes every agent's turns to
 * `<tmp>/choco-pi-subagents-<uid>/<encoded-cwd>/<rootSessionId>/tasks/<agentId>.output`.
 * Nested agents inherit the root session id, so they file alongside their
 * ancestors. The encoded cwd is not always the orchestrator's own — a nested
 * spawn encodes its config root, which differs inside a worktree — so every
 * encoded-cwd directory is checked for this session id rather than just one.
 */
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

/** Transcript files by agent id; the largest wins if an id somehow appears twice. */
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

/**
 * Token and cost totals for every sub-agent spawned under one root session,
 * reconstructed from the transcripts those agents streamed to disk.
 *
 * Reconstructed rather than live: the sub-agent manager publishes no roster,
 * and its in-memory records are evicted minutes after an agent finishes and are
 * gone entirely after a resume. The transcripts outlive all of that and carry
 * each assistant message's own `usage.cost`, which is the same figure the
 * provider billed. They are still only as complete as the writer: an agent that
 * runs with `output_transcript` off leaves no file, a `/btw` side conversation
 * never gets one, and a running agent's current turn is not written until the
 * turn ends.
 */
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
      // Tool-result turns carry the bulk of a transcript and never carry usage.
      // Skipping them before JSON.parse keeps a large session's scan well under
      // the time it takes to paint the tab.
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

/** Pi's compact token scale, matching the footer and `/session`. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(amount: number): string {
  return `$${amount.toFixed(3)}`;
}

/** Theme hooks used by the rendered block; omitted when the surface is plain text. */
export type SessionInfoStyle = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type SessionInfoInput = {
  sessionName: string | undefined;
  sessionFile: string | undefined;
  sessionId: string;
  main: MainUsage;
  cacheWaste: CacheWaste;
  subagents: SubagentUsage;
  /** True when the sub-agent manager reports work still in flight. */
  subagentsRunning: boolean;
};

type Painter = { label: (text: string) => string; head: (text: string) => string };

function painter(style: SessionInfoStyle | undefined): Painter {
  if (!style) return { label: (text) => text, head: (text) => text };
  return { label: (text) => style.fg("muted", text), head: (text) => style.bold(text) };
}

function costLines(input: SessionInfoInput, paint: Painter, indent: string): string[] {
  return input.main.breakdown.map(
    (entry) =>
      `${indent}${paint.label(`${entry.key}:`)} ${formatCost(entry.cost)} ${paint.label(
        `(${formatTokens(entry.tokens)} tokens)`,
      )}`,
  );
}

/**
 * The Session Info block: identity, message counts, token split, and cost.
 *
 * The cost section splits into the main agent and its sub-agents whenever any
 * sub-agent usage was found, so neither figure hides inside the other. With no
 * sub-agents it collapses to the per-model breakdown alone.
 */
export function formatSessionInfo(input: SessionInfoInput, style?: SessionInfoStyle): string {
  const paint = painter(style);
  const lines: string[] = [paint.head("Session Info"), ""];

  if (input.sessionName) lines.push(`${paint.label("Name:")} ${input.sessionName}`);
  lines.push(`${paint.label("File:")} ${input.sessionFile ?? "In-memory"}`);
  lines.push(`${paint.label("ID:")} ${input.sessionId}`, "");

  const counts = input.main.counts;
  lines.push(
    paint.head("Messages"),
    `${paint.label("Total:")} ${counts.total}`,
    `${paint.label("User:")} ${counts.user}`,
    `${paint.label("Assistant:")} ${counts.assistant}`,
    `${paint.label("Tools:")} ${counts.toolCalls} calls, ${counts.toolResults} results`,
    "",
  );

  // "Input" is the whole prompt volume. The cached/uncached split is the only
  // provider-independent way to break it down; cache writes are a detail of the
  // uncached part.
  const totals = input.main.totals;
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  lines.push(paint.head("Tokens"), `${paint.label("Input:")} ${promptTokens.toLocaleString()}`);
  if (promptTokens > 0 && totals.cacheRead + totals.cacheWrite > 0) {
    const hitRate = ((totals.cacheRead / promptTokens) * 100).toFixed(1);
    lines.push(
      `  ${paint.label("Cached:")} ${totals.cacheRead.toLocaleString()} ${paint.label(`(${hitRate}%)`)}`,
    );
    const written =
      totals.cacheWrite > 0
        ? ` ${paint.label(`(${totals.cacheWrite.toLocaleString()} written to cache)`)}`
        : "";
    lines.push(
      `  ${paint.label("Uncached:")} ${(totals.input + totals.cacheWrite).toLocaleString()}${written}`,
    );
  }
  lines.push(
    `${paint.label("Output:")} ${totals.output.toLocaleString()}`,
    `${paint.label("Total:")} ${(promptTokens + totals.output).toLocaleString()}`,
  );

  const sub = input.subagents;
  const hasSubagents = sub.agents > 0 || sub.totals.cost > 0;
  const waste = input.cacheWaste;
  if (totals.cost > 0 || hasSubagents || waste.missedTokens > 0) {
    lines.push("", paint.head("Cost"));
    lines.push(`${paint.label("Total:")} ${formatCost(totals.cost + sub.totals.cost)}`);
    if (hasSubagents) {
      lines.push(`  ${paint.label("Main agent:")} ${formatCost(totals.cost)}`);
      lines.push(...costLines(input, paint, "    "));
      const agentLabel = sub.agents === 1 ? "1 agent" : `${sub.agents} agents`;
      lines.push(
        `  ${paint.label("Sub-agents:")} ${formatCost(sub.totals.cost)} ${paint.label(
          `(${agentLabel}, ${formatTokens(totalTokens(sub.totals))} tokens)`,
        )}`,
      );
      for (const entry of sub.breakdown) {
        lines.push(
          `    ${paint.label(`${entry.key}:`)} ${formatCost(entry.cost)} ${paint.label(
            `(${formatTokens(entry.tokens)} tokens)`,
          )}`,
        );
      }
    } else if (input.main.breakdown.length > 1) {
      lines.push(...costLines(input, paint, "  "));
    }
    if (waste.missedTokens > 0) {
      const missLabel = waste.missCount === 1 ? "1 miss" : `${waste.missCount} misses`;
      const detail = `${waste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
      lines.push(
        waste.missedCost >= 0.0001
          ? `${paint.label("Cache Re-billed:")} ${formatCost(waste.missedCost)} ${paint.label(`(${detail})`)}`
          : `${paint.label("Cache Re-billed:")} ${detail}`,
      );
    }
  }

  const notes = subagentNotes(input);
  if (notes.length > 0) lines.push("", ...notes.map((note) => paint.label(note)));

  return lines.join("\n");
}

/**
 * What the sub-agent figure does not cover. Stated inline because the number is
 * reconstructed from transcripts, and a reader comparing it against a provider
 * invoice needs to know which runs were never written down.
 */
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
