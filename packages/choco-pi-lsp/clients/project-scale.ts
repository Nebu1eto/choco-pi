import { lazyEnvNumber, toPositiveFinite } from "./env-utils.ts";
import { loadPiLensProjectConfig } from "./project-lsp-config.ts";

export const DEFAULT_PROJECT_SCALE_BASE = 2_000;

const _envBase = lazyEnvNumber("CHOCO_PI_LSP_MAX_PROJECT_FILES", DEFAULT_PROJECT_SCALE_BASE);

export function _resetProjectScaleBaseForTests(): void {
  _envBase._resetForTests();
}

export function getProjectScaleBase(cwd?: string): number {
  if (cwd) {
    const config = loadPiLensProjectConfig(cwd);
    const configBase = toPositiveFinite(config.maxProjectFiles);
    if (configBase > 0) return Math.floor(configBase);
  }
  return _envBase.get();
}

export const PROJECT_SCALE_RATIOS = {
  projectDiagnosticsScanner: 0.25,
  reviewGraph: 0.5,
  startupScan: 1,
  jscpd: 3,
  wordIndex: 3,
} as const;

export function deriveBudget(ratio: number, cwd?: string): number {
  return Math.max(1, Math.round(getProjectScaleBase(cwd) * ratio));
}

export function getProjectDiagnosticsScannerMaxFiles(cwd?: string): number {
  return deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner, cwd);
}

export const REVIEW_GRAPH_LINEAR_CEILING_BASE = 4_000;

export const REVIEW_GRAPH_TAPER_SCALE = 8_000;

export const REVIEW_GRAPH_HARD_CEILING = 5_000;

export function taperedReviewGraphMaxFiles(base: number): number {
  const linearValue = base * PROJECT_SCALE_RATIOS.reviewGraph;
  if (base <= REVIEW_GRAPH_LINEAR_CEILING_BASE) {
    return Math.max(1, Math.round(linearValue));
  }
  const boundaryValue = REVIEW_GRAPH_LINEAR_CEILING_BASE * PROJECT_SCALE_RATIOS.reviewGraph;
  const excess = base - REVIEW_GRAPH_LINEAR_CEILING_BASE;
  const taperedExtra =
    (REVIEW_GRAPH_HARD_CEILING - boundaryValue) * (excess / (excess + REVIEW_GRAPH_TAPER_SCALE));
  return Math.max(1, Math.round(boundaryValue + taperedExtra));
}

export function getReviewGraphMaxFilesDerived(cwd?: string): number {
  if (cwd) {
    const config = loadPiLensProjectConfig(cwd);
    const configOverride = config.reviewGraph?.maxFiles;
    if (configOverride !== undefined) return configOverride;
  }
  return taperedReviewGraphMaxFiles(getProjectScaleBase(cwd));
}

export function getStartupScanMaxSourceFilesDerived(cwd?: string): number {
  return deriveBudget(PROJECT_SCALE_RATIOS.startupScan, cwd);
}

export function getJscpdMaxEntriesDerived(cwd?: string): number {
  return deriveBudget(PROJECT_SCALE_RATIOS.jscpd, cwd);
}

export function getWordIndexMaxFilesDerived(cwd?: string): number {
  return deriveBudget(PROJECT_SCALE_RATIOS.wordIndex, cwd);
}
