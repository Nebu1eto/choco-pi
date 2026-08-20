#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

type CheckStatus = "pass" | "warn" | "fail";

type Check = {
	id: string;
	status: CheckStatus;
	detail: string;
};

type RunResult = {
	status: number;
	stdout: string;
	stderr: string;
};

type Settings = {
	packages?: unknown;
	tuiMode?: unknown;
};

type SubagentsSettings = {
	disableDefaultAgents?: unknown;
	fallbackSubagent?: unknown;
};

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configRoot = path.resolve(scriptDir, "../../..");
const checks: Check[] = [];

function add(id: string, status: CheckStatus, detail: string): void {
	checks.push({ id, status, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function run(command: string, args: string[]): Promise<RunResult> {
	try {
		const result = await execFileAsync(command, args, { encoding: "utf8", timeout: 10_000 });
		return { status: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error: unknown) {
		const value = isRecord(error) ? error : {};
		return {
			status: typeof value.code === "number" ? value.code : 1,
			stdout: typeof value.stdout === "string" ? value.stdout : "",
			stderr: typeof value.stderr === "string" ? value.stderr : "",
		};
	}
}

function numericVersion(value: string): number[] {
	return value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function atLeast(actual: string, expected: string): boolean {
	const left = numericVersion(actual);
	const right = numericVersion(expected);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		if ((left[index] || 0) !== (right[index] || 0)) {
			return (left[index] || 0) > (right[index] || 0);
		}
	}
	return true;
}

function hasPiEntryPoint(manifest: Record<string, unknown>): boolean {
	if (!isRecord(manifest.pi)) return false;
	return Object.values(manifest.pi).some((value) =>
		Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.length > 0));
}

const nodeVersion = process.version;
add("node", atLeast(nodeVersion, "24.0.0") ? "pass" : "fail", `${nodeVersion}; required >=24`);

const piVersionResult = await run("pi", ["--version"]);
if (piVersionResult.status !== 0) {
	add("pi", "fail", "pi executable is unavailable");
} else {
	const piVersion = piVersionResult.stdout.trim();
	add("pi", atLeast(piVersion, "0.84.1") ? "pass" : "fail", `${piVersion}; required >=0.84.1`);
}

let settings: Settings | undefined;
const settingsPath = path.join(configRoot, "settings.json");
try {
	const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
	if (!isRecord(parsed)) throw new Error("settings.json must contain an object");
	settings = parsed;
	add("settings", "pass", settingsPath);
} catch (error: unknown) {
	add("settings", "fail", error instanceof Error ? error.message : String(error));
}

if (settings) {
	add(
		"tui-mode",
		settings.tuiMode === "fullscreen" ? "pass" : "fail",
		settings.tuiMode === "fullscreen"
			? "fullscreen application-owned scrolling enabled"
			: "expected tuiMode=fullscreen for stable multiplexed-terminal scrolling",
	);

	if (!Array.isArray(settings.packages)) {
		add("packages", "fail", "settings.packages must be an array");
	} else {
		const packageResults = await Promise.all(settings.packages.map(async (spec) => {
			if (typeof spec !== "string" || !/^\.\/packages\/[^/]+$/.test(spec)) {
				return { error: `${String(spec)}: expected ./packages/<name>` };
			}
			const manifestPath = path.resolve(configRoot, spec, "package.json");
			try {
				const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
				if (!isRecord(manifest)) return { error: `${spec}: package.json must contain an object` };
				if (!hasPiEntryPoint(manifest)) return { error: `${spec}: package.json has no pi entry point` };
				return {};
			} catch (error: unknown) {
				return { error: `${spec}: ${error instanceof Error ? error.message : String(error)}` };
			}
		}));
		const errors = packageResults.flatMap((result) => result.error ? [result.error] : []);
		add(
			"packages",
			errors.length ? "fail" : "pass",
			errors.length ? errors.join("; ") : "all configured local packages have valid Pi manifests",
		);
	}
}

const subagentsSettingsPath = path.join(configRoot, "subagents.json");
try {
	const parsed: unknown = JSON.parse(await readFile(subagentsSettingsPath, "utf8"));
	if (!isRecord(parsed)) throw new Error("subagents.json must contain an object");
	const subagents = parsed as SubagentsSettings;
	const valid = subagents.disableDefaultAgents === true && subagents.fallbackSubagent === "none";
	const roleFiles = ["general", "planner", "implementer", "reviewer", "handoff"];
	const roleResults = await Promise.all(roleFiles.map(async (role) => {
		const content = await readFile(path.join(configRoot, "agents", `${role}.md`), "utf8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		const defaultsPresent = typeof frontmatter.default_model === "string"
			&& typeof frontmatter.default_thinking === "string";
		const runtimePinsAbsent = frontmatter.model === undefined && frontmatter.thinking === undefined;
		return { role, valid: defaultsPresent && runtimePinsAbsent };
	}));
	const invalidRoles = roleResults.filter((result) => !result.valid).map((result) => result.role);
	const rolesValid = invalidRoles.length === 0;
	add(
		"subagents",
		valid && rolesValid ? "pass" : "fail",
		valid && rolesValid
			? "custom roles fail closed; model and thinking defaults remain spawn-overridable"
			: [
				valid ? null : "expected disableDefaultAgents=true and fallbackSubagent=none",
				rolesValid ? null : `locked or missing role defaults: ${invalidRoles.join(", ")}`,
			].filter((value): value is string => value !== null).join("; "),
	);
} catch (error: unknown) {
	add("subagents", "fail", error instanceof Error ? error.message : String(error));
}

const requiredResources = [
	"../tsconfig.json",
	"../package.json",
	"../pnpm-lock.yaml",
	"../pnpm-workspace.yaml",
	"../scripts/install-profile.mjs",
	"../scripts/install-profile.d.mts",
	"SYSTEM.md",
	"choco-pi-codex.json",
	"zentui.json",
	"extensions/apex-provider.ts",
	"extensions/apex-provider.json",
	"extensions/command-filter.ts",
	"extensions/context-status.ts",
	"extensions/runtime-model-prompt.ts",
	"extensions/runtime-writing-prompt.ts",
	"extensions/model-context-cap.ts",
	"extensions/context-cap.json",
	"extensions/review.json",
	"extensions/review/index.ts",
	"extensions/model-controls.ts",
	"extensions/session-aliases.ts",
	"extensions/session-bridge.ts",
	"extensions/tool-search.ts",
	"extensions/file-checkpoints.ts",
	"extensions/exec-session-guidance.ts",
	"extensions/provider-usage.ts",
	"review-policy.md",
	"writing-policy.md",
	"subagents.json",
	"agents/general.md",
	"agents/planner.md",
	"agents/implementer.md",
	"agents/reviewer.md",
	"agents/handoff.md",
	"skills/check/SKILL.md",
	"skills/task-inline/SKILL.md",
	"skills/task/SKILL.md",
	"skills/task-hotfix/SKILL.md",
	"skills/commit/SKILL.md",
	"skills/review/SKILL.md",
	"skills/check/scripts/check-harness.ts",
	"scripts/checkout-mutation-lease.ts",
	"prompts/check.md",
	"prompts/task-inline.md",
	"prompts/task.md",
	"prompts/task-hotfix.md",
	"prompts/commit.md",
	"prompts/review-agent.md",
];
const resourceResults = await Promise.all(requiredResources.map(async (entry) => ({
	entry,
	exists: await exists(path.join(configRoot, entry)),
})));
const missingResources = resourceResults.filter((result) => !result.exists).map((result) => result.entry);
add(
	"resources",
	missingResources.length ? "fail" : "pass",
	missingResources.length ? `missing: ${missingResources.join(", ")}` : "system prompt, agents, workflows, and command aliases present",
);

const lspRoot = path.join(configRoot, "packages", "choco-pi-lsp");
try {
	const manifest: unknown = JSON.parse(await readFile(path.join(lspRoot, "package.json"), "utf8"));
	const version = isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
	const grammarPresent = await exists(path.join(lspRoot, "grammars", "tree-sitter-typescript.wasm"));
	const astGrepPresent = await exists(path.join(lspRoot, "node_modules", "@ast-grep", "napi"));
	const valid = version === "0.1.0" && grammarPresent && astGrepPresent;
	add(
		"choco-pi-lsp",
		valid ? "pass" : "fail",
		valid
			? `choco-pi-lsp ${version}; semantic tools available`
			: [
				version === "0.1.0" ? null : `expected version 0.1.0, found ${version ?? "unknown"}`,
				grammarPresent ? null : "tree-sitter-typescript.wasm is missing",
				astGrepPresent ? null : "@ast-grep/napi is missing",
			].filter((value): value is string => value !== null).join("; "),
	);
} catch (error: unknown) {
	add("choco-pi-lsp", "fail", error instanceof Error ? error.message : String(error));
}

const overall: CheckStatus = checks.some((check) => check.status === "fail")
	? "fail"
	: checks.some((check) => check.status === "warn") ? "warn" : "pass";

console.log(JSON.stringify({ status: overall, configRoot, checks }, null, 2));
process.exitCode = overall === "fail" ? 1 : 0;
