import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { findAgentsFiles } from "./agents-chain.ts";
import { type AgentsFileEntry, appendAgentsContext, capFileContent, capTotalAppendixSize } from "./appendix.ts";
import { contentRootForTarget, resolvePath } from "./paths.ts";
import { isDiscoveryShellCommand, shellTargets } from "./shell-targets.ts";
import { codeModeDiscoveryEvents, type DiscoveryToolResultEvent } from "./tool-events.ts";

const PATH_DISCOVERY_TOOLS = new Set(["grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "exec", "exec_command", "shell"]);
const MAX_OUTPUT_SCAN_LINES = 250;

interface FailedRead {
	agentsPath: string;
	error: Error;
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
export function registerAgentsMdAutoload(pi: ExtensionAPI): void {
	const loadedAgents = new Set<string>();
	let currentCwd = "";
	let cwdAgentsPath = "";

	function resetSession(cwd: string): void {
		currentCwd = resolvePath(cwd, process.cwd());
		cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
		loadedAgents.clear();
		loadedAgents.add(cwdAgentsPath);
	}

	function ensureSession(cwd: string): void {
		if (!currentCwd) resetSession(cwd);
	}

	function relativePath(absolutePath: string): string {
		const relative = currentCwd ? path.relative(currentCwd, absolutePath) : absolutePath;
		return (relative || absolutePath).replaceAll("\\", "/");
	}

	function outputPathCandidate(line: string, toolName: string): string | undefined {
		if (toolName !== "grep") return line;
		const match = line.match(/^(.+?):\d+(?::\d+)?:/);
		return match?.[1] ?? line.split(":", 1)[0] ?? line;
	}

	function looksPathLike(value: string | undefined): value is string {
		return Boolean(value) && !value!.includes("\0") && !value!.startsWith("<");
	}

	function pathsFromToolText(content: (TextContent | ImageContent)[], base: string, toolName: string): string[] {
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
		const workdir = ["workdir", "cwd", "working_directory"]
			.map((key) => input[key])
			.find((value): value is string => typeof value === "string");
		const eventCwd = workdir !== undefined ? resolvePath(workdir, baseCwd) : baseCwd;
		const pathInput = typeof input["path"] === "string" ? input["path"] : undefined;

		if (event.toolName === "read") {
			return [pathInput ? resolvePath(pathInput, eventCwd) : eventCwd];
		}
		if (PATH_DISCOVERY_TOOLS.has(event.toolName)) {
			const base = pathInput ? resolvePath(pathInput, eventCwd) : eventCwd;
			return [base, ...pathsFromToolText(event.content, base, event.toolName)];
		}
		if (SHELL_TOOLS.has(event.toolName)) {
			const command =
				typeof input["command"] === "string"
					? input["command"]
					: typeof input["cmd"] === "string"
						? input["cmd"]
						: undefined;
			if (!command || !isDiscoveryShellCommand(command)) return [];
			return shellTargets(command, eventCwd);
		}
		return [];
	}

	function agentsForTargets(targets: string[]): string[] {
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
			for (const file of findAgentsFiles(probe, searchRoot, cwdAgentsPath)) {
				files.add(file);
			}
		}
		return [...files];
	}

	async function readAppendixFiles(
		agentFiles: string[],
	): Promise<{ appendixFiles: AgentsFileEntry[]; failedFiles: FailedRead[] }> {
		const appendixFiles: AgentsFileEntry[] = [];
		const failedFiles: FailedRead[] = [];
		for (const agentsPath of agentFiles) {
			if (loadedAgents.has(agentsPath)) continue;
			try {
				const content = await fs.promises.readFile(agentsPath, "utf-8");
				loadedAgents.add(agentsPath);
				appendixFiles.push({ path: relativePath(agentsPath), content: capFileContent(content) });
			} catch (error) {
				if (error instanceof Error) failedFiles.push({ agentsPath, error });
			}
		}
		return { appendixFiles: capTotalAppendixSize(appendixFiles), failedFiles };
	}

	const handleSessionChange = (_event: unknown, ctx: { cwd: string }): void => {
		resetSession(ctx.cwd);
	};
	pi.on("session_start", handleSessionChange);
	pi.on("session_tree", handleSessionChange);

	pi.on("tool_result", async (event, ctx) => {
		ensureSession(ctx.cwd);
		const discoveryEvents = codeModeDiscoveryEvents(event);
		if (event.isError) discoveryEvents.shift();

		const targets = discoveryEvents.flatMap((discoveryEvent) => targetsForEvent(discoveryEvent, currentCwd));
		if (!targets.length) return undefined;

		const agentFiles = agentsForTargets(targets);
		if (!agentFiles.length) return undefined;

		const { appendixFiles, failedFiles } = await readAppendixFiles(agentFiles);

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

		return { content: appendAgentsContext(event.content, appendixFiles) };
	});
}
