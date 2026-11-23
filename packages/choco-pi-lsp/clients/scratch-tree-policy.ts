import { EXCLUDED_DIRS, getExcludedDirGlobs } from "./file-utils.ts";

function literalExcludedDirNames(): string[] {
  return EXCLUDED_DIRS.filter((name) => !name.includes("*") && !name.includes("?"));
}

export function getScratchTreeGlobPatterns(): string[] {
  return getExcludedDirGlobs();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getScratchTreeDirNames(): string[] {
  return literalExcludedDirNames();
}

export function getScratchTreeFnmatchPatterns(): string[] {
  return literalExcludedDirNames().map((name) => `*/${name}/*`);
}

export const SECRETS_LANE_SCRATCH_DIR_NAMES: readonly string[] = [
  ".pi",
  ".choco-pi-lsp",
  ".claude",
  ".codex",
  ".agents",
  ".worktrees",
  ".rescue",
  ".gstack",
  ".superpowers",
  ".guardrails",
  ".playwright-cli",
  ".playwright-mcp",
  ".git",
  "node_modules",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".svelte-kit",
  ".nuxt",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".next",
  ".ruff_cache",
  ".tox",
  ".pytest_cache",
  "venv",
  ".venv",
  "__pycache__",
];

export function getSecretsLaneAllowlistPaths(): string[] {
  return SECRETS_LANE_SCRATCH_DIR_NAMES.map((name) => {
    const escaped = escapeRegExp(name);
    return `(?:^|[/\\\\])${escaped}(?:[/\\\\].*)?$`;
  });
}

export function isUnderSecretsLaneScratchTree(relPath: string): boolean {
  const names = new Set(SECRETS_LANE_SCRATCH_DIR_NAMES.map((n) => n.toLowerCase()));
  const segments = relPath.split(/[/\\]/).filter(Boolean);
  return segments.some((segment) => names.has(segment.toLowerCase()));
}
