import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.ts";
import type { AgentConfig, IsolationMode, MemoryScope, ThinkingLevel } from "./types.ts";
import { isNonNegativeFiniteNumber, isString } from "./value-guards.ts";

const RESERVED_IN_TYPE = ":";

type FrontmatterScalar = string | number | boolean | null;
type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

interface AgentFrontmatter {
  [key: string]: FrontmatterValue | undefined;
  name?: FrontmatterValue;
  display_name?: FrontmatterValue;
  color?: FrontmatterValue;
  description?: FrontmatterValue;
  tools?: FrontmatterValue;
  disallowed_tools?: FrontmatterValue;
  extensions?: FrontmatterValue;
  inherit_extensions?: FrontmatterValue;
  exclude_extensions?: FrontmatterValue;
  skills?: FrontmatterValue;
  inherit_skills?: FrontmatterValue;
  model?: FrontmatterValue;
  thinking?: FrontmatterValue;
  model_locked?: FrontmatterValue;
  default_model?: FrontmatterValue;
  default_thinking?: FrontmatterValue;
  max_turns?: FrontmatterValue;
  persist_session?: FrontmatterValue;
  output_transcript?: FrontmatterValue;
  session_dir?: FrontmatterValue;
  allowed_subagents?: FrontmatterValue;
  prompt_mode?: FrontmatterValue;
  inherit_context?: FrontmatterValue;
  run_in_background?: FrontmatterValue;
  isolated?: FrontmatterValue;
  fast_mode?: FrontmatterValue;
  daybreak?: FrontmatterValue;
  memory?: FrontmatterValue;
  isolation?: FrontmatterValue;
  enabled?: FrontmatterValue;
  internal?: FrontmatterValue;
}

const KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "name",
  "display_name",
  "color",
  "description",
  "tools",
  "disallowed_tools",
  "extensions",
  "inherit_extensions",
  "exclude_extensions",
  "skills",
  "inherit_skills",
  "model",
  "thinking",
  "model_locked",
  "default_model",
  "default_thinking",
  "max_turns",
  "persist_session",
  "output_transcript",
  "session_dir",
  "allowed_subagents",
  "prompt_mode",
  "inherit_context",
  "run_in_background",
  "isolated",
  "fast_mode",
  "daybreak",
  "memory",
  "isolation",
  "enabled",
  "internal",
  "persona",
]);

interface ParsedAgentFile {
  frontmatter: AgentFrontmatter;
  body: string;
  text: string;
}

interface ParsedToolsField {
  builtinToolNames: string[];
  extSelectors: string[] | undefined;
}

type AgentFileRead = { path: string; text: string } | { path: string; error: unknown };

export async function loadCustomAgents(
  cwd: string,
  strict = false,
): Promise<Map<string, AgentConfig>> {
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  const warned = new Set<string>();
  const [globalFiles, workspaceFiles, projectFiles] = await Promise.all([
    readAgentDir(globalDir),
    readAgentDir(workspaceProjectDir),
    readAgentDir(projectDir),
  ]);
  applyDir(globalFiles, agents, "global", strict, warned);
  applyDir(workspaceFiles, agents, "project", strict, warned);
  applyDir(projectFiles, agents, "project", strict, warned);

  warnedLastLoad = warned;
  return agents;
}

async function readAgentDir(dir: string): Promise<AgentFileRead[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (file): Promise<AgentFileRead> => {
      const path = join(dir, file);
      try {
        return { path, text: await readFile(path, "utf-8") };
      } catch (error) {
        return { path, error };
      }
    }),
  );
}

function applyDir(
  files: AgentFileRead[],
  agents: Map<string, AgentConfig>,
  source: "project" | "global",
  strict: boolean,
  warned: Set<string>,
): void {
  for (const read of files) {
    const path = read.path;
    const filenameType = basename(path, ".md");

    const parsed = parseAgentFile(read, strict, warned);
    if (!parsed) {
      warnSkippedOverride(filenameType, agents, warned);
      continue;
    }
    const { frontmatter: fm, body } = parsed;

    const declared = str(fm.name)?.trim();
    if (declared?.includes(RESERVED_IN_TYPE)) {
      warnIfNew(
        `Agent file ${path} declares name "${declared}", which contains "${RESERVED_IN_TYPE}" — reserved for ` +
          "plugin-scoped identifiers. Rename it, or move the label to `display_name:`. Skipping.",
        warned,
      );
      continue;
    }
    const name = declared || filenameType;

    warnUnknownKeys(path, fm, warned);
    warnDeprecatedModelKeys(path, fm, warned);
    warnShadowed(name, path, parsed.text, agents, warned);

    const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

    const config: AgentConfig = {
      name,
      displayName: str(fm.display_name),
      color: str(fm.color),
      description: str(fm.description) ?? name,
      builtinToolNames,
      extSelectors,
      disallowedTools: csvListOptional(fm.disallowed_tools),
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      excludeExtensions: csvListOptional(fm.exclude_extensions),
      skills: inheritField(fm.skills ?? fm.inherit_skills),
      model: str(fm.model) ?? str(fm.default_model),
      thinking: parseThinkingLevel(fm.thinking) ?? parseThinkingLevel(fm.default_thinking),
      modelLocked: fm.model_locked === true ? true : undefined,
      maxTurns: nonNegativeInt(fm.max_turns),
      persistSession: fm.persist_session == null ? undefined : fm.persist_session === true,
      outputTranscript: fm.output_transcript == null ? undefined : fm.output_transcript !== false,
      sessionDir: str(fm.session_dir),
      allowedSubagents: parseAllowedSubagents(fm.allowed_subagents),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context == null ? undefined : fm.inherit_context === true,
      runInBackground: fm.run_in_background == null ? undefined : fm.run_in_background === true,
      isolated: fm.isolated == null ? undefined : fm.isolated === true,
      fastMode: fm.fast_mode == null ? undefined : fm.fast_mode === true,
      daybreak: fm.daybreak == null ? undefined : fm.daybreak === true,
      memory: parseMemory(fm.memory),
      isolation: parseIsolation(fm.isolation),
      enabled: fm.enabled !== false,
      internal: fm.internal === true,
      source,
      sourcePath: path,
    };
    sourceTextOf.set(config, parsed.text);
    agents.set(name, config);
  }
}

function parseAgentFile(
  read: AgentFileRead,
  strict: boolean,
  warned: Set<string>,
): ParsedAgentFile | undefined {
  const path = read.path;
  try {
    if ("error" in read) throw read.error;
    return { ...parseFrontmatter<AgentFrontmatter>(read.text), text: read.text };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (strict) throw new Error(`${path}: ${reason}`);
    warnIfNew(`Skipping agent file ${path}: ${reason}`, warned);
    return undefined;
  }
}

function warnSkippedOverride(
  name: string,
  agents: Map<string, AgentConfig>,
  warned: Set<string>,
): void {
  const surviving = agents.get(name);
  if (!surviving?.sourcePath || surviving.enabled === false) return;
  warnIfNew(`Agent "${name}" now loads from ${surviving.sourcePath} instead`, warned);
}

function warnShadowed(
  name: string,
  path: string,
  text: string,
  agents: Map<string, AgentConfig>,
  warned: Set<string>,
): void {
  const previous = agents.get(name);
  const shadowed = previous?.sourcePath;
  if (previous === undefined || shadowed === undefined || shadowed === path) return;
  if (sourceTextOf.get(previous) === text) return;
  warnIfNew(`Agent "${name}" loads from ${path}, shadowing ${shadowed}`, warned);
}

const sourceTextOf = new WeakMap<AgentConfig, string>();

function warnUnknownKeys(path: string, fm: AgentFrontmatter, warned: Set<string>): void {
  for (const key of Object.keys(fm)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const hint =
      snake !== key && KNOWN_FRONTMATTER_KEYS.has(snake) ? ` (did you mean "${snake}"?)` : "";
    warnIfNew(
      `Agent file ${path} has unknown frontmatter key "${key}"${hint}; it is ignored.`,
      warned,
    );
  }
}

function warnDeprecatedModelKeys(path: string, fm: AgentFrontmatter, warned: Set<string>): void {
  const deprecated = (["default_model", "default_thinking"] as const).filter(
    (key) => fm[key] !== undefined,
  );
  if (deprecated.length === 0) return;
  warnIfNew(
    `Agent file ${path} uses deprecated ${deprecated.join(" and ")}; rename to model/thinking ` +
      "(overridable defaults). Add model_locked: true to pin them against the caller.",
    warned,
  );
}

let warnedLastLoad = new Set<string>();

function warnIfNew(message: string, warned: Set<string>): void {
  warned.add(message);
  if (warnedLastLoad.has(message)) return;
  console.warn(`[choco-pi-subagents] ${message}`);
}

function str(val: FrontmatterValue | undefined): string | undefined {
  return isString(val) ? val : undefined;
}

function nonNegativeInt(val: FrontmatterValue | undefined): number | undefined {
  return isNonNegativeFiniteNumber(val) ? val : undefined;
}

function parseThinkingLevel(val: FrontmatterValue | undefined): ThinkingLevel | undefined {
  if (
    val === "off" ||
    val === "minimal" ||
    val === "low" ||
    val === "medium" ||
    val === "high" ||
    val === "xhigh" ||
    val === "max"
  ) {
    // SAFETY: Pi accepts the advertised "off" level at runtime although ThinkingLevel omits it.
    return val as ThinkingLevel;
  }
  return undefined;
}

function parseCsvField(val: FrontmatterValue | undefined): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseAllowedSubagents(val: FrontmatterValue | undefined): "all" | string[] | undefined {
  if (val === true || val === false) return val ? "all" : undefined;
  const items = parseCsvField(val);
  if (!items) return undefined;
  return items.some((i) => i === "*" || i.toLowerCase() === "all") ? "all" : items;
}

function csvList(val: FrontmatterValue | undefined, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

function parseToolsField(val: FrontmatterValue | undefined): ParsedToolsField {
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter((e) => !isWildcard(e) && !e.startsWith("ext:"));
  const extEntries = entries.filter((e) => e.startsWith("ext:"));
  return {
    builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

function csvListOptional(val: FrontmatterValue | undefined): string[] | undefined {
  return parseCsvField(val);
}

function parseMemory(val: FrontmatterValue | undefined): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}

function parseIsolation(val: FrontmatterValue | undefined): IsolationMode | undefined {
  if (val === "worktree") return "worktree";
  if (val === "off" || val === "none" || val === "no" || val === false) return "off";
  return undefined;
}

function inheritField(val: FrontmatterValue | undefined): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
