import { lstatSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type BoundaryRecord,
  type BoundaryValue,
  errorCode,
  errorMessage,
  isBoundaryArray,
  isBoundaryRecord,
  isString,
} from "../boundary.ts";

const AGENT_NAME = "choco-pi";
const EMBEDDED_CONTEXT_ENV = "PI_ACP_ENABLE_EMBEDDED_CONTEXT";

type Output = (line: string) => void;

export interface ZedSetupDependencies {
  adapterPath?: string;
  commandPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  output?: Output;
  platform?: NodeJS.Platform;
  settingsPath?: string;
  tasksPath?: string;
}

type ParsedSetupArguments = Readonly<{
  action: "setup" | "doctor" | "remove" | undefined;
  apply: boolean;
  dryRun: boolean;
  replace: boolean;
  zedConfigDirectory: string | undefined;
}>;

interface PropertyRange {
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  commaStart?: number;
}

interface ObjectRange {
  start: number;
  end: number;
  properties: ReadonlyMap<string, PropertyRange>;
}

const TASK_LABELS = [
  "Choco Pi: Sync Focused Context",
  "Choco Pi: Sync Focused Context (No Selection)",
  "Choco Pi: Sync Saved File Context",
  "Choco Pi: List Live Sessions",
  "Choco Pi: Select Context Target",
  "Choco Pi: Open Terminal Thread",
] as const;

type ZedTask = BoundaryRecord;

interface UpdateResult {
  changed: boolean;
  conflict: boolean;
  source: string;
}

interface RemoveResult {
  changed: boolean;
  source: string;
}

export function detectZedSettingsPath(
  options: {
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const currentPlatform = options.platform ?? platform();
  const home = options.homeDirectory ?? homedir();
  if (currentPlatform === "darwin") {
    return join(home, ".config", "zed", "settings.json");
  }
  if (currentPlatform === "linux") {
    const configHome = options.environment?.XDG_CONFIG_HOME;
    return join(
      configHome && isAbsolute(configHome) ? configHome : join(home, ".config"),
      "zed",
      "settings.json",
    );
  }
  throw new Error(`Unsupported platform for Zed setup: ${currentPlatform}`);
}

function parseArguments(argv: readonly string[]): ParsedSetupArguments {
  const action = argv[0];
  if (action !== "setup" && action !== "doctor" && action !== "remove") {
    return {
      action: undefined,
      apply: false,
      dryRun: false,
      replace: false,
      zedConfigDirectory: undefined,
    };
  }
  let apply = false;
  let dryRun = false;
  let replace = false;
  let zedConfigDirectory: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--replace") replace = true;
    else if (argument === "--zed-config-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--zed-config-dir requires a directory path");
      }
      zedConfigDirectory = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (action === "doctor" && (apply || dryRun || replace)) {
    throw new Error("doctor does not accept mutation options");
  }
  if (action !== "doctor" && apply === dryRun) {
    throw new Error(`${action} requires exactly one of --dry-run or --apply`);
  }
  return { action, apply, dryRun, replace, zedConfigDirectory };
}

function resolveZedConfigDirectory(value: string): string {
  if (value.trim() === "" || value.includes("\0")) {
    throw new Error("--zed-config-dir requires a valid directory path");
  }
  const directory = resolve(value);
  if (dirname(directory) === directory) {
    throw new Error("--zed-config-dir cannot target a filesystem root");
  }

  const inspect = (
    path: string,
    subject: "config directory" | "settings.json" | "tasks.json",
  ): ReturnType<typeof lstatSync> | undefined => {
    try {
      return lstatSync(path);
    } catch (failure) {
      // SAFETY: filesystem APIs may throw arbitrary runtime values; errorCode validates before access.
      const cause = failure as BoundaryValue;
      if (errorCode(cause) === "ENOENT") return undefined;
      throw new Error(`--zed-config-dir could not inspect the ${subject}`);
    }
  };
  const canonicalize = (
    path: string,
    subject: "config directory" | "settings.json" | "tasks.json",
  ): string => {
    try {
      return realpathSync(path);
    } catch {
      throw new Error(`--zed-config-dir could not resolve the ${subject}`);
    }
  };
  const contains = (parent: string, candidate: string): boolean => {
    const pathFromParent = relative(parent, candidate);
    return (
      pathFromParent !== "" &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent)
    );
  };

  const directoryStatus = inspect(directory, "config directory");
  if (!directoryStatus) {
    let ancestor = dirname(directory);
    let ancestorStatus = inspect(ancestor, "config directory");
    while (!ancestorStatus && dirname(ancestor) !== ancestor) {
      ancestor = dirname(ancestor);
      ancestorStatus = inspect(ancestor, "config directory");
    }
    if (!ancestorStatus || !ancestorStatus.isDirectory()) {
      throw new Error("--zed-config-dir requires an accessible directory path");
    }
    if (canonicalize(ancestor, "config directory") !== ancestor) {
      throw new Error("--zed-config-dir path must not traverse symbolic links");
    }
    return directory;
  }
  if (directoryStatus.isSymbolicLink()) {
    const target = canonicalize(directory, "config directory");
    let targetStatus: ReturnType<typeof lstatSync>;
    try {
      targetStatus = lstatSync(target);
    } catch {
      throw new Error("--zed-config-dir could not inspect the config directory target");
    }
    if (!targetStatus.isDirectory()) {
      throw new Error(
        "--zed-config-dir must target a directory, not a symbolic link to a non-directory",
      );
    }
    throw new Error("--zed-config-dir must not target a symbolic link");
  }
  if (!directoryStatus.isDirectory()) {
    throw new Error("--zed-config-dir must target a directory");
  }

  const canonicalDirectory = canonicalize(directory, "config directory");
  if (canonicalDirectory !== directory) {
    throw new Error("--zed-config-dir path must not traverse symbolic links");
  }
  for (const file of ["settings.json", "tasks.json"] as const) {
    const candidate = join(directory, file);
    const subject = file;
    const candidateStatus = inspect(candidate, subject);
    if (!candidateStatus) continue;
    const canonicalCandidate = canonicalize(candidate, subject);
    if (!contains(canonicalDirectory, canonicalCandidate)) {
      throw new Error(`--zed-config-dir ${file} must not resolve outside the config directory`);
    }
    if (candidateStatus.isSymbolicLink()) {
      throw new Error(`--zed-config-dir ${file} must be a regular file, not a symbolic link`);
    }
    if (!candidateStatus.isFile()) {
      throw new Error(`--zed-config-dir ${file} must be a regular file`);
    }
  }
  return directory;
}

function skipTrivia(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    if (/\s/u.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      return newline < 0 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated JSONC comment");
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function scanString(source: string, from: number): number {
  let index = from + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === '"') return index + 1;
    else index += 1;
  }
  throw new Error("Unterminated JSONC string");
}

function scanValue(source: string, from: number): number {
  const start = skipTrivia(source, from);
  if (source[start] === '"') return scanString(source, start);
  const opening = source[start];
  if (opening === "{" || opening === "[") {
    const closing = opening === "{" ? "}" : "]";
    let depth = 1;
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '"') index = scanString(source, index);
      else if (source.startsWith("//", index)) {
        const newline = source.indexOf("\n", index + 2);
        index = newline < 0 ? source.length : newline + 1;
      } else if (source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) throw new Error("Unterminated JSONC comment");
        index = end + 2;
      } else {
        if (source[index] === opening) depth += 1;
        if (source[index] === closing) {
          depth -= 1;
          if (depth === 0) return index + 1;
        }
        index += 1;
      }
    }
    throw new Error("Unterminated JSONC value");
  }
  let index = start;
  while (index < source.length && !",}]".includes(source[index] ?? "")) index += 1;
  return index;
}

function scanObject(source: string, from = 0): ObjectRange {
  const start = skipTrivia(source, from);
  if (source[start] !== "{") throw new Error("Zed settings must contain a JSON object");
  const properties = new Map<string, PropertyRange>();
  let index = start + 1;
  while (true) {
    index = skipTrivia(source, index);
    if (source[index] === "}") return { start, end: index, properties };
    if (source[index] !== '"') throw new Error("Zed settings property names must be quoted");
    const keyStart = index;
    const keyEnd = scanString(source, index);
    const key = parseJsonText(source.slice(keyStart, keyEnd), "Zed settings property name");
    if (!isString(key)) throw new Error("Zed settings property names must be strings");
    index = skipTrivia(source, keyEnd);
    if (source[index] !== ":") throw new Error(`Missing colon after ${key}`);
    const valueStart = skipTrivia(source, index + 1);
    const valueEnd = scanValue(source, valueStart);
    index = skipTrivia(source, valueEnd);
    let commaStart: number | undefined;
    if (source[index] === ",") {
      commaStart = index;
      index += 1;
    } else if (source[index] !== "}") {
      throw new Error(`Missing comma after ${key}`);
    }
    properties.set(key, { keyStart, valueStart, valueEnd, commaStart });
  }
}

function stripJsonComments(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"') {
      const end = scanString(source, index);
      result += source.slice(index, end);
      index = end;
    } else if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      const end = newline < 0 ? source.length : newline;
      result += " ".repeat(end - index);
      index = end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated JSONC comment");
      result += source.slice(index, end + 2).replace(/[^\r\n]/gu, " ");
      index = end + 2;
    } else {
      result += source[index];
      index += 1;
    }
  }
  return result.replace(/,\s*([}\]])/gu, "$1");
}

/** Parse JSON text at the file boundary, converting parser failures into a named error. */
function parseJsonText(text: string, what: string): BoundaryValue {
  try {
    const value: BoundaryValue = JSON.parse(text);
    return value;
  } catch (failure) {
    // SAFETY: JSON.parse may throw an arbitrary runtime value; errorMessage handles every value.
    const cause = failure as BoundaryValue;
    throw new Error(`${what} is not valid JSON: ${errorMessage(cause)}`);
  }
}

export function parseZedSettings(source: string): BoundaryRecord {
  const parsed = parseJsonText(stripJsonComments(source), "Zed settings");
  if (!isBoundaryRecord(parsed)) {
    throw new Error("Zed settings must contain a JSON object");
  }
  return parsed;
}

export function parseZedTasks(source: string): ZedTask[] {
  const parsed = parseJsonText(stripJsonComments(source), "Zed tasks");
  if (!isBoundaryArray(parsed)) {
    throw new Error("Zed tasks must contain a JSON array of task objects");
  }
  const tasks: ZedTask[] = [];
  for (const task of parsed) {
    if (!isBoundaryRecord(task)) {
      throw new Error("Zed tasks must contain a JSON array of task objects");
    }
    tasks.push(task);
  }
  return tasks;
}

function lineIndent(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return source.slice(lineStart, index).match(/^\s*/u)?.[0] ?? "";
}

function indentSerialized(value: BoundaryValue, indent: string): string {
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
}

function addObjectProperty(
  source: string,
  object: ObjectRange,
  key: string,
  value: BoundaryValue,
): string {
  const closingIndent = lineIndent(source, object.end);
  const propertyIndent = `${closingIndent}  `;
  const serialized = `${JSON.stringify(key)}: ${indentSerialized(value, propertyIndent)}`;
  const properties = [...object.properties.values()];
  if (properties.length === 0) {
    return `${source.slice(0, object.end)}\n${propertyIndent}${serialized}\n${closingIndent}${source.slice(object.end)}`;
  }
  const last = properties.at(-1);
  if (!last) throw new Error("Could not inspect Zed settings");
  const comma = last.commaStart === undefined ? "," : "";
  return `${source.slice(0, last.valueEnd)}${comma}${source.slice(last.valueEnd, object.end)}\n${propertyIndent}${serialized}\n${closingIndent}${source.slice(object.end)}`;
}

function replaceRange(source: string, range: PropertyRange, value: BoundaryValue): string {
  const indent = lineIndent(source, range.keyStart);
  return `${source.slice(0, range.valueStart)}${indentSerialized(value, indent)}${source.slice(range.valueEnd)}`;
}

function removeProperty(source: string, object: ObjectRange, range: PropertyRange): string {
  if (range.commaStart !== undefined) {
    return source.slice(0, range.keyStart) + source.slice(range.commaStart + 1);
  }
  const preceding = [...object.properties.values()]
    .filter((candidate) => candidate.keyStart < range.keyStart)
    .at(-1);
  const start = preceding?.commaStart ?? range.keyStart;
  return source.slice(0, start) + source.slice(range.valueEnd);
}

function desiredAgent(commandPath: string, adapterPath: string) {
  return {
    type: "custom",
    command: commandPath,
    args: [adapterPath],
    env: { [EMBEDDED_CONTEXT_ENV]: "true" },
  };
}

function editorContextCliPath(adapterPath: string): string {
  const adapterPackage = dirname(dirname(adapterPath));
  return resolve(dirname(adapterPackage), "choco-pi-editor-context", "src", "cli.ts");
}

function desiredTasks(commandPath: string, adapterPath: string): ZedTask[] {
  const contextCliPath = editorContextCliPath(adapterPath);
  return [
    {
      label: TASK_LABELS[0],
      description:
        "Requires a text editor with a selection focused before opening the Task picker.",
      command: commandPath,
      args: [
        contextCliPath,
        "publish",
        "--cwd",
        "$ZED_WORKTREE_ROOT",
        "--path",
        "$ZED_FILE",
        "--line",
        "$ZED_ROW",
        "--column",
        "$ZED_COLUMN",
        "--language",
        "$ZED_LANGUAGE",
        "--symbol",
        "$ZED_SYMBOL",
        "--selection-env",
        "CHOCO_PI_ZED_SELECTION",
      ],
      env: { CHOCO_PI_ZED_SELECTION: "$ZED_SELECTED_TEXT" },
      cwd: "$ZED_WORKTREE_ROOT",
      save: "none",
      show_command: false,
      show_summary: false,
    },
    {
      label: TASK_LABELS[1],
      description:
        "Requires a text editor focused before opening the Task picker; selection text is excluded.",
      command: commandPath,
      args: [
        contextCliPath,
        "publish",
        "--cwd",
        "$ZED_WORKTREE_ROOT",
        "--path",
        "$ZED_FILE",
        "--line",
        "$ZED_ROW",
        "--column",
        "$ZED_COLUMN",
        "--language",
        "$ZED_LANGUAGE",
        "--symbol",
        "$ZED_SYMBOL",
        "--no-selection-text",
      ],
      env: {},
      cwd: "$ZED_WORKTREE_ROOT",
      save: "none",
      show_command: false,
      show_summary: false,
    },
    {
      label: TASK_LABELS[2],
      description: "Requires a text editor focused before opening the Task picker.",
      command: commandPath,
      args: [
        contextCliPath,
        "publish",
        "--cwd",
        "$ZED_WORKTREE_ROOT",
        "--path",
        "$ZED_FILE",
        "--language",
        "$ZED_LANGUAGE",
        "--symbol",
        "$ZED_SYMBOL",
      ],
      env: {},
      cwd: "$ZED_WORKTREE_ROOT",
      save: "current",
      reveal: "never",
      show_command: false,
      show_summary: false,
    },
    {
      label: TASK_LABELS[3],
      command: commandPath,
      args: [contextCliPath, "list", "--cwd", "$ZED_WORKTREE_ROOT"],
      env: {},
      cwd: "$ZED_WORKTREE_ROOT",
    },
    {
      label: TASK_LABELS[4],
      description:
        "Run Choco Pi: List Live Sessions, then run the printed select command in Zed's terminal.",
      command: commandPath,
      args: [contextCliPath, "list", "--cwd", "$ZED_WORKTREE_ROOT"],
      env: {},
      cwd: "$ZED_WORKTREE_ROOT",
    },
    {
      label: TASK_LABELS[5],
      command: "pi",
      args: [],
      env: {},
      cwd: "$ZED_WORKTREE_ROOT",
      save: "none",
    },
  ];
}

type DesiredAgent = ReturnType<typeof desiredAgent>;

function sameValue(left: BoundaryValue, right: BoundaryValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateAgent(source: string, desired: DesiredAgent, replace: boolean): UpdateResult {
  const settings = parseZedSettings(source);
  const root = scanObject(source);
  const serversValue = settings.agent_servers;
  const serversProperty = root.properties.get("agent_servers");
  if (serversValue === undefined || serversProperty === undefined) {
    return {
      changed: true,
      conflict: false,
      source: addObjectProperty(source, root, "agent_servers", { [AGENT_NAME]: desired }),
    };
  }
  if (!isBoundaryRecord(serversValue)) {
    return replace
      ? {
          changed: true,
          conflict: false,
          source: replaceRange(source, serversProperty, { [AGENT_NAME]: desired }),
        }
      : { changed: false, conflict: true, source };
  }
  const existing = serversValue[AGENT_NAME];
  if (existing !== undefined && sameValue(existing, desired))
    return { changed: false, conflict: false, source };
  if (existing !== undefined && !replace) return { changed: false, conflict: true, source };
  const serversObject = scanObject(source, serversProperty.valueStart);
  const agentProperty = serversObject.properties.get(AGENT_NAME);
  return agentProperty
    ? { changed: true, conflict: false, source: replaceRange(source, agentProperty, desired) }
    : {
        changed: true,
        conflict: false,
        source: addObjectProperty(source, serversObject, AGENT_NAME, desired),
      };
}

function removeAgent(source: string): RemoveResult {
  const settings = parseZedSettings(source);
  if (!isBoundaryRecord(settings.agent_servers)) {
    return { changed: false, source };
  }
  const root = scanObject(source);
  const serversProperty = root.properties.get("agent_servers");
  if (!serversProperty) return { changed: false, source };
  const serversObject = scanObject(source, serversProperty.valueStart);
  const agentProperty = serversObject.properties.get(AGENT_NAME);
  return agentProperty
    ? { changed: true, source: removeProperty(source, serversObject, agentProperty) }
    : { changed: false, source };
}

function serializeTasks(tasks: readonly ZedTask[]): string {
  return `${JSON.stringify(tasks, null, 2)}\n`;
}

function updateTasks(source: string, desired: readonly ZedTask[], replace: boolean): UpdateResult {
  const current = parseZedTasks(source);
  const desiredByLabel = new Map(
    desired.flatMap((task) => (isString(task.label) ? [[task.label, task] as const] : [])),
  );
  const conflicts = new Set<string>();
  const seen = new Set<string>();
  for (const task of current) {
    if (!isString(task.label) || !desiredByLabel.has(task.label)) continue;
    const expected = desiredByLabel.get(task.label);
    if (seen.has(task.label) || !sameValue(task, expected)) conflicts.add(task.label);
    seen.add(task.label);
  }
  if (conflicts.size > 0 && !replace) return { changed: false, conflict: true, source };

  const added = new Set<string>();
  const next: ZedTask[] = [];
  for (const task of current) {
    if (!isString(task.label) || !desiredByLabel.has(task.label)) {
      next.push(task);
      continue;
    }
    if (added.has(task.label)) continue;
    next.push(desiredByLabel.get(task.label) ?? task);
    added.add(task.label);
  }
  for (const task of desired) {
    if (isString(task.label) && !added.has(task.label)) next.push(task);
  }
  return sameValue(current, next)
    ? { changed: false, conflict: false, source }
    : { changed: true, conflict: false, source: serializeTasks(next) };
}

function removeTasks(source: string): RemoveResult {
  const current = parseZedTasks(source);
  const labels = new Set<string>(TASK_LABELS);
  const retained = current.filter((task) => !isString(task.label) || !labels.has(task.label));
  return retained.length === current.length
    ? { changed: false, source }
    : { changed: true, source: serializeTasks(retained) };
}

async function readExisting(path: string): Promise<{ exists: boolean; source: string }> {
  try {
    return { exists: true, source: await readFile(path, "utf8") };
  } catch (failure) {
    // SAFETY: filesystem APIs may throw arbitrary runtime values; errorCode validates before access.
    const cause = failure as BoundaryValue;
    if (errorCode(cause) === "ENOENT") return { exists: false, source: "{}\n" };
    throw failure;
  }
}

async function writeWithBackup(path: string, source: string, existed: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (existed) await copyFile(path, `${path}.bak`);
  const temporary = `${path}.choco-pi-${process.pid}.tmp`;
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isRemote(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.ZED_REMOTE_SERVER ||
    environment.SSH_CONNECTION ||
    environment.SSH_TTY ||
    environment.REMOTE_CONTAINERS,
  );
}

export async function runZedSetupCli(
  argv: readonly string[],
  dependencies: ZedSetupDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? console.log;
  try {
    const parsed = parseArguments(argv);
    if (!parsed.action) {
      output(
        "Usage: choco-pi-acp zed setup|doctor|remove [--dry-run|--apply] [--replace] [--zed-config-dir <dir>]",
      );
      return 2;
    }
    const environment = dependencies.environment ?? process.env;
    const adapterPath = resolve(dependencies.adapterPath ?? process.argv[1] ?? "choco-pi-acp");
    const commandPath = resolve(dependencies.commandPath ?? process.execPath);
    const requestedConfigDirectory =
      parsed.zedConfigDirectory === undefined
        ? undefined
        : resolveZedConfigDirectory(parsed.zedConfigDirectory);
    let settingsPath: string;
    let tasksPath: string;
    if (requestedConfigDirectory === undefined) {
      settingsPath =
        dependencies.settingsPath ??
        detectZedSettingsPath({
          environment,
          homeDirectory: dependencies.homeDirectory,
          platform: dependencies.platform,
        });
      tasksPath = dependencies.tasksPath ?? join(dirname(settingsPath), "tasks.json");
    } else {
      settingsPath = join(requestedConfigDirectory, "settings.json");
      tasksPath = join(requestedConfigDirectory, "tasks.json");
    }
    output(`Project execution: ${isRemote(environment) ? "remote" : "local"}`);
    if (requestedConfigDirectory !== undefined) {
      output(`Zed config directory: ${requestedConfigDirectory}`);
    }
    output(`Zed settings: ${settingsPath}`);
    output(`Zed tasks: ${tasksPath}`);
    output(`Command path: ${commandPath}`);
    output(`${EMBEDDED_CONTEXT_ENV}=true`);

    const [currentSettings, currentTasks] = await Promise.all([
      readExisting(settingsPath),
      readExisting(tasksPath).then((current) =>
        current.exists ? current : { exists: false, source: "[]\n" },
      ),
    ]);
    const desiredAgentDefinition = desiredAgent(commandPath, adapterPath);
    const desiredTaskDefinitions = desiredTasks(commandPath, adapterPath);
    if (parsed.action === "doctor") {
      const settingsResult = updateAgent(currentSettings.source, desiredAgentDefinition, false);
      const tasksResult = updateTasks(currentTasks.source, desiredTaskDefinitions, false);
      output(
        `Settings status: ${
          settingsResult.conflict
            ? "Status: conflicting choco-pi agent definition"
            : settingsResult.changed
              ? "Status: setup required"
              : "Status: configured"
        }`,
      );
      output(
        `Tasks status: ${
          tasksResult.conflict
            ? "Status: conflicting choco-pi task definition"
            : tasksResult.changed
              ? "Status: setup required"
              : "Status: configured"
        }`,
      );
      const healthy =
        !settingsResult.conflict &&
        !settingsResult.changed &&
        !tasksResult.conflict &&
        !tasksResult.changed;
      output(`Status: ${healthy ? "configured" : "setup required"}`);
      return healthy ? 0 : 1;
    }

    const settingsResult =
      parsed.action === "setup"
        ? updateAgent(currentSettings.source, desiredAgentDefinition, parsed.replace)
        : { ...removeAgent(currentSettings.source), conflict: false };
    const tasksResult =
      parsed.action === "setup"
        ? updateTasks(currentTasks.source, desiredTaskDefinitions, parsed.replace)
        : { ...removeTasks(currentTasks.source), conflict: false };
    if (settingsResult.conflict || tasksResult.conflict) {
      output(
        "Refusing to replace an existing choco-pi agent or task definition; rerun with --replace.",
      );
      return 1;
    }
    if (parsed.dryRun) {
      output("Dry run: no files written.");
      output(`Intended settings (${settingsPath}):`);
      output(settingsResult.source);
      output(`Intended tasks (${tasksPath}):`);
      output(tasksResult.source);
      return 0;
    }
    if (!settingsResult.changed && !tasksResult.changed) {
      output(
        parsed.action === "setup"
          ? "No changes required."
          : "No choco-pi agent or task definitions found.",
      );
      return 0;
    }
    if (settingsResult.changed) {
      await writeWithBackup(settingsPath, settingsResult.source, currentSettings.exists);
      output(
        `Applied ${parsed.action} settings; backup: ${currentSettings.exists ? `${settingsPath}.bak` : "not needed"}`,
      );
    }
    if (tasksResult.changed) {
      await writeWithBackup(tasksPath, tasksResult.source, currentTasks.exists);
      output(
        `Applied ${parsed.action} tasks; backup: ${currentTasks.exists ? `${tasksPath}.bak` : "not needed"}`,
      );
    }
    return 0;
  } catch (error) {
    output(`Zed setup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}
