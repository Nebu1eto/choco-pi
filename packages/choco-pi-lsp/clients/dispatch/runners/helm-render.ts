import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bool, obj, opt, compile } from "@earendil-works/pi-schema";
import { logLatency } from "../../latency-logger.ts";
import { PathKeyedMap } from "../../path-keyed-map.ts";
import { normalizeMapKey } from "../../path-utils.ts";
import { loadPiLensProjectConfig } from "../../project-lsp-config.ts";
import { getProjectTrustState, projectTrustDenialReason } from "../../project-trust.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { findNearestDirWithMarker } from "../../workspace-topology.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { describeUnavailability } from "./utils/availability-policy.ts";
import { failedResult, isWithin } from "./utils/helm-shared.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";

const helm = createAvailabilityChecker("helm", ".exe");

const inFlightByChartRoot = new PathKeyedMap<Promise<RunnerResult>>(normalizeMapKey);

const RENDER_TIMEOUT_MS = 30_000;
const MAX_RENDERED_FILES = 400;

const HelmConfigSchema = obj(
  {
    helm: opt(
      obj(
        {
          renderValidation: opt(obj({ enabled: opt(bool()) }, { open: true })),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
const isHelmConfig = compile(HelmConfigSchema).check;

interface RenderedSourceMapping {
  filePath: string;
  mapped: boolean;
}

interface RenderedFileCollection {
  files: string[];
  truncated: boolean;
}

interface RenderedTree {
  manifests: RenderedManifest[];
  truncated: boolean;
  unreadable: number;
}

interface RenderPassMetadata {
  [key: string]: string | number | boolean | undefined;
}

const SKIPPED: RunnerResult = {
  status: "skipped",
  diagnostics: [],
  semantic: "none",
};

export function isHelmRenderEnabled(workspaceRoot: string): boolean {
  try {
    const config = loadPiLensProjectConfig(workspaceRoot);
    if (!isHelmConfig(config.raw)) return false;
    return config.raw.helm?.renderValidation?.enabled === true;
  } catch {
    return false;
  }
}

export function resolveTemplateSource(
  sourceRef: string,
  chartRoot: string,
  realChartRoot?: string,
): string | null {
  const segments = sourceRef.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments.length < 2) return null;
  const candidate = path.resolve(chartRoot, ...segments.slice(1));
  if (!isWithin(chartRoot, candidate)) return null;
  try {
    if (!fs.lstatSync(candidate).isFile()) return null;
    const root = realChartRoot ?? fs.realpathSync(chartRoot);
    if (!isWithin(root, fs.realpathSync(candidate))) return null;
  } catch {
    return null;
  }
  return candidate;
}

function canonicalChartRoot(chartRoot: string): string {
  try {
    return fs.realpathSync(chartRoot);
  } catch {
    return chartRoot;
  }
}

function chartYaml(chartRoot: string): string {
  return path.join(chartRoot, "Chart.yaml");
}

const HELM_INSTALL_HINT = "https://helm.sh/docs/intro/install/";

const SOURCE_ANNOTATION = /^#\s*Source:\s*(\S+)\s*$/m;

const TEMPLATE_EXTENSION = /\.(?:ya?ml|tpl)$/i;

export function extractTemplateRef(line: string): { ref: string; line?: number } | null {
  for (const token of line.split(/[\s(),<>"']+/)) {
    const parts = token.split(":");
    const ref = parts[0];
    if (!ref.includes("/")) continue;
    if (!TEMPLATE_EXTENSION.test(ref)) continue;
    const lineNumber = /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : undefined;
    return { ref, line: lineNumber };
  }
  return null;
}

export function mapRenderedToSource(options: {
  renderedContent: string;
  renderedPath: string;
  outputDir: string;
  chartRoot: string;
  realChartRoot?: string;
}): RenderedSourceMapping {
  const { chartRoot, realChartRoot } = options;
  const annotation = SOURCE_ANNOTATION.exec(options.renderedContent);
  if (annotation) {
    const resolved = resolveTemplateSource(annotation[1], chartRoot, realChartRoot);
    if (resolved) return { filePath: resolved, mapped: true };
  }
  const relative = path.relative(options.outputDir, options.renderedPath);
  if (relative && !relative.startsWith("..")) {
    const resolved = resolveTemplateSource(relative, chartRoot, realChartRoot);
    if (resolved) return { filePath: resolved, mapped: true };
  }
  return { filePath: chartYaml(chartRoot), mapped: false };
}

export function parseHelmTemplateFailure(raw: string, chartRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const text = raw.trim();
  const realRoot = canonicalChartRoot(chartRoot);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Error:")) continue;
    const location = extractTemplateRef(trimmed);
    const resolved = location ? resolveTemplateSource(location.ref, chartRoot, realRoot) : null;
    const chartName = path.basename(chartRoot);
    diagnostics.push({
      id: `helm-render-error-${diagnostics.length + 1}`,
      message: resolved ? trimmed : `${trimmed} (helm template failed for chart ${chartName})`,
      filePath: resolved ?? chartYaml(chartRoot),
      line: resolved ? (location?.line ?? 1) : 1,
      column: 1,
      severity: "error",
      semantic: "blocking",
      tool: "helm-render",
      rule: "render-failed",
      fixable: false,
    });
  }
  if (diagnostics.length === 0) {
    diagnostics.push({
      id: "helm-render-error-1",
      message: `helm template failed: ${(text || "no output").slice(0, 400)}`,
      filePath: chartYaml(chartRoot),
      line: 1,
      column: 1,
      severity: "error",
      semantic: "blocking",
      tool: "helm-render",
      rule: "render-failed",
      fixable: false,
    });
  }
  return diagnostics;
}

export function validateRenderedManifests(options: {
  renderedContent: string;
  renderedRelativePath: string;
  sourcePath: string;
  sourceMapped: boolean;
}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const documents = options.renderedContent.split(/^---\s*$/m);
  documents.forEach((document, index) => {
    const meaningful = document
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    if (meaningful.length === 0) return;
    const missing: string[] = [];
    if (!/^apiVersion:\s*\S/m.test(document)) missing.push("apiVersion");
    if (!/^kind:\s*\S/m.test(document)) missing.push("kind");
    if (missing.length === 0) return;
    const where = options.sourceMapped
      ? `rendered ${options.renderedRelativePath}`
      : `rendered ${options.renderedRelativePath} (source template could not be resolved)`;
    diagnostics.push({
      id: `helm-render-shape-${options.renderedRelativePath}-${index}`,
      message: `Rendered document ${index + 1} is missing ${missing.join(" and ")} — it is not a Kubernetes object (${where}).`,
      filePath: options.sourcePath,
      line: 1,
      column: 1,
      severity: "warning",
      semantic: "warning",
      tool: "helm-render",
      rule: "manifest-shape",
      fixable: false,
    });
  });
  return diagnostics;
}

export { validateRenderedManifests as "checkManifestShape" };

function helmUnavailableResult(cwd: string): RunnerResult {
  const verdict = helm.getVerdict(cwd);
  return {
    status: "failed",
    diagnostics: [],
    semantic: "warning",
    failureKind: "unavailable",
    failureMessage: describeUnavailability({
      tool: "helm",
      installHint: HELM_INSTALL_HINT,
      outcome: verdict.outcome,
      cause: verdict.cause,
      elapsedMs: verdict.elapsedMs,
      retryAfterMs: verdict.retryAtMs ? Math.max(0, verdict.retryAtMs - Date.now()) : undefined,
    }).slice(0, 300),
  };
}

const OUR_RENDER_FLAGS = ["--output-dir"] as const;

export function rejectedOurInvocation(output: string): string | null {
  if (!output) return null;
  const complaint =
    /unknown flag|unknown shorthand flag|flag provided but not defined|unknown command|unrecognized (?:flag|option)/i.test(
      output,
    );
  if (!complaint) return null;
  for (const flag of OUR_RENDER_FLAGS) {
    if (output.includes(flag)) return flag;
  }
  return null;
}

function spawnFailureKind(result: {
  failure?: string;
  spawnFailure?: { kind?: string };
}): string | null {
  const typed = result.spawnFailure?.kind;
  if (typed === "tool-not-found") return "unavailable";
  if (typed === "timeout" || result.failure === "timeout") return "timeout";
  if (typed === "killed" || result.failure === "aborted") return "aborted";
  if (result.failure) return "server_error";
  return null;
}

function collectRenderedFiles(root: string): RenderedFileCollection {
  const files: string[] = [];
  const stack = [root];
  let truncated = false;
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        if (files.length >= MAX_RENDERED_FILES) {
          truncated = true;
          break;
        }
        files.push(full);
      }
    }
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    truncated,
  };
}

function summarize(diagnostics: Diagnostic[]): RunnerResult {
  let semantic: RunnerResult["semantic"] = "none";
  if (diagnostics.some((item) => item.severity === "error")) {
    semantic = "blocking";
  } else if (diagnostics.length > 0) {
    semantic = "warning";
  }
  return { status: "succeeded", diagnostics, semantic };
}

interface RenderedManifest {
  renderedPath: string;
  relativePath: string;
  content: string;
  sourcePath: string;
  sourceMapped: boolean;
}

function readRenderedTree(outputDir: string, chartRoot: string): RenderedTree {
  const manifests: RenderedManifest[] = [];
  const walk = collectRenderedFiles(outputDir);
  const realChartRoot = canonicalChartRoot(chartRoot);
  let unreadable = 0;
  for (const renderedPath of walk.files) {
    let content: string;
    try {
      content = fs.readFileSync(renderedPath, "utf-8");
    } catch {
      unreadable += 1;
      continue;
    }
    const mapping = mapRenderedToSource({
      renderedContent: content,
      renderedPath,
      outputDir,
      chartRoot,
      realChartRoot,
    });
    manifests.push({
      renderedPath,
      relativePath: path.relative(outputDir, renderedPath),
      content,
      sourcePath: mapping.filePath,
      sourceMapped: mapping.mapped,
    });
  }
  return { manifests, truncated: walk.truncated, unreadable };
}

type CoverageRule =
  | "iac-pass-unavailable"
  | "iac-pass-failed"
  | "iac-report-unreadable"
  | "render-truncated"
  | "rendered-file-unreadable"
  | "render-empty"
  | "render-untrusted";

function coverageGap(chartRoot: string, rule: CoverageRule, message: string): Diagnostic {
  return {
    id: `helm-render-${rule}`,
    message,
    filePath: chartYaml(chartRoot),
    line: 1,
    column: 1,
    severity: "info",
    semantic: "warning",
    tool: "helm-render",
    rule,
    fixable: false,
  };
}

function logRenderPass(
  filePath: string,
  chartRoot: string,
  startedAt: number,
  metadata: RenderPassMetadata,
): void {
  logLatency({
    type: "phase",
    phase: "helm_render_pass",
    filePath,
    durationMs: Date.now() - startedAt,
    metadata: { chartRoot, ...metadata },
  });
}

export function discardScratchDir(
  outputDir: string,
  filePath: string,
  remove: (target: string) => void = (target) =>
    fs.rmSync(target, { recursive: true, force: true }),
): void {
  try {
    remove(outputDir);
  } catch (error) {
    logLatency({
      type: "phase",
      phase: "helm_render_scratch_leak",
      filePath,
      durationMs: 0,
      metadata: {
        outputDir,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function renderAndValidate(
  chartRoot: string,
  cwd: string,
  filePath: string,
): Promise<RunnerResult> {
  const startedAt = Date.now();
  const helmCmd = await resolveAvailableOrInstall(helm, "helm", cwd);
  if (!helmCmd) return helmUnavailableResult(cwd);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "choco-pi-lsp-helm-render-"));
  try {
    const render = await safeSpawnAsync(
      helmCmd,
      ["template", "choco-pi-lsp-render", chartRoot, "--output-dir", outputDir],
      {
        cwd,
        timeout: RENDER_TIMEOUT_MS,
        deadlineAt: Date.now() + RENDER_TIMEOUT_MS,
        resourceLabel: "helm-render",
      },
    );

    const startupFailure = spawnFailureKind(render);
    if (startupFailure) {
      logRenderPass(filePath, chartRoot, startedAt, {
        outcome: "runner-failed",
        failureKind: startupFailure,
      });
      return failedResult(
        startupFailure,
        render.error?.message || `helm template ${startupFailure}`,
      );
    }
    const renderOutput = [render.stdout, render.stderr].filter(Boolean).join("\n");
    if (render.status !== 0) {
      const ourFlag = rejectedOurInvocation(renderOutput);
      if (ourFlag) {
        logRenderPass(filePath, chartRoot, startedAt, {
          outcome: "runner-failed",
          failureKind: "invocation_rejected",
          flag: ourFlag,
        });
        return failedResult(
          "invocation_rejected",
          `helm rejected choco-pi-lsp's own invocation (${ourFlag}); this is a helm/choco-pi-lsp compatibility problem, not a chart defect: ${renderOutput.trim().slice(0, 160)}`,
        );
      }
      const diagnostics = parseHelmTemplateFailure(renderOutput, chartRoot);
      if (render.outputTruncated) {
        diagnostics.push(
          coverageGap(
            chartRoot,
            "render-truncated",
            "helm template output was truncated, so this failure report may be incomplete.",
          ),
        );
      }
      logRenderPass(filePath, chartRoot, startedAt, {
        outcome: "render-failed",
        diagnostics: diagnostics.length,
      });
      return summarize(diagnostics);
    }

    const tree = readRenderedTree(outputDir, chartRoot);
    const diagnostics: Diagnostic[] = [];
    for (const manifest of tree.manifests) {
      diagnostics.push(
        ...validateRenderedManifests({
          renderedContent: manifest.content,
          renderedRelativePath: manifest.relativePath,
          sourcePath: manifest.sourcePath,
          sourceMapped: manifest.sourceMapped,
        }),
      );
    }
    if (tree.truncated) {
      diagnostics.push(
        coverageGap(
          chartRoot,
          "render-truncated",
          `This chart rendered more than ${MAX_RENDERED_FILES} manifests; only the first ${MAX_RENDERED_FILES} were validated, so the rest are UNCHECKED rather than clean.`,
        ),
      );
    }
    if (tree.unreadable > 0) {
      diagnostics.push(
        coverageGap(
          chartRoot,
          "rendered-file-unreadable",
          `${tree.unreadable} rendered manifest(s) could not be read back from the scratch directory and are UNCHECKED rather than clean.`,
        ),
      );
    }
    if (tree.manifests.length === 0) {
      diagnostics.push(
        coverageGap(
          chartRoot,
          "render-empty",
          "helm template succeeded but produced no manifests to validate, so this chart is UNVALIDATED rather than clean. Check whether the chart's values disable every template.",
        ),
      );
    }

    const iacRequested = false;
    logRenderPass(filePath, chartRoot, startedAt, {
      outcome: "rendered",
      manifests: tree.manifests.length,
      truncated: tree.truncated,
      unreadable: tree.unreadable,
      iacRequested,
      diagnostics: diagnostics.length,
    });
    return summarize(diagnostics);
  } finally {
    discardScratchDir(outputDir, filePath);
  }
}

const helmRenderRunner: RunnerDefinition = {
  id: "helm-render",
  appliesTo: ["yaml", "helm-template"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,
  timeoutMs: RENDER_TIMEOUT_MS + 10_000,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const workspaceRoot = path.resolve(ctx.projectRoot ?? cwd);

    if (!isHelmRenderEnabled(workspaceRoot)) return SKIPPED;

    const startDir = path.dirname(path.resolve(ctx.filePath));
    const discovered = findNearestDirWithMarker(startDir, "chartYamlPath");
    if (!discovered) return SKIPPED;
    const chartRoot = path.resolve(discovered);
    if (!isWithin(workspaceRoot, chartRoot)) return SKIPPED;

    if (getProjectTrustState() === "untrusted") {
      logRenderPass(ctx.filePath, chartRoot, Date.now(), {
        outcome: "refused-untrusted",
      });
      return summarize([
        coverageGap(
          chartRoot,
          "render-untrusted",
          `Helm rendered-manifest validation did not run: ${projectTrustDenialReason() ?? "project trust denied"}. Rendering executes this chart's own templates, so it needs host trust in addition to the \`helm.renderValidation.enabled\` switch — and that switch is a tracked file a cloned repository can set for itself.`,
        ),
      ]);
    }

    const existing = inFlightByChartRoot.get(chartRoot);
    if (existing) return existing;
    const promise = renderAndValidate(chartRoot, cwd, ctx.filePath).finally(() => {
      if (inFlightByChartRoot.get(chartRoot) === promise) inFlightByChartRoot.delete(chartRoot);
    });
    inFlightByChartRoot.set(chartRoot, promise);
    return promise;
  },
};

export default helmRenderRunner;
