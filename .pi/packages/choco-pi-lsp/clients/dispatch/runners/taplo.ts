import * as path from "node:path";
import { findLocalBinUpwards } from "../../package-manager.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	lspPrimaryCoversFile,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.js";

const taplo = createAvailabilityChecker("taplo", ".exe");

interface TaploError {
	range?: { start: { line: number; col: number } };
	message: string;
	kind: string;
}

interface TaploResult {
	errors?: TaploError[];
}

function parseTaploOutput(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as TaploResult;
		const errors = parsed.errors ?? [];

		return errors.map((err, idx) => ({
			id: `taplo-${err.kind}-${err.range?.start.line ?? idx}`,
			message: `[${err.kind}] ${err.message}`,
			filePath,
			line: (err.range?.start.line ?? 0) + 1,
			column: (err.range?.start.col ?? 0) + 1,
			severity: "error" as const,
			semantic: "blocking" as const,
			tool: "taplo",
			rule: err.kind,
			fixable: false,
		}));
	} catch {
		return [];
	}
}

const taploRunner: RunnerDefinition = {
	id: "taplo",
	appliesTo: ["toml"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("taplo")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// #233: the `toml` LSP server IS `taplo lsp` (same binary). When that LSP
		// covers this file, the warm server already produces these diagnostics —
		// skip the redundant CLI scan to avoid double-reporting. Stays active when
		// the LSP is disabled/unavailable so TOML coverage never regresses.
		if (lspPrimaryCoversFile(ctx, "toml") && (await ctx.hasTool("taplo"))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Project binary first (#1731, discipline B): `taplo.isAvailableAsync`
		// resolves through `findManagedNodeToolBinary`, pi-lens's own managed
		// shim — checked BEFORE any project-local candidate, so a project's own
		// `node_modules/.bin/taplo` (npm `@taplo/cli`) never won once the managed
		// copy answered. `findLocalBinUpwards` defaults to `.cmd` on Windows,
		// matching that npm shim; the availability checker's `.exe` extension is
		// correct for pi-lens's OWN managed install (a GitHub-release binary,
		// `clients/installer/index.ts` taplo entry), a different artifact with a
		// different extension, so it stays as the checker's fallback only.
		let cmd: string | null = findLocalBinUpwards("taplo", cwd) ?? null;
		if (!cmd) {
			if (await (taplo.isAvailableAsync(cwd))) {
				cmd = taplo.getCommand(cwd);
			} else {
				cmd = await resolveToolCommandWithInstallFallback(cwd, "taplo");
			}
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["check", "--output=json", absPath],
			{ cwd, timeout: 15000 },
		);

		if (spawnFailedWithNoOutput(result)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseTaploOutput(result.stdout || "", ctx.filePath);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return { status: "failed", diagnostics, semantic: "blocking" };
	},
};

export default taploRunner;
