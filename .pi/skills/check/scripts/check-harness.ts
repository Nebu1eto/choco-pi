#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

type NpmSpec = {
	name?: string;
	version?: string | null;
	invalid?: string;
};

type Settings = {
	packages?: unknown;
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

function parseNpmSpec(spec: unknown): NpmSpec | null {
	if (typeof spec !== "string") return { invalid: String(spec) };
	if (!spec.startsWith("npm:")) return null;
	const value = spec.slice(4);
	const separator = value.lastIndexOf("@");
	const name = separator <= 0 ? value : value.slice(0, separator);
	const version = separator <= 0 ? null : value.slice(separator + 1);
	const validName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
	return validName ? { name, version } : { invalid: value };
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
	if (!Array.isArray(settings.packages)) {
		add("packages", "fail", "settings.packages must be an array");
	} else {
		const parsedSpecs = settings.packages.map(parseNpmSpec).filter((spec): spec is NpmSpec => spec !== null);
		const invalidSpecs = parsedSpecs.flatMap((spec) => spec.invalid ? [spec.invalid] : []);
		const specs = parsedSpecs.filter((spec): spec is NpmSpec & { name: string } => typeof spec.name === "string");
		const packageResults = await Promise.all(specs.map(async (spec) => {
			const manifestPath = path.join(configRoot, "npm", "node_modules", spec.name, "package.json");
			try {
				const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
				const installedVersion = isRecord(manifest) && typeof manifest.version === "string"
					? manifest.version
					: undefined;
				return spec.version && installedVersion !== spec.version
					? { mismatch: `${spec.name}: expected ${spec.version}, found ${installedVersion ?? "unknown"}` }
					: {};
			} catch {
				return { missing: spec.name };
			}
		}));
		const missing = packageResults.flatMap((result) => result.missing ? [result.missing] : []);
		const mismatched = packageResults.flatMap((result) => result.mismatch ? [result.mismatch] : []);
		const detail = [
			missing.length ? `missing: ${missing.join(", ")}` : "all configured packages installed",
			mismatched.length ? `version mismatch: ${mismatched.join("; ")}` : null,
			invalidSpecs.length ? `invalid package specs: ${invalidSpecs.join(", ")}` : null,
		].filter((value): value is string => value !== null).join("; ");
		add("packages", missing.length || mismatched.length || invalidSpecs.length ? "fail" : "pass", detail);
	}
}

const subagentsSettingsPath = path.join(configRoot, "subagents.json");
try {
	const parsed: unknown = JSON.parse(await readFile(subagentsSettingsPath, "utf8"));
	if (!isRecord(parsed)) throw new Error("subagents.json must contain an object");
	const subagents = parsed as SubagentsSettings;
	const valid = subagents.disableDefaultAgents === true && subagents.fallbackSubagent === "none";
	add(
		"subagents",
		valid ? "pass" : "fail",
		valid ? "custom roles only; unknown roles fail closed" : "expected disableDefaultAgents=true and fallbackSubagent=none",
	);
} catch (error: unknown) {
	add("subagents", "fail", error instanceof Error ? error.message : String(error));
}

const requiredResources = [
	"SYSTEM.md",
	"extensions/apex-provider.ts",
	"extensions/apex-provider.json",
	"extensions/command-filter.ts",
	"extensions/runtime-model-prompt.ts",
	"extensions/runtime-writing-prompt.ts",
	"extensions/model-context-cap.ts",
	"extensions/context-cap.json",
	"extensions/model-controls.ts",
	"extensions/session-aliases.ts",
	"extensions/session-bridge.ts",
	"extensions/file-checkpoints.ts",
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
	"prompts/review.md",
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

const browserResult = await run("agent-browser", ["--version"]);
add(
	"agent-browser",
	browserResult.status === 0 ? "pass" : "warn",
	browserResult.status === 0 ? browserResult.stdout.trim() : "optional native browser runtime is unavailable",
);

const overall: CheckStatus = checks.some((check) => check.status === "fail")
	? "fail"
	: checks.some((check) => check.status === "warn") ? "warn" : "pass";

console.log(JSON.stringify({ status: overall, configRoot, checks }, null, 2));
process.exitCode = overall === "fail" ? 1 : 0;
