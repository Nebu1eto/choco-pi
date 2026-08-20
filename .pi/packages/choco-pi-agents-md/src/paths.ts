import fs from "node:fs";
import path from "node:path";

/** Resolve a possibly-relative path through its nearest existing ancestor. */
export function resolvePath(targetPath: string, baseDir: string): string {
	const absolute = path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(baseDir, targetPath);
	const missingSegments: string[] = [];
	let probe = absolute;
	for (;;) {
		try {
			const resolved = fs.realpathSync.native?.(probe) ?? fs.realpathSync(probe);
			return path.join(resolved, ...missingSegments);
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return absolute;
			missingSegments.unshift(path.basename(probe));
			probe = parent;
		}
	}
}

/** True when `targetPath` is `rootDir` itself or nested inside it. */
export function isInsideRoot(rootDir: string, targetPath: string): boolean {
	if (!rootDir) return false;
	const relative = path.relative(rootDir, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Find the boundary directory to search for AGENTS.md files above `targetPath`:
 * the nearest ancestor `.git` directory, or (failing that) the highest ancestor
 * that itself contains an AGENTS.md.
 */
export function contentRootForTarget(resolvedTargetPath: string): string {
	try {
		const startDir =
			fs.existsSync(resolvedTargetPath) && fs.statSync(resolvedTargetPath).isDirectory()
				? resolvedTargetPath
				: path.dirname(resolvedTargetPath);
		let dir = startDir;
		let best = "";
		for (;;) {
			if (fs.existsSync(path.join(dir, "AGENTS.md"))) best = dir;
			if (fs.existsSync(path.join(dir, ".git"))) return dir;
			const parent = path.dirname(dir);
			if (parent === dir) return best || startDir;
			dir = parent;
		}
	} catch {
		return "";
	}
}
