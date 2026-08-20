import fs from "node:fs";
import path from "node:path";

/** Resolve a possibly-relative path to an absolute, symlink-resolved path. */
export function resolvePath(targetPath: string, baseDir: string): string {
	const absolute = path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(baseDir, targetPath);
	try {
		return fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
	} catch {
		return absolute;
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
export function contentRootForTarget(targetPath: string): string {
	try {
		const startDir =
			fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
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
