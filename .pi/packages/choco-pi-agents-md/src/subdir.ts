import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { findAgentsFiles } from "./agents-chain.ts";
import {
  type AgentsFileEntry,
  appendAgentsContext,
  capFileContent,
  capTotalAppendixSize,
} from "./appendix.ts";
import { contentRootForTarget, resolvePath } from "./paths.ts";
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
  const loadedAgents = new Set<string>();
  let currentCwd = "";
  let cwdAgentsPath = "";
  let sessionGeneration = 0;

  function resetSession(cwd: string): void {
    sessionGeneration += 1;
    currentCwd = resolvePath(cwd, process.cwd());
    cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
    loadedAgents.clear();
    loadedAgents.add(cwdAgentsPath);
  }

  function invalidateSession(): void {
    sessionGeneration += 1;
    currentCwd = "";
    cwdAgentsPath = "";
    loadedAgents.clear();
  }

  function ensureSession(cwd: string): void {
    if (!currentCwd) resetSession(cwd);
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

  function agentsForTargets(targets: string[], rootAgentsPath: string): string[] {
    const files = new Set<string>();
    for (const target of targets) {
      const searchRoot = contentRootForTarget(target);
      if (!searchRoot) continue;
      if (path.basename(target) === "AGENTS.md") {
        loadedAgents.add(path.normalize(target));
        continue;
      }
      let probe = target;
      try {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          probe = path.join(target, "__probe__");
        }
      } catch {
        continue;
      }
      for (const file of findAgentsFiles(probe, searchRoot, rootAgentsPath)) {
        files.add(file);
      }
    }
    return [...files];
  }

  async function readAppendixFiles(
    agentFiles: string[],
    generation: number,
    baseCwd: string,
  ): Promise<{ appendixFiles: AgentsFileEntry[]; failedFiles: FailedRead[] } | undefined> {
    const pendingFiles: { agentsPath: string; entry: AgentsFileEntry }[] = [];
    const failedFiles: FailedRead[] = [];
    for (const agentsPath of agentFiles) {
      if (loadedAgents.has(agentsPath)) continue;
      try {
        const content = await readFile(agentsPath);
        if (generation !== sessionGeneration) return undefined;
        if (loadedAgents.has(agentsPath)) continue;
        pendingFiles.push({
          agentsPath,
          entry: { path: relativePath(agentsPath, baseCwd), content: capFileContent(content) },
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

  const handleSessionChange = (
    _event: SessionStartEvent | SessionTreeEvent,
    ctx: { cwd: string },
  ): void => {
    resetSession(ctx.cwd);
  };
  pi.on("session_start", handleSessionChange);
  pi.on("session_tree", handleSessionChange);
  pi.on("session_shutdown", invalidateSession);

  pi.on("tool_result", async (event, ctx) => {
    ensureSession(ctx.cwd);
    const generation = sessionGeneration;
    const baseCwd = currentCwd;
    const rootAgentsPath = cwdAgentsPath;
    const discoveryEvents = codeModeDiscoveryEvents(event);
    if (event.isError) discoveryEvents.shift();

    const targets = discoveryEvents.flatMap((discoveryEvent) =>
      targetsForEvent(discoveryEvent, baseCwd),
    );
    if (!targets.length) return undefined;

    const agentFiles = agentsForTargets(targets, rootAgentsPath);
    if (!agentFiles.length) return undefined;

    const readResult = await readAppendixFiles(agentFiles, generation, baseCwd);
    if (generation !== sessionGeneration || !readResult) return undefined;
    const { appendixFiles, failedFiles } = readResult;

    if (generation !== sessionGeneration) return undefined;
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

    if (!appendixFiles.length) return undefined;

    if (generation !== sessionGeneration) return undefined;
    for (const file of appendixFiles) {
      pi.events?.emit("choco-pi-hooks:instructions-loaded", {
        filePath: resolvePath(file.path, baseCwd),
        memoryType: "Project",
        loadReason: "nested_traversal",
      });
    }

    return { content: appendAgentsContext(event.content, appendixFiles) };
  });
}
