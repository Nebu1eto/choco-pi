import { isObject, isString, type RuntimeValue } from "./lib/runtime-values.ts";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

type ModelRecord = { baseUrl?: unknown; name?: unknown };

export type StatusRow = { label: string; value: string };

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function displayPath(candidate: string, cwd: string): string {
  if (within(candidate, cwd)) return path.relative(cwd, candidate);
  const absolute = path.resolve(candidate);
  const home = homedir();
  if (absolute === home) return "~";
  if (within(absolute, home)) return `~/${path.relative(home, absolute)}`;
  return absolute;
}

export function describePath(filePath: string, cwd: string): string {
  try {
    if (!existsSync(filePath)) return `${displayPath(filePath, cwd)} (missing)`;
    const resolved = realpathSync(filePath);
    if (resolved !== filePath)
      return `${displayPath(filePath, cwd)} -> ${displayPath(resolved, cwd)}`;
    return displayPath(filePath, cwd);
  } catch {
    return displayPath(filePath, cwd);
  }
}

function readJsonFile(filePath: string): RuntimeValue | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function mcpEnabled(cwd: string): Set<string> {
  const agent = readJsonFile(path.join(agentDir(), "mcp.json"));
  const agentServers = isRecord(agent) && isRecord(agent.mcpServers) ? agent.mcpServers : {};
  const project = readJsonFile(path.join(cwd, ".pi", "mcp.json"));
  const projectServers =
    isRecord(project) && isRecord(project.mcpServers) ? project.mcpServers : {};
  const merged = { ...agentServers, ...projectServers };
  return new Set(
    Object.entries(merged).flatMap(([name, definition]) =>
      isRecord(definition) && definition.disabled === true ? [] : [name],
    ),
  );
}

type McpState = { count: number; missing: string[]; cached: boolean };

function mcpLabel(mcp: McpState): string {
  if (mcp.count === 0) return "none configured";
  const cached = `${mcp.count} configured, ${mcp.count - mcp.missing.length} cached`;
  const awaiting = mcp.missing.length === 0 ? "" : `, awaiting: ${mcp.missing.join(", ")}`;
  const uninitialized = mcp.cached ? "" : " (adapter cache not initialized; see /mcp)";
  return `${cached}${awaiting}${uninitialized}`;
}

function mcpState(cwd: string): McpState {
  const names = mcpEnabled(cwd);
  if (names.size === 0) return { count: 0, missing: [], cached: true };
  const cache = readJsonFile(path.join(agentDir(), "mcp-cache.json"));
  if (!isRecord(cache) || !isRecord(cache.servers)) {
    return { count: names.size, missing: [...names], cached: false };
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const cachedServers = cache.servers as Record<string, RuntimeValue>;
  const missing = [...names].filter((name) => cachedServers[name] === undefined);
  return { count: names.size, missing, cached: true };
}

function sessionStartedAt(ctx: {
  sessionManager: { getHeader(): RuntimeValue };
}): string | undefined {
  const header: unknown = ctx.sessionManager.getHeader();
  if (!isRecord(header) || !isString(header.timestamp)) return undefined;
  const date = new Date(header.timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

export function lookupModelRecord(
  ctx: Pick<ExtensionCommandContext, "cwd">,
  provider: string | undefined,
  modelId: string | undefined,
): ModelRecord | undefined {
  if (!provider || !modelId) return undefined;
  for (const root of [agentDir(), path.join(ctx.cwd, ".pi")]) {
    const raw = readJsonFile(path.join(root, "models-store.json"));
    if (!isRecord(raw)) continue;
    const entry = raw[provider];
    if (!isRecord(entry) || !Array.isArray(entry.models)) continue;
    const record = entry.models.find(
      (candidate) => isRecord(candidate) && candidate.id === modelId,
    );
    if (isRecord(record)) return record;
  }
  return undefined;
}

function modelDisplay(
  id: string | undefined,
  recordName: string | undefined,
  modelName: string | undefined,
): string {
  if (!id) return "No model is currently selected";
  const name = isString(recordName) && recordName.length > 0 ? recordName : modelName;
  return name && name !== id ? `${name} (${id})` : id;
}

function providerDisplay(provider: string, record: ModelRecord | undefined): string {
  if (!record || !isString(record.baseUrl) || record.baseUrl.length === 0) return provider;
  if (isDefaultProviderUrl(provider, record.baseUrl)) return provider;
  return `${provider} - ${record.baseUrl}`;
}

function isDefaultProviderUrl(provider: string, baseUrl: string): boolean {
  if (provider === "openai-codex") {
    return (
      baseUrl === "https://chatgpt.com/backend-api/codex" || baseUrl === "https://api.openai.com"
    );
  }
  if (provider === "openai") return baseUrl === "https://api.openai.com";
  return baseUrl === `https://api.${provider}.com`;
}

function contextWindowLabel(
  modelRegistry: {
    find(provider: string, modelId: string): { contextWindow?: number } | undefined;
  },
  model: { provider?: string; id?: string; contextWindow?: number } | undefined,
): string | undefined {
  if (!model || model.contextWindow === undefined) return undefined;
  const registryModel =
    model.provider && model.id ? modelRegistry.find(model.provider, model.id) : undefined;
  const native = registryModel?.contextWindow;
  if (native !== undefined && model.contextWindow < native) {
    return `${model.contextWindow.toLocaleString()} tokens · soft cap (native ${native.toLocaleString()})`;
  }
  return `${model.contextWindow.toLocaleString()} tokens`;
}

type AgentFrontmatter = { default_model?: string; default_thinking?: string };

export function parseAgentFrontmatter(content: string): AgentFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: AgentFrontmatter = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^(default_model|default_thinking):\s*(.+?)\s*$/);
    if (!pair) continue;
    const value = pair[2].replace(/^["']|["']$/g, "");
    if (value.length === 0) continue;
    if (pair[1] === "default_model") result.default_model = value;
    else result.default_thinking = value;
  }
  return result;
}

export function agentLabels(directory: string): string[] {
  let entries: Array<{ name: string }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"),
    );
  } catch {
    return [];
  }
  const labels: string[] = [];
  const issues: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const name = entry.name.replace(/\.md$/, "");
    try {
      const frontmatter = parseAgentFrontmatter(
        readFileSync(path.join(directory, entry.name), "utf8"),
      );
      const details: string[] = [];
      if (frontmatter.default_model) details.push(frontmatter.default_model);
      if (frontmatter.default_thinking) details.push(frontmatter.default_thinking);
      labels.push(details.length === 0 ? name : `${name} (${details.join(", ")})`);
    } catch (error) {
      issues.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (issues.length > 0) labels.push(`unreadable: ${issues.join("; ")}`);
  return labels;
}

function bridgeSummary(cwd: string): string | undefined {
  const directory = path.join(agentDir(), "session-bridge");
  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [path.join(directory, entry.name)] : [],
    );
  } catch {
    return undefined;
  }
  if (sessionDirs.length === 0) return undefined;
  const alive = sessionDirs.filter((sessionDir) => {
    const state = readJsonFile(path.join(sessionDir, "state.json"));
    return isRecord(state) && state.alive === true;
  });
  if (alive.length === 0) return `${sessionDirs.length} bridge entries, none alive`;
  return `${alive.length} live session${alive.length === 1 ? "" : "s"} of ${sessionDirs.length} bridge entries · ${displayPath(directory, cwd)}`;
}

function themeLabel(cwd: string): string {
  const agent = readJsonFile(path.join(agentDir(), "settings.json"));
  if (isRecord(agent) && isString(agent.theme)) return agent.theme;
  const project = readJsonFile(path.join(cwd, ".pi", "settings.json"));
  return isRecord(project) && isString(project.theme) ? project.theme : "default";
}

function corePackageLabel(): string | undefined {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(
      extensionDir,
      "..",
      "..",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    ),
    path.join(
      extensionDir,
      "..",
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    ),
    path.join(
      agentDir(),
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    ),
  ];
  for (const candidate of candidates) {
    const raw = readJsonFile(candidate);
    if (isRecord(raw) && isString(raw.version)) return `pi-coding-agent ${raw.version}`;
  }
  return undefined;
}

export function summarizeStatusRows(
  ctx: Pick<
    ExtensionCommandContext,
    | "cwd"
    | "model"
    | "sessionManager"
    | "getContextUsage"
    | "modelRegistry"
    | "getSystemPromptOptions"
  >,
  thinkingLevel: string,
): StatusRow[] {
  const cwd = ctx.cwd;
  const rows: StatusRow[] = [];

  rows.push({ label: "Pi version", value: VERSION });
  rows.push({ label: "Session name", value: ctx.sessionManager.getSessionName() ?? "(unnamed)" });
  rows.push({ label: "Session ID", value: ctx.sessionManager.getSessionId() });
  const startedAt = sessionStartedAt(ctx);
  if (startedAt) rows.push({ label: "Session started", value: startedAt });
  const sessionFile = ctx.sessionManager.getSessionFile();
  rows.push({
    label: "Session file",
    value: sessionFile ? describePath(sessionFile, cwd) : "(no persisted record yet)",
  });

  rows.push({ label: "cwd", value: displayPath(cwd, cwd) });

  const model = ctx.model;
  const record = lookupModelRecord(ctx, model?.provider, model?.id);
  rows.push({
    label: "Model",
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    value: modelDisplay(model?.id, record?.name as string | undefined, model?.name),
  });
  if (model) {
    rows.push({ label: "Model provider", value: providerDisplay(model.provider, record) });
    const windowLabel = contextWindowLabel(ctx.modelRegistry, model);
    if (windowLabel) rows.push({ label: "Context window", value: windowLabel });
    const usage = ctx.getContextUsage();
    if (usage?.percent != null) {
      const tokens = usage.tokens == null ? "unknown" : usage.tokens.toLocaleString();
      rows.push({
        label: "Context usage",
        value: `${usage.percent.toFixed(1)}% (${tokens} tokens) · details in /context`,
      });
    }
  }
  rows.push({ label: "Reasoning effort", value: thinkingLevel });

  const contextFiles = ctx.getSystemPromptOptions().contextFiles ?? [];
  rows.push({
    label: "Context files",
    value:
      contextFiles.length === 0
        ? "none"
        : contextFiles.map((file) => describePath(file.path, cwd)).join(" | "),
  });

  const skills = (ctx.getSystemPromptOptions().skills ?? []).map((skill) => skill.name);
  const skillValue =
    skills.length === 0 ? "none loaded" : `${skills.length} loaded\n  ${skills.join(", ")}`;
  rows.push({ label: "Skills", value: skillValue });

  const agents = agentLabels(path.join(agentDir(), "agents"));
  rows.push({
    label: "Agent roles",
    value:
      agents.length === 0 ? "none defined" : `${agents.length} defined\n  ${agents.join("\n  ")}`,
  });

  const bridge = bridgeSummary(cwd);
  if (bridge) rows.push({ label: "Live Pi sessions", value: bridge });

  const mcp = mcpState(cwd);
  rows.push({
    label: "MCP servers",
    value: mcpLabel(mcp),
  });

  rows.push({ label: "Theme", value: themeLabel(cwd) });
  const core = corePackageLabel();
  if (core)
    rows.push({ label: "Packages", value: `${configuredPackageCount(cwd)} configured · ${core}` });

  return rows;
}

function configuredPackageCount(cwd: string): number {
  const names = new Set<string>();
  for (const settingsPath of [
    path.join(agentDir(), "settings.json"),
    path.join(cwd, ".pi", "settings.json"),
  ]) {
    const raw = readJsonFile(settingsPath);
    if (!isRecord(raw) || !Array.isArray(raw.packages)) continue;
    for (const entry of raw.packages) {
      if (isString(entry)) names.add(normalizePackageKey(entry));
    }
  }
  return names.size;
}

export function normalizePackageKey(specifier: string): string {
  const raw = specifier.trim().replace(/^npm:/, "");
  if (raw.startsWith(".") || raw.startsWith("/")) return raw;
  const scope = raw.startsWith("@") ? raw.slice(0, raw.indexOf("/") + 1) : "";
  const rest = raw.slice(scope.length);
  return scope + (rest.split("@")[0] ?? rest);
}

export type StatusStyle = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type StatusPainter = {
  label: (text: string) => string;
  value: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  good: (text: string) => string;
  warn: (text: string) => string;
  bad: (text: string) => string;
  head: (text: string) => string;
};

function statusPainter(style: StatusStyle | undefined): StatusPainter {
  const plain = (text: string): string => text;
  if (!style) {
    return {
      label: plain,
      value: plain,
      dim: plain,
      accent: plain,
      good: plain,
      warn: plain,
      bad: plain,
      head: plain,
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
    accent: (text) => color("accent", text),
    good: (text) => color("success", text),
    warn: (text) => color("warning", text),
    bad: (text) => color("error", text),
    head: (text) => style.bold(color("accent", text)),
  };
}

function contextUsageValue(value: string, paint: StatusPainter): string {
  const match = value.match(/^(\d+(?:\.\d+)?)%(.*)$/);
  if (!match) return paint.value(value);
  const percentage = Number(match[1]);
  const color = percentage < 60 ? paint.good : percentage <= 85 ? paint.warn : paint.bad;
  return `${color(`${match[1]}%`)}${paint.value(match[2])}`;
}

function mcpValue(value: string, paint: StatusPainter): string {
  const awaiting = value.indexOf(", awaiting: ");
  if (awaiting === -1) return paint.value(value);
  const suffix = value.indexOf(" (adapter cache not initialized; see /mcp)", awaiting);
  if (suffix === -1)
    return `${paint.value(value.slice(0, awaiting))}${paint.warn(value.slice(awaiting))}`;
  return `${paint.value(value.slice(0, awaiting))}${paint.warn(
    value.slice(awaiting, suffix),
  )}${paint.dim(value.slice(suffix))}`;
}

function statusValue(row: StatusRow, value: string, paint: StatusPainter): string {
  if (row.label === "Model") return paint.accent(value);
  if (row.label === "Context usage") return contextUsageValue(value, paint);
  if (row.label === "MCP servers") return mcpValue(value, paint);
  return paint.value(value);
}

export function statusHeading(style?: StatusStyle): string {
  return statusPainter(style).head("Environment");
}

export function formatStatus(rows: StatusRow[], style?: StatusStyle): string {
  const paint = statusPainter(style);
  const width = rows.reduce((max, row) => Math.max(max, row.label.length + 1), 0);
  return rows
    .flatMap((row) => {
      const [first, ...rest] = row.value.split("\n");
      const label = `${row.label}:`.padEnd(width);
      return [
        `${paint.label(label)} ${statusValue(row, first, paint)}`,
        ...rest.map((value) => paint.dim(value)),
      ];
    })
    .join("\n");
}

// Command registration lives in status-commands.ts; this module only builds
// the Status tab body.
export default function sessionStatus(): void {}
