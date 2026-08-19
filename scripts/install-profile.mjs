import { constants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROFILE_LINKS = [
	[".pi/SYSTEM.md", "SYSTEM.md"],
	[".pi/writing-policy.md", "writing-policy.md"],
	[".pi/review-policy.md", "review-policy.md"],
	[".pi/pi-codex-conversion.json", "pi-codex-conversion.json"],
	[".pi/subagents.json", "subagents.json"],
	[".pi/zentui.json", "zentui.json"],
	[".pi/models.json", "models.json"],
	[".pi/keybindings.json", "keybindings.json"],
	[".pi/agents/general.md", "agents/general.md"],
	[".pi/agents/planner.md", "agents/planner.md"],
	[".pi/agents/implementer.md", "agents/implementer.md"],
	[".pi/agents/reviewer.md", "agents/reviewer.md"],
	[".pi/agents/handoff.md", "agents/handoff.md"],
	[".pi/agents/explore.md", "agents/explore.md"],
	[".pi/extensions/apex-provider.json", "extensions/apex-provider.json"],
	[".pi/extensions/context-cap.json", "extensions/context-cap.json"],
	[".pi/extensions/review.json", "extensions/review.json"],
];

async function exists(target) {
	try {
		await access(target, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function readJson(target, fallback) {
	if (!await exists(target)) return fallback;
	return JSON.parse(await readFile(target, "utf8"));
}

function unique(values) {
	return [...new Set(values)];
}

function packageIdentity(spec) {
	if (path.isAbsolute(spec) && spec.endsWith(`${path.sep}.pi${path.sep}packages${path.sep}pi-synthetic`)) {
		return "local:pi-synthetic";
	}
	if (spec === "./packages/pi-synthetic") return "local:pi-synthetic";
	if (path.isAbsolute(spec) && spec.endsWith(`${path.sep}.pi${path.sep}packages${path.sep}pi-zentui`)) {
		return "local:pi-zentui";
	}
	if (spec === "./packages/pi-zentui") return "local:pi-zentui";
	if (spec.startsWith("npm:")) return `npm:${npmPackageName(spec.slice(4))}`;
	return spec;
}

function npmPackageName(raw) {
	if (raw.startsWith("@")) {
		const slash = raw.indexOf("/");
		const versionAt = slash === -1 ? -1 : raw.indexOf("@", slash);
		return versionAt === -1 ? raw : raw.slice(0, versionAt);
	}
	const versionAt = raw.indexOf("@");
	return versionAt === -1 ? raw : raw.slice(0, versionAt);
}

function specVersion(spec) {
	if (!spec.startsWith("npm:")) return undefined;
	const match = spec.slice(4).match(/@(\d[^@/]*)$/);
	return match?.[1];
}

function compareSpecVersions(left, right) {
	const leftVersion = specVersion(left);
	const rightVersion = specVersion(right);
	if (leftVersion === undefined || rightVersion === undefined) return 0;
	const leftParts = leftVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const rightParts = rightVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function mergePackages(canonical, existing) {
	const canonicalIds = new Set(canonical.map(packageIdentity));
	const extras = new Map();
	for (const spec of existing) {
		const identity = packageIdentity(spec);
		if (canonicalIds.has(identity)) continue;
		const current = extras.get(identity);
		if (current === undefined || compareSpecVersions(spec, current) > 0) extras.set(identity, spec);
	}
	return unique([...canonical, ...extras.values()]);
}

export function buildGlobalSettings(projectSettings, existingSettings, root) {
	const canonicalPackages = projectSettings.packages.map((spec) =>
		spec.startsWith("./") ? path.resolve(root, ".pi", spec) : spec,
	);
	const rooted = (name) => path.resolve(root, ".pi", name);
	return {
		...existingSettings,
		...projectSettings,
		packages: mergePackages(canonicalPackages, existingSettings.packages ?? []),
		extensions: unique([rooted("extensions"), ...(existingSettings.extensions ?? [])]),
		skills: unique([rooted("skills"), ...(existingSettings.skills ?? [])]),
		prompts: unique([rooted("prompts"), ...(existingSettings.prompts ?? [])]),
	};
}

function backupPath(target) {
	const stamp = new Date().toISOString().replaceAll(":", "-");
	return `${target}.backup-${stamp}`;
}

async function sameFileContents(left, right) {
	try {
		return (await readFile(left)).equals(await readFile(right));
	} catch {
		return false;
	}
}

async function linkConflict(source, target) {
	try {
		const status = await lstat(target);
		if (status.isSymbolicLink()) {
			const current = path.resolve(path.dirname(target), await readlink(target));
			return current === source ? undefined : target;
		}
		if (status.isFile() && await sameFileContents(source, target)) return undefined;
		return target;
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function installLink(source, target, backup) {
	await mkdir(path.dirname(target), { recursive: true });
	try {
		const status = await lstat(target);
		if (status.isSymbolicLink()) {
			const current = path.resolve(path.dirname(target), await readlink(target));
			if (current === source) return { target, action: "unchanged" };
		} else if (status.isFile() && await sameFileContents(source, target)) {
			await rm(target);
			await symlink(source, target);
			return { target, action: "linked" };
		}

		if (!backup) {
			throw new Error(`${target} already exists; rerun with --backup to preserve and replace it`);
		}
		const saved = backupPath(target);
		await rename(target, saved);
		try {
			await symlink(source, target);
		} catch (error) {
			await rename(saved, target);
			throw error;
		}
		return { target, action: "backed-up", backup: saved };
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await symlink(source, target);
		return { target, action: "linked" };
	}
}

async function writeSettings(target, settings) {
	await mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, target);
}

export async function installProfile({
	root = SCRIPT_ROOT,
	agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
	backup = false,
} = {}) {
	const projectSettings = await readJson(path.join(root, ".pi", "settings.json"));
	const settingsPath = path.join(agentDir, "settings.json");
	const existingSettings = await readJson(settingsPath, {});
	// MCP configuration is deliberately not linked. Pi reads ~/.pi/agent/mcp.json and a
	// project .pi/mcp.json as separate sources, so linking a repo-local copy registers every
	// server twice when Pi runs from this checkout, and the ignored file disappearing leaves
	// Pi with no servers at all. Keep the real file at ~/.pi/agent/mcp.json.
	const links = [...PROFILE_LINKS];
	if (!backup) {
		for (const [sourceRelative, targetRelative] of links) {
			const target = path.resolve(agentDir, targetRelative);
			if (await linkConflict(path.resolve(root, sourceRelative), target)) {
				throw new Error(`${target} already exists; rerun with --backup to preserve and replace it`);
			}
		}
	}

	const results = [];
	for (const [sourceRelative, targetRelative] of links) {
		results.push(await installLink(
			path.resolve(root, sourceRelative),
			path.resolve(agentDir, targetRelative),
			backup,
		));
	}
	await writeSettings(settingsPath, buildGlobalSettings(projectSettings, existingSettings, root));
	return { agentDir, settingsPath, links: results };
}

function parseArgs(args) {
	const options = { backup: false };
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--backup") options.backup = true;
		else if (argument === "--agent-dir" && args[index + 1]) options.agentDir = path.resolve(args[++index]);
		else throw new Error(`unknown or incomplete argument: ${argument}`);
	}
	return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await installProfile(parseArgs(process.argv.slice(2)));
		for (const link of result.links) {
			const suffix = link.backup ? ` (backup: ${link.backup})` : "";
			console.log(`${link.action}: ${link.target}${suffix}`);
		}
		console.log(`updated: ${result.settingsPath}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
