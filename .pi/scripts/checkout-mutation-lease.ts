#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	readdir,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type Action = "acquire" | "status" | "release";

type LeaseMetadata = {
	owner: string;
	checkout: string;
	pid: number;
	acquiredAt: string;
};

type LiveSession = {
	sessionId: string;
	pid: number;
	updatedAt: string;
};

type OwnerSource = "flag" | "session-env" | "session-bridge" | "pid";

type Liveness = "live" | "dead" | "unknown";

/** A session-bridge record is treated as abandoned once its heartbeat stops well past the 2s write interval. */
const HEARTBEAT_STALE_MS = 60_000;
const MAX_ANCESTOR_DEPTH = 16;

const execFileAsync = promisify(execFile);

function option(name: string, fallback: string): string {
	const index = process.argv.indexOf(name);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function fail(message: string, details: Record<string, unknown> = {}): never {
	console.error(JSON.stringify({ status: "error", message, ...details }, null, 2));
	process.exit(2);
}

function isAction(value: string | undefined): value is Action {
	return value === "acquire" || value === "status" || value === "release";
}

function isLeaseMetadata(value: unknown): value is LeaseMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const metadata = value as Record<string, unknown>;
	return typeof metadata.owner === "string" &&
		typeof metadata.checkout === "string" &&
		typeof metadata.pid === "number" &&
		typeof metadata.acquiredAt === "string";
}

function liveSessionDir(): string {
	const override = process.env.CHOCO_PI_SESSION_BRIDGE_LIVE_DIR;
	if (override) return path.resolve(override);
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	return path.join(path.resolve(agentDir), "choco-pi", "session-bridge", "live");
}

/** Read the session-bridge live registry. A missing or unreadable entry is simply not reported. */
async function readLiveSessions(): Promise<LiveSession[]> {
	const directory = liveSessionDir();
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch {
		return [];
	}
	const sessions = await Promise.all(entries
		.filter((entry) => entry.endsWith(".json"))
		.map(async (entry): Promise<LiveSession | null> => {
			try {
				const value: unknown = JSON.parse(await readFile(path.join(directory, entry), "utf8"));
				if (!value || typeof value !== "object" || Array.isArray(value)) return null;
				const record = value as Record<string, unknown>;
				if (typeof record.sessionId !== "string" || typeof record.pid !== "number") return null;
				return {
					sessionId: record.sessionId,
					pid: record.pid,
					updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
				};
			} catch {
				return null;
			}
		}));
	return sessions.filter((session): session is LiveSession => session !== null);
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
	}
}

function isHeartbeatFresh(updatedAt: string): boolean {
	const timestamp = Date.parse(updatedAt);
	return Number.isFinite(timestamp) && Date.now() - timestamp <= HEARTBEAT_STALE_MS;
}

function isSessionLive(session: LiveSession): boolean {
	return isProcessAlive(session.pid) && isHeartbeatFresh(session.updatedAt);
}

/** Walk the parent chain so a command spawned by any tool can find the Pi process that owns it. */
async function ancestorPids(): Promise<number[]> {
	const pids: number[] = [];
	let current = process.pid;
	for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current > 1; depth += 1) {
		pids.push(current);
		try {
			const result = await execFileAsync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8" });
			const parent = Number.parseInt(result.stdout.trim(), 10);
			if (!Number.isInteger(parent) || parent <= 1 || pids.includes(parent)) break;
			current = parent;
		} catch {
			break;
		}
	}
	return pids;
}

/**
 * Resolve a caller identity that stays stable across separate script invocations.
 * `PI_SESSION_ID` is only exported by Pi's bash tool, so tools such as the Codex
 * adapter's exec_command need the session-bridge registry to identify the session.
 */
async function resolveOwner(sessions: LiveSession[]): Promise<{ owner: string; source: OwnerSource }> {
	const flag = option("--owner", "");
	if (flag) return { owner: flag, source: "flag" };
	const fromEnvironment = process.env.PI_SESSION_ID;
	if (fromEnvironment) return { owner: fromEnvironment, source: "session-env" };
	const ancestors = await ancestorPids();
	for (const pid of ancestors) {
		const session = sessions.find((candidate) => candidate.pid === pid && isSessionLive(candidate));
		if (session) return { owner: `session:${session.sessionId}`, source: "session-bridge" };
	}
	return { owner: `pid:${process.pid}`, source: "pid" };
}

/**
 * Report `dead` only when the holder is provably gone, so a lease is never
 * reclaimed from a session whose state cannot be observed.
 */
function ownerLiveness(leaseOwner: string, sessions: LiveSession[]): Liveness {
	if (leaseOwner.startsWith("pid:")) {
		return isProcessAlive(Number.parseInt(leaseOwner.slice(4), 10)) ? "live" : "dead";
	}
	const sessionId = leaseOwner.startsWith("session:") ? leaseOwner.slice(8) : leaseOwner;
	const session = sessions.find((candidate) => candidate.sessionId === sessionId);
	if (session) return isSessionLive(session) ? "live" : "dead";
	if (!leaseOwner.startsWith("session:")) return "unknown";
	return sessions.some(isSessionLive) ? "dead" : "unknown";
}

const actionValue = process.argv[2];
if (!isAction(actionValue)) {
	fail("usage: checkout-mutation-lease.ts <acquire|status|release> [--cwd path] [--owner id]");
}
const action: Action = actionValue;

const cwd = path.resolve(option("--cwd", process.cwd()));
const liveSessions = await readLiveSessions();
const { owner, source: ownerSource } = await resolveOwner(liveSessions);
let gitRoot: string;
try {
	const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	gitRoot = result.stdout.trim();
} catch {
	fail("current directory is not inside a Git worktree");
}

const checkout = await realpath(gitRoot);
const key = createHash("sha256").update(checkout).digest("hex").slice(0, 24);
const baseDir = path.resolve(process.env.CHOCO_PI_LEASE_DIR || path.join(tmpdir(), "choco-pi-checkout-mutation-leases"));
const leaseDir = path.join(baseDir, key);
const metadataPath = path.join(leaseDir, "owner.json");

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function readMetadata(): Promise<LeaseMetadata | null> {
	try {
		const value: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
		return isLeaseMetadata(value) ? value : null;
	} catch {
		return null;
	}
}

if (action === "status") {
	const metadata = await readMetadata();
	const leaseExists = await exists(leaseDir);
	console.log(JSON.stringify({
		status: metadata ? "held" : leaseExists ? "invalid" : "available",
		checkout,
		leaseDir,
		owner: metadata?.owner,
		acquiredAt: metadata?.acquiredAt,
		ownerLiveness: metadata ? ownerLiveness(metadata.owner, liveSessions) : undefined,
		caller: owner,
		callerSource: ownerSource,
	}, null, 2));
	process.exit(0);
}

if (action === "acquire") {
	await mkdir(baseDir, { recursive: true });
	let reclaimedFrom: string | undefined;
	if (await exists(leaseDir)) {
		const metadata = await readMetadata();
		if (metadata?.owner === owner && metadata.checkout === checkout) {
			console.log(JSON.stringify({ status: "held", checkout, leaseDir, owner, ownerSource }, null, 2));
			process.exit(0);
		}
		// Unreadable metadata can mean a lease is mid-creation, so it is never treated as abandoned.
		const liveness: Liveness = metadata ? ownerLiveness(metadata.owner, liveSessions) : "unknown";
		if (liveness !== "dead") {
			fail("checkout mutation lease is already held", {
				checkout,
				leaseDir,
				owner: metadata?.owner || "unknown",
				acquiredAt: metadata?.acquiredAt,
				ownerLiveness: liveness,
				caller: owner,
			});
		}
		// The holder is provably gone, so the abandoned lease is reclaimed instead of blocking every later session.
		reclaimedFrom = metadata?.owner || "unknown";
		await unlink(metadataPath).catch(() => undefined);
		await rmdir(leaseDir).catch(() => undefined);
	}

	try {
		await mkdir(leaseDir);
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
			const metadata = await readMetadata();
			fail("checkout mutation lease was acquired concurrently", {
				checkout,
				leaseDir,
				owner: metadata?.owner || "unknown",
				acquiredAt: metadata?.acquiredAt,
			});
		}
		throw error;
	}

	try {
		const metadata: LeaseMetadata = {
			owner,
			checkout,
			pid: process.pid,
			acquiredAt: new Date().toISOString(),
		};
		await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		console.log(JSON.stringify({ status: "acquired", checkout, leaseDir, owner, ownerSource, reclaimedFrom }, null, 2));
	} catch (error: unknown) {
		await rmdir(leaseDir);
		throw error;
	}
	process.exit(0);
}

if (!(await exists(leaseDir))) {
	console.log(JSON.stringify({ status: "available", checkout, leaseDir }, null, 2));
	process.exit(0);
}

const metadata = await readMetadata();
if (!metadata || metadata.owner !== owner || metadata.checkout !== checkout) {
	fail("cannot release a lease owned by another session", {
		checkout,
		leaseDir,
		owner: metadata?.owner || "unknown",
		caller: owner,
		callerSource: ownerSource,
	});
}

await unlink(metadataPath);
await rmdir(leaseDir);
console.log(JSON.stringify({ status: "released", checkout, leaseDir, owner, ownerSource }, null, 2));
