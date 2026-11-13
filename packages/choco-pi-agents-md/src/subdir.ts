import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  type SessionStartEvent,
  type SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { findAgentsFiles } from "./agents-chain.ts";
import {
  type AgentsFileEntry,
  type AgentsFileSource,
  appendAgentsContext,
  capFileContent,
  capTotalAppendixSize,
  type ForeignAgentsFile,
} from "./appendix.ts";
import {
  contentRootForTarget,
  findSessionRoot,
  isInsideRoot,
  realpathOrSelf,
  resolvePath,
} from "./paths.ts";
import { type AgentsMdSettings, readAgentsMdSettings } from "./settings.ts";
import { isDiscoveryShellCommand, shellTargets } from "./shell-targets.ts";
import {
  codeModeDiscoveryEvents,
  type DiscoveryToolResultEvent,
  type ToolContent,
} from "./tool-events.ts";

const PATH_DISCOVERY_TOOLS = new Set(["grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "exec", "exec_command", "shell"]);
const MAX_OUTPUT_SCAN_LINES = 250;

interface FailedRead {
  agentsPath: string;
  error: Error;
}

interface AgentsMdAutoloadDependencies {
  readFile?: (filePath: string) => Promise<string>;
  /** Defaults to reading `agentsMd` from `<agentDir>/settings.json`. */
  loadSettings?: () => Promise<AgentsMdSettings>;
}

/** Real-path roots that bound which AGENTS.md files may be inlined. */
interface SessionScope {
  sessionRoot: string;
  trustedRoots: string[];
  /** Real path of the session cwd's own AGENTS.md (already in the base prompt). */
  cwdAgentsRealPath: string;
}

interface AllowedAgentsFile {
  /** Lexical path where the file was found; used only for the displayed label. */
  displayPath: string;
  source: AgentsFileSource;
}

interface TargetAgents {
  /** Allowed AGENTS.md files keyed by real path, root-first per target. */
  allowed: Map<string, AllowedAgentsFile>;
  /** Real paths of AGENTS.md files outside every allowed root. */
  foreign: string[];
}

/** Per-session injection accounting emitted on `SESSION_STATS_EVENT`. */
export interface AgentsMdSessionStats {
  cwd: string;
  injectedFiles: number;
  injectedChars: number;
  foreignPointers: number;
}

export const SESSION_STATS_EVENT = "choco-pi-agents-md:session-stats";

function defaultLoadSettings(): Promise<AgentsMdSettings> {
  return readAgentsMdSettings(getAgentDir());
}

async function loadSessionScope(
  cwd: string,
  loadSettings: () => Promise<AgentsMdSettings>,
): Promise<SessionScope> {
  const sessionRoot = await findSessionRoot(cwd);
  let configured: string[] = [];
  try {
    configured = (await loadSettings()).trustedRoots;
  } catch {
    configured = [];
  }
  const trustedRoots = await Promise.all(configured.map((root) => realpathOrSelf(root)));
  const cwdAgentsRealPath = await realpathOrSelf(path.join(cwd, "AGENTS.md"));
  return { sessionRoot, trustedRoots, cwdAgentsRealPath };
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Register the `tool_result` autoload that injects a `<subdirectory_agents_context>`
 * block into tool results when the touched path(s) have applicable AGENTS.md
 * files that have not been injected yet this session.
 *
 * Session-scoped dedup only: unlike the reference implementation, this
 * package does not persist injected-file state into message details, so
 * forking/resuming a session does not restore prior dedup state across the
 * fork boundary. See VENDORED.md for the full list of deliberate deviations.
 */
export function registerAgentsMdAutoload(
  pi: ExtensionAPI,
  dependencies: AgentsMdAutoloadDependencies = {},
): void {
  const readFile =
    dependencies.readFile ?? ((filePath: string) => fs.promises.readFile(filePath, "utf-8"));
  const loadSettings = dependencies.loadSettings ?? defaultLoadSettings;
  const loadedAgents = new Set<string>();
  let currentCwd = "";
  let cwdAgentsPath = "";
  let sessionGeneration = 0;
  let sessionScope: Promise<SessionScope> | undefined;
  let stats: AgentsMdSessionStats | undefined;

  function emitStats(): void {
    if (stats) pi.events?.emit(SESSION_STATS_EVENT, { ...stats });
    stats = undefined;
  }

  function resetSession(cwd: string, newSession: boolean): void {
    sessionGeneration += 1;
    currentCwd = resolvePath(cwd, process.cwd());
    cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
    loadedAgents.clear();
    loadedAgents.add(cwdAgentsPath);
    const scopeCwd = currentCwd;
    sessionScope = loadSessionScope(scopeCwd, loadSettings).catch(() => ({
      sessionRoot: scopeCwd,
      trustedRoots: [],
      cwdAgentsRealPath: path.join(scopeCwd, "AGENTS.md"),
    }));
    if (newSession || !stats) {
      emitStats();
      stats = { cwd: currentCwd, injectedFiles: 0, injectedChars: 0, foreignPointers: 0 };
    }
  }

  function invalidateSession(): void {
    sessionGeneration += 1;
    emitStats();
    currentCwd = "";
    cwdAgentsPath = "";
    sessionScope = undefined;
    loadedAgents.clear();
  }

  function ensureSession(cwd: string): void {
    if (!currentCwd) resetSession(cwd, false);
  }

  function relativePath(absolutePath: string, baseCwd: string): string {
    const relative = baseCwd ? path.relative(baseCwd, absolutePath) : absolutePath;
    return (relative || absolutePath).replaceAll("\\", "/");
  }

  function outputPathCandidate(line: string, toolName: string): string | undefined {
    if (toolName !== "grep") return line;
    const match = line.match(/^(.+?):\d+(?::\d+)?:/);
    return match?.[1] ?? line.split(":", 1)[0] ?? line;
  }

  function looksPathLike(value: string | undefined): value is string {
    return (
      value !== undefined && value.length > 0 && !value.includes("\0") && !value.startsWith("<")
    );
  }

  function pathsFromToolText(content: ToolContent[], base: string, toolName: string): string[] {
    return content.flatMap((item) => {
      if (item.type !== "text" || !item.text) return [];
      return item.text
        .split(/\r?\n/)
        .slice(0, MAX_OUTPUT_SCAN_LINES)
        .map((line) => outputPathCandidate(line.trim(), toolName))
        .filter(looksPathLike)
        .map((line) => resolvePath(line, base))
        .filter((candidate) => fs.existsSync(candidate));
    });
  }

  function targetsForEvent(event: DiscoveryToolResultEvent, baseCwd: string): string[] {
    const input = event.input;
    const workdir = input.workdir ?? input.cwd ?? input.working_directory;
    const eventCwd = workdir !== undefined ? resolvePath(workdir, baseCwd) : baseCwd;
    const pathInput = input.path;

    if (event.toolName === "read") {
      return [pathInput ? resolvePath(pathInput, eventCwd) : eventCwd];
    }
    if (PATH_DISCOVERY_TOOLS.has(event.toolName)) {
      const base = pathInput ? resolvePath(pathInput, eventCwd) : eventCwd;
      return [base, ...pathsFromToolText(event.content, base, event.toolName)];
    }
    if (SHELL_TOOLS.has(event.toolName)) {
      const command = input.command ?? input.cmd;
      if (!command || !isDiscoveryShellCommand(command)) return [];
      return shellTargets(command, eventCwd);
    }
    return [];
  }

  function sourceFor(scope: SessionScope, absolutePath: string): AgentsFileSource | undefined {
    if (isInsideRoot(scope.sessionRoot, absolutePath)) return "project";
    if (scope.trustedRoots.some((root) => isInsideRoot(root, absolutePath))) return "trusted-root";
    return undefined;
  }

  /**
   * Targets are already real paths (`resolvePath` resolves symlinks through
   * the nearest existing ancestor). Each discovered AGENTS.md is resolved to
   * its real path before classification, deduplication, and reading, so a
   * symlinked AGENTS.md inside the session root that points elsewhere is
   * classified by its destination. Returns `undefined` when the session
   * changed while resolving.
   */
  async function agentsForTargets(
    targets: string[],
    rootAgentsPath: string,
    scope: SessionScope,
    generation: number,
  ): Promise<TargetAgents | undefined> {
    const allowed = new Map<string, AllowedAgentsFile>();
    const foreign = new Set<string>();
    for (const target of targets) {
      const searchRoot = contentRootForTarget(target);
      if (!searchRoot) continue;
      if (path.basename(target) === "AGENTS.md") {
        loadedAgents.add(path.normalize(target));
        continue;
      }
      const targetIsDirectory = await isDirectory(target);
      if (generation !== sessionGeneration) return undefined;
      const probe = targetIsDirectory ? path.join(target, "__probe__") : target;
      const targetAllowed = sourceFor(scope, target) !== undefined;
      for (const file of findAgentsFiles(probe, searchRoot, rootAgentsPath)) {
        const realFile = await realpathOrSelf(file);
        if (generation !== sessionGeneration) return undefined;
        if (realFile === scope.cwdAgentsRealPath) continue;
        const source = sourceFor(scope, realFile);
        if (!source) foreign.add(realFile);
        else if (targetAllowed && !allowed.has(realFile)) {
          allowed.set(realFile, { displayPath: file, source });
        }
      }
    }
    return { allowed, foreign: [...foreign] };
  }

  async function readAppendixFiles(
    agentFiles: Map<string, AllowedAgentsFile>,
    generation: number,
    baseCwd: string,
  ): Promise<{ appendixFiles: AgentsFileEntry[]; failedFiles: FailedRead[] } | undefined> {
    const pendingFiles: { agentsPath: string; entry: AgentsFileEntry }[] = [];
    const failedFiles: FailedRead[] = [];
    for (const [agentsPath, { displayPath, source }] of agentFiles) {
      if (loadedAgents.has(agentsPath)) continue;
      try {
        const content = await readFile(agentsPath);
        if (generation !== sessionGeneration) return undefined;
        if (loadedAgents.has(agentsPath)) continue;
        pendingFiles.push({
          agentsPath,
          entry: {
            path: relativePath(displayPath, baseCwd),
            content: capFileContent(content),
            source,
          },
        });
      } catch (error) {
        if (generation !== sessionGeneration) return undefined;
        if (error instanceof Error) failedFiles.push({ agentsPath, error });
      }
    }
    const appendixFiles = capTotalAppendixSize(pendingFiles.map(({ entry }) => entry));
    const keptEntries = new Set(appendixFiles);
    if (generation !== sessionGeneration) return undefined;
    for (const { agentsPath, entry } of pendingFiles) {
      if (keptEntries.has(entry)) loadedAgents.add(agentsPath);
    }
    return { appendixFiles, failedFiles };
  }

  /** Size each unseen foreign file once per session; never reads content. */
  async function foreignPointers(
    foreignFiles: string[],
    generation: number,
  ): Promise<ForeignAgentsFile[] | undefined> {
    const pointers: ForeignAgentsFile[] = [];
    for (const agentsPath of foreignFiles) {
      if (loadedAgents.has(agentsPath)) continue;
      let bytes: number;
      try {
        bytes = (await stat(agentsPath)).size;
      } catch {
        if (generation !== sessionGeneration) return undefined;
        continue;
      }
      if (generation !== sessionGeneration) return undefined;
      if (loadedAgents.has(agentsPath)) continue;
      loadedAgents.add(agentsPath);
      pointers.push({ path: agentsPath, bytes });
    }
    return pointers;
  }

  const handleSessionChange = (
    event: SessionStartEvent | SessionTreeEvent,
    ctx: { cwd: string },
  ): void => {
    resetSession(ctx.cwd, event.type === "session_start");
  };
  pi.on("session_start", handleSessionChange);
  pi.on("session_tree", handleSessionChange);
  pi.on("session_shutdown", invalidateSession);

  pi.on("tool_result", async (event, ctx) => {
    ensureSession(ctx.cwd);
    const generation = sessionGeneration;
    const baseCwd = currentCwd;
    const rootAgentsPath = cwdAgentsPath;
    const scopePromise = sessionScope;
    const discoveryEvents = codeModeDiscoveryEvents(event);
    if (event.isError) discoveryEvents.shift();

    const targets = discoveryEvents.flatMap((discoveryEvent) =>
      targetsForEvent(discoveryEvent, baseCwd),
    );
    if (!targets.length || !scopePromise) return undefined;

    const scope = await scopePromise;
    if (generation !== sessionGeneration) return undefined;
    const targetAgents = await agentsForTargets(targets, rootAgentsPath, scope, generation);
    if (generation !== sessionGeneration || !targetAgents) return undefined;
    const { allowed, foreign } = targetAgents;
    if (!allowed.size && !foreign.length) return undefined;

    const readResult = await readAppendixFiles(allowed, generation, baseCwd);
    if (generation !== sessionGeneration || !readResult) return undefined;
    const { appendixFiles, failedFiles } = readResult;
    const pointers = await foreignPointers(foreign, generation);
    if (generation !== sessionGeneration || !pointers) return undefined;

    if (ctx.hasUI) {
      for (const failed of failedFiles) {
        ctx.ui.notify(`Failed to load ${failed.agentsPath}: ${failed.error.message}`, "warning");
      }
      if (appendixFiles.length) {
        const label =
          appendixFiles.length === 1
            ? `Loaded AGENTS.md context: ${appendixFiles[0]?.path}`
            : `Loaded AGENTS.md context (${appendixFiles.length} files)`;
        ctx.ui.notify(label, "info");
      }
    }

    if (!appendixFiles.length && !pointers.length) return undefined;

    for (const file of appendixFiles) {
      pi.events?.emit("choco-pi-hooks:instructions-loaded", {
        filePath: resolvePath(file.path, baseCwd),
        memoryType: "Project",
        loadReason: "nested_traversal",
      });
    }

    const content = appendAgentsContext(event.content, appendixFiles, pointers);
    if (stats) {
      stats.injectedFiles += appendixFiles.length;
      stats.foreignPointers += pointers.length;
      for (const item of content.slice(event.content.length)) {
        if (item.type === "text") stats.injectedChars += item.text.length;
      }
    }
    return { content };
  });
}
