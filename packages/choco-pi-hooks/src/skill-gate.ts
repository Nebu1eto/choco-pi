import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { scratchDestinations } from "@choco-pi/shared/scratch-path";
import { isString, type JsonRecord } from "@choco-pi/shared/runtime-values";

export interface LoadedSkill {
  readonly name: string;
  readonly filePath: string;
}

export interface SkillGateCall {
  readonly toolName: string;
  readonly input: JsonRecord;
  readonly cwd: string;
  readonly rootSession: boolean;
}

const COMMIT_SKILL = "commit";
const WORKFLOW_SKILLS = ["task-inline", "task", "task-hotfix", "task-dynamic"];
const COMMAND_FIELDS = new Map([
  ["bash", "command"],
  ["exec_command", "cmd"],
]);
const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+)*\s+commit(?=\s*(?:$|[-;&|)"'`\\]))/m;
const SKILL_BLOCK = /<skill name="([^"]+)" location="[^"]*">/g;
const TEMPORARY_ROOTS = [
  ...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]),
].map((root) => path.resolve(root));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandText(toolName: string, input: JsonRecord): string | undefined {
  const field = COMMAND_FIELDS.get(toolName);
  if (!field) return undefined;
  const value = input[field];
  return isString(value) ? value : undefined;
}

function readTexts(toolName: string, input: JsonRecord): string[] {
  if (toolName === "read") {
    const target = [input["path"], input["file_path"]].find(isString);
    return target ? [target] : [];
  }
  const command = commandText(toolName, input);
  return command ? [command] : [];
}

function mentionsSkill(text: string, skill: LoadedSkill): boolean {
  if (text.includes(skill.filePath)) return true;
  const name = escapeRegExp(skill.name);
  return new RegExp(`(?:^|[\\\\/\\s"'\`])${name}[\\\\/]SKILL\\.md`).test(text);
}

function absolutePath(target: string, cwd: string): string {
  const expanded = target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
  return path.resolve(cwd, expanded);
}

function isTemporary(target: string): boolean {
  return TEMPORARY_ROOTS.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}

function editsProjectFile(toolName: string, input: JsonRecord, cwd: string): boolean {
  return scratchDestinations(toolName, input).some(
    (destination) => !isTemporary(absolutePath(destination.path, cwd)),
  );
}

export class SkillGate {
  #skills = new Map<string, LoadedSkill>();
  readonly #read = new Set<string>();
  #workflowWarned = false;

  setSkills(skills: readonly LoadedSkill[]): void {
    this.#skills = new Map(
      skills.map((skill) => [skill.name, { name: skill.name, filePath: skill.filePath }]),
    );
  }

  notePrompt(prompt: string): void {
    for (const match of prompt.matchAll(SKILL_BLOCK)) if (match[1]) this.#read.add(match[1]);
  }

  check(call: SkillGateCall): string[] {
    const texts = readTexts(call.toolName, call.input);
    for (const skill of this.#skills.values())
      if (texts.some((text) => mentionsSkill(text, skill))) this.#read.add(skill.name);
    const warnings: string[] = [];
    const commit = this.#unread(COMMIT_SKILL);
    const command = commandText(call.toolName, call.input);
    if (commit && command && GIT_COMMIT.test(command))
      warnings.push(
        `Skill check: this call runs \`git commit\`, but the \`commit\` skill has not been read in this context. Read ${commit.filePath} before any further commit step. If this call created a commit, check it against each of the skill's rules and amend it if it deviates. Also follow every commit rule in the applicable AGENTS.md files.`,
      );
    if (call.rootSession && !this.#workflowWarned && this.#workflowUnread()) {
      const workflows = WORKFLOW_SKILLS.flatMap((name) => this.#skills.get(name) ?? []);
      if (workflows.length && editsProjectFile(call.toolName, call.input, call.cwd)) {
        this.#workflowWarned = true;
        const list = workflows.map((skill) => `\`${skill.name}\` (${skill.filePath})`).join(", ");
        warnings.push(
          `Skill check: this is the first project file edit in this context, and no implementation workflow skill has been read: ${list}. If this is change, build, or fix work, read the workflow your routing rules select before editing further, then read each skill that workflow or the applicable AGENTS.md files name for the current step. Ignore this when another skill already governs the work.`,
        );
      }
    }
    return warnings;
  }

  reset(): void {
    this.#read.clear();
    this.#workflowWarned = false;
  }

  #unread(name: string): LoadedSkill | undefined {
    const skill = this.#skills.get(name);
    return skill && !this.#read.has(name) ? skill : undefined;
  }

  #workflowUnread(): boolean {
    return WORKFLOW_SKILLS.every((name) => !this.#read.has(name));
  }
}
