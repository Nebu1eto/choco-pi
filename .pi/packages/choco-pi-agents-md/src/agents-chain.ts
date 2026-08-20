import fs from "node:fs";
import path from "node:path";
import { isInsideRoot } from "./paths.ts";

/**
 * Walk from `filePath`'s directory up to (and including) `rootDir`, collecting
 * every existing `AGENTS.md` on the way, then return the chain ordered
 * root-first / leaf-last (so leaf-directory guidance appears closest to the
 * touched file when rendered).
 *
 * `cwdAgentsPath` is excluded: the session root's own AGENTS.md is already
 * part of the host's normal system-prompt context, so re-injecting it here
 * would be redundant.
 */
export function findAgentsFiles(filePath: string, rootDir: string, cwdAgentsPath: string): string[] {
	if (!rootDir) return [];
	const agentsFiles: string[] = [];
	let dir = path.dirname(filePath);
	while (isInsideRoot(rootDir, dir)) {
		const candidate = path.join(dir, "AGENTS.md");
		if (candidate !== cwdAgentsPath && fs.existsSync(candidate)) agentsFiles.push(candidate);
		if (dir === rootDir) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return agentsFiles.reverse();
}
