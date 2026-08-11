#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type Action = "acquire" | "status" | "release";

type LeaseMetadata = {
	owner: string;
	checkout: string;
	pid: number;
	acquiredAt: string;
};

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

const actionValue = process.argv[2];
if (!isAction(actionValue)) {
	fail("usage: checkout-mutation-lease.ts <acquire|status|release> [--cwd path] [--owner id]");
}
const action: Action = actionValue;

const cwd = path.resolve(option("--cwd", process.cwd()));
const owner = option("--owner", process.env.PI_SESSION_ID || `pid:${process.pid}`);
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
	}, null, 2));
	process.exit(0);
}

if (action === "acquire") {
	await mkdir(baseDir, { recursive: true });
	if (await exists(leaseDir)) {
		const metadata = await readMetadata();
		if (metadata?.owner === owner && metadata.checkout === checkout) {
			console.log(JSON.stringify({ status: "held", checkout, leaseDir, owner }, null, 2));
			process.exit(0);
		}
		fail("checkout mutation lease is already held", {
			checkout,
			leaseDir,
			owner: metadata?.owner || "unknown",
			acquiredAt: metadata?.acquiredAt,
		});
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
		console.log(JSON.stringify({ status: "acquired", checkout, leaseDir, owner }, null, 2));
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
	});
}

await unlink(metadataPath);
await rmdir(leaseDir);
console.log(JSON.stringify({ status: "released", checkout, leaseDir, owner }, null, 2));
