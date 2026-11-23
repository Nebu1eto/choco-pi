import { access } from "node:fs/promises";
import { join, sep } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.ts";

export type AgentFileLocation = "project" | "workspace" | "personal";

export interface AgentFileReference {
  path: string;
  location: AgentFileLocation;
}

interface FrontmatterBlock {
  lines: string[];
  openIdx: number;
  closeIdx: number;
  eol: string;
}

interface EnabledFrontmatter {
  [key: string]: string | number | boolean | null | undefined;
  enabled?: string | number | boolean | null;
}

export interface DisableResult {
  content: string;
  outcome: DisableOutcome;
}

export interface EnableResult {
  content: string;
  changed: boolean;
}

export const projectAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".pi", "agents");
export const workspaceAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".agents", "agents");
export const personalAgentsDir = () => join(getAgentDir(), "agents");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findAgentFile(
  name: string,
  cwd: string = process.cwd(),
): Promise<AgentFileReference | undefined> {
  const projectPath = join(projectAgentsDir(cwd), `${name}.md`);
  if (await pathExists(projectPath)) return { path: projectPath, location: "project" };
  const workspacePath = join(workspaceAgentsDir(cwd), `${name}.md`);
  if (await pathExists(workspacePath)) return { path: workspacePath, location: "workspace" };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (await pathExists(personalPath)) return { path: personalPath, location: "personal" };
  return undefined;
}

export async function locateAgentFile(
  name: string,
  sourcePath: string | undefined,
  cwd: string = process.cwd(),
): Promise<AgentFileReference | undefined> {
  if (sourcePath && (await pathExists(sourcePath))) {
    return { path: sourcePath, location: classifyAgentDir(sourcePath, cwd) };
  }
  return findAgentFile(name, cwd);
}

function classifyAgentDir(path: string, cwd: string): AgentFileLocation {
  if (path.startsWith(projectAgentsDir(cwd) + sep)) return "project";
  if (path.startsWith(workspaceAgentsDir(cwd) + sep)) return "workspace";
  return "personal";
}

export type DisableOutcome = "disabled" | "already-disabled" | "no-frontmatter";

const ENABLED_FALSE = /^enabled:[ \t]*false[ \t]*$/;
const FENCE = /^---[ \t]*$/;

function splitFrontmatter(content: string): FrontmatterBlock | undefined {
  const lines = content.split(/(?<=\n)/);
  if (lines.length === 0 || !FENCE.test(lines[0].replace(/\r?\n$/, ""))) return undefined;
  const closeIdx = lines.findIndex((l, i) => i > 0 && FENCE.test(l.replace(/\r?\n$/, "")));
  if (closeIdx === -1) return undefined;
  return { lines, openIdx: 0, closeIdx, eol: lines[0].endsWith("\r\n") ? "\r\n" : "\n" };
}

export function isDisabledContent(content: string): boolean {
  try {
    return parseFrontmatter<EnabledFrontmatter>(content).frontmatter.enabled === false;
  } catch {
    return false;
  }
}

export function disableInContent(content: string): DisableResult {
  const block = splitFrontmatter(content);
  if (!block) return { content, outcome: "no-frontmatter" };
  if (isDisabledContent(content)) return { content, outcome: "already-disabled" };
  const lines = [...block.lines];
  lines.splice(1, 0, `enabled: false${block.eol}`);
  return { content: lines.join(""), outcome: "disabled" };
}

export function enableInContent(content: string): EnableResult {
  const block = splitFrontmatter(content);
  if (!block) return { content, changed: false };
  const kept = block.lines.filter(
    (l, i) => !(i > 0 && i < block.closeIdx && ENABLED_FALSE.test(l.replace(/\r?\n$/, ""))),
  );
  if (kept.length === block.lines.length) return { content, changed: false };
  return { content: kept.join(""), changed: true };
}

export function isEmptyStub(content: string): boolean {
  return content.replace(/\r\n/g, "\n").trim() === "---\n---";
}

export interface NewAgentInput {
  description: string;
  tools: string;
  model?: string;
  thinking?: string;
  systemPrompt: string;
}

export function buildNewAgentFile(input: NewAgentInput): string {
  const modelLine = input.model ? `\nmodel: ${JSON.stringify(input.model)}` : "";
  const thinkingLine = input.thinking ? `\nthinking: ${input.thinking}` : "";
  return `---
description: ${JSON.stringify(input.description)}
tools: ${input.tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${input.systemPrompt}
`;
}

function formatToolsField(tools: string[] | undefined): string {
  if (tools === undefined) return "all";
  if (tools.length === 0) return "none";
  return tools.join(", ");
}

export function serializeAgentFile(cfg: AgentConfig): string {
  const fmFields: string[] = [];
  fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
  if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
  if (cfg.color) fmFields.push(`color: ${JSON.stringify(cfg.color)}`);
  fmFields.push(`tools: ${formatToolsField(cfg.builtinToolNames)}`);
  if (cfg.model) fmFields.push(`model: ${cfg.model}`);
  if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  if (cfg.allowedSubagents !== undefined) {
    fmFields.push(
      `allowed_subagents: ${cfg.allowedSubagents === "all" ? "all" : cfg.allowedSubagents.join(", ")}`,
    );
  }
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.extensions === false) fmFields.push("extensions: false");
  else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
  if (cfg.excludeExtensions?.length)
    fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
  if (cfg.skills === false) fmFields.push("skills: false");
  else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
  if (cfg.disallowedTools?.length)
    fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground) fmFields.push("run_in_background: true");
  if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}
