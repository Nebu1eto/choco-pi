/**
 * Local risk ordering and noise folding for review diffs.
 *
 * User `riskPatterns` and `collapsePatterns` use case-insensitive path
 * substrings. Paths are normalized to forward slashes before matching. This
 * intentionally avoids a glob or regular-expression dialect that is easy to
 * mistype in JSON. User patterns add to the built-in rules; they never replace
 * them. Empty patterns are ignored.
 *
 * Format-only hunks are folded only for file types whose grammar does not use
 * whitespace for block structure. Python, YAML, Makefiles, shell scripts, and
 * other unknown formats remain expanded. This is deliberately conservative:
 * showing formatting noise is safer than hiding a semantic indentation change.
 */
import type {
	DiffFile,
	DiffHunk,
	DiffModel,
	FileAssessment,
	HunkAssessment,
	ResolvedReviewConfig,
} from "./types.ts";

export type DiffAssessment = {
	/** Assessments in the same order as `DiffModel.files`. */
	files: FileAssessment[];
	/** Hunk assessments in file and hunk input order. */
	hunks: HunkAssessment[];
	/** File paths sorted by descending risk, preserving input order for ties. */
	reviewOrder: string[];
};

type RiskSignal = { score: number; reason: string };

const FORMAT_SAFE_EXTENSIONS = new Set([
	"c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "json", "jsx",
	"kt", "kts", "less", "m", "mm", "php", "rb", "rs", "scss", "sql", "swift", "toml", "ts", "tsx",
	"vue", "xml",
]);

function normalizedPath(path: string): string {
	return path.replaceAll("\\", "/").toLowerCase();
}

function pathSegments(path: string): string[] {
	return normalizedPath(path).split("/");
}

function hasSegment(path: string, segments: ReadonlySet<string>): boolean {
	return pathSegments(path).some((segment) => segments.has(segment));
}

function changedText(file: DiffFile): string {
	return file.hunks
		.flatMap((hunk) => hunk.lines)
		.filter((line) => line.kind !== "context")
		.map((line) => line.text)
		.join("\n")
		.toLowerCase();
}

function firstFileLines(file: DiffFile, limit = 20): string[] {
	const lines = file.hunks.flatMap((hunk) => hunk.lines);
	lines.sort((left, right) => (left.newLine ?? left.oldLine ?? Number.MAX_SAFE_INTEGER) - (right.newLine ?? right.oldLine ?? Number.MAX_SAFE_INTEGER));
	return lines.slice(0, limit).map((line) => line.text);
}

function isGenerated(file: DiffFile): boolean {
	return firstFileLines(file).some((line) =>
		/(?:code generated .* do not edit|@generated\b|automatically generated|generated file.*do not edit)/i.test(line),
	);
}

function isMinified(file: DiffFile): boolean {
	const path = normalizedPath(file.path);
	if (/\.min\.(?:css|js|mjs|cjs)$/.test(path)) return true;
	if (!/\.(?:css|js|mjs|cjs)$/.test(path)) return false;
	const changed = file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context");
	return changed.length > 0 && changed.some((line) => line.text.length >= 500);
}

function isSnapshot(path: string): boolean {
	const normalized = normalizedPath(path);
	return normalized.endsWith(".snap") || normalized.includes("/__snapshots__/");
}

function isTestSource(path: string): boolean {
	if (isSnapshot(path)) return false;
	const normalized = normalizedPath(path);
	const name = normalized.split("/").at(-1) ?? normalized;
	return normalized.includes("/test/") || normalized.includes("/tests/") || normalized.includes("/__tests__/") ||
		/(?:^|[._-])(?:test|spec)\.[^.]+$/.test(name);
}

function isRenameOnly(file: DiffFile): boolean {
	return file.kind === "renamed" && file.hunks.length === 0 && file.additions === 0 && file.deletions === 0;
}

function extension(path: string): string | undefined {
	const name = normalizedPath(path).split("/").at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : undefined;
}

function whitespaceNormalized(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function isFormatOnlyHunk(path: string, hunk: DiffHunk): boolean {
	const ext = extension(path);
	if (!ext || !FORMAT_SAFE_EXTENSIONS.has(ext)) return false;
	const changedLines = hunk.lines.filter((line) => line.kind !== "context");
	// Whitespace inside strings and template literals is data, even in a
	// whitespace-insensitive language. Without a language parser, keep it open.
	if (changedLines.some((line) => /["'`]/.test(line.text))) return false;
	const removed = changedLines.filter((line) => line.kind === "del").map((line) => whitespaceNormalized(line.text));
	const added = changedLines.filter((line) => line.kind === "add").map((line) => whitespaceNormalized(line.text));
	return removed.length > 0 && added.length > 0 &&
		removed.length === added.length && removed.every((line, index) => line === added[index]);
}

function builtInCollapseReason(file: DiffFile): string | undefined {
	const path = normalizedPath(file.path);
	const name = path.split("/").at(-1) ?? path;
	if (file.kind === "binary") return "Binary file has no reviewable text";
	if (isRenameOnly(file)) return "Rename-only change has no textual edits";
	if (/^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|composer\.lock|gemfile\.lock|poetry\.lock|pdm\.lock|uv\.lock|go\.sum|pubspec\.lock|mix\.lock)$/.test(name)) {
		return "Dependency lockfile is generated resolution output";
	}
	if (isGenerated(file)) return "File carries a standard generated-code header";
	if (isMinified(file)) return "Minified bundle is not practical to review line by line";
	if (hasSegment(path, new Set(["vendor", "vendored", "third_party", "node_modules"]))) return "Vendored dependency path";
	if (hasSegment(path, new Set(["dist", "build", "out", "target", "coverage"]))) return "Build output path";
	if (isSnapshot(path)) return "Test snapshot output";
	return undefined;
}

function riskSignals(file: DiffFile): RiskSignal[] {
	const path = normalizedPath(file.path);
	const name = path.split("/").at(-1) ?? path;
	const text = changedText(file);
	const haystack = `${path}\n${text}`;
	const signals: RiskSignal[] = [];
	if (/\b(?:auth|authentication|authorization|authorisation|oauth|sso|login|session|permission|permissions|rbac|acl)\b/.test(haystack)) {
		signals.push({ score: 45, reason: "Authentication, authorization, or permission logic changed" });
	}
	if (/\b(?:crypto|cryptography|cipher|encrypt|decrypt|hashing|hmac|jwt|secret|secrets|credential|credentials|private[_ -]?key|api[_ -]?key)\b/.test(haystack)) {
		signals.push({ score: 45, reason: "Cryptography or secret-handling code changed" });
	}
	if (/(?:^|\/)(?:migrations?|schema)(?:\/|\.|$)/.test(path) || /\b(?:alter table|create table|drop table|schema migration)\b/.test(text)) {
		signals.push({ score: 40, reason: "Database migration or schema changed" });
	}
	if (/\b(?:payment|payments|billing|checkout|invoice|stripe|refund|subscription)\b/.test(haystack)) {
		signals.push({ score: 40, reason: "Payment or billing path changed" });
	}
	if (isTestSource(path) && (file.kind === "deleted" || (file.deletions > 0 && file.additions === 0))) {
		signals.push({ score: 40, reason: file.kind === "deleted" ? "Test file was deleted" : "Test file may have been emptied" });
	}
	if (/^(?:package\.json|deno\.jsonc?|pyproject\.toml|requirements(?:-[^.]+)?\.txt|pipfile|cargo\.toml|go\.mod|composer\.json|gemfile|pubspec\.yaml|mix\.exs)$/.test(name)) {
		signals.push({ score: 25, reason: "Dependency manifest changed" });
	}
	if (path.startsWith(".github/workflows/") || path.includes("/.github/workflows/") || /^(?:dockerfile(?:\..+)?|compose\.ya?ml|docker-compose\.ya?ml|\.env(?:\..+)?|\.gitlab-ci\.ya?ml)$/.test(name) ||
		/(?:^|\/)(?:ci|containers?|k8s|kubernetes)(?:\/|$)/.test(path)) {
		signals.push({ score: 25, reason: "CI, container, or environment configuration changed" });
	}
	if (file.deletions >= 250 && file.deletions >= file.additions * 2) {
		signals.push({ score: 30, reason: `Unusually large deletion (${file.deletions} lines removed)` });
	}
	return signals;
}

/** Assess every file and hunk without performing I/O or mutating the model. */
export function assessDiff(model: DiffModel, config: ResolvedReviewConfig): DiffAssessment {
	const hunks: HunkAssessment[] = [];
	const files = model.files.map((file) => {
		const signals = riskSignals(file);
		const path = normalizedPath(file.path);
		for (const pattern of config.heuristics.riskPatterns) {
			const normalizedPattern = normalizedPath(pattern.trim());
			if (normalizedPattern && path.includes(normalizedPattern)) {
				signals.push({ score: 35, reason: `Matched user risk pattern: ${pattern}` });
			}
		}

		const formatOnly = file.hunks.map((hunk) => isFormatOnlyHunk(file.path, hunk));
		file.hunks.forEach((hunk, index) => hunks.push(formatOnly[index]
			? { hunkId: hunk.id, collapsed: true, reason: "Added and removed text differs only by normalized whitespace" }
			: { hunkId: hunk.id, collapsed: false }));

		let collapseReason = builtInCollapseReason(file);
		if (!collapseReason) {
			const matched = config.heuristics.collapsePatterns.find((pattern) => {
				const normalizedPattern = normalizedPath(pattern.trim());
				return normalizedPattern.length > 0 && path.includes(normalizedPattern);
			});
			if (matched !== undefined) collapseReason = `Matched user collapse pattern: ${matched}`;
		}
		if (!collapseReason && formatOnly.length > 0 && formatOnly.every(Boolean)) {
			collapseReason = "Every textual hunk differs only by normalized whitespace";
		}

		const riskScore = signals.reduce((total, signal) => total + signal.score, 0);
		const inherentlyUnreviewable = file.kind === "binary" || isRenameOnly(file);
		const collapsed = Boolean(collapseReason) && (riskScore === 0 || inherentlyUnreviewable);
		return {
			path: file.path,
			riskScore,
			reasons: signals.map((signal) => signal.reason),
			collapsed,
			...(collapsed ? { collapseReason } : {}),
		} satisfies FileAssessment;
	});

	const reviewOrder = files
		.map((file, index) => ({ path: file.path, score: file.riskScore, index }))
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map(({ path }) => path);
	return { files, hunks, reviewOrder };
}
