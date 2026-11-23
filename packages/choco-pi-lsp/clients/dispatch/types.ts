import type { FileKind } from "../file-kinds.ts";
import type { FileRole } from "../file-role.ts";
import type { PiLensProjectConfig } from "../project-lsp-config.ts";

export type DefectClass =
  | "silent-error"
  | "injection"
  | "secrets"
  | "async-misuse"
  | "correctness"
  | "safety"
  | "style"
  | "unknown"
  | "unused-value";

export interface ModifiedRange {
  start: number;
  end: number;
}

export interface PiAgentAPI {
  getFlag(flag: string, filePath?: string): string | boolean | undefined;
}

export type OutputSemantic = "blocking" | "warning" | "fixed" | "silent" | "none";

export interface Diagnostic {
  id: string;
  message: string;
  filePath: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info" | "hint";
  semantic: OutputSemantic;
  tool: string;
  code?: string;
  rule?: string;
  defectClass?: DefectClass;
  fixable?: boolean;
  autoFixAvailable?: boolean;
  fixKind?: "pipeline" | "manual" | "suggestion";
  fixSuggestion?: string;
  matchedText?: string;
  astNodeType?: string;
  scanOrigin?: string;
}

export interface DispatchResult {
  diagnostics: Diagnostic[];
  blockers: Diagnostic[];
  warnings: Diagnostic[];
  baselineWarningCount: number;
  fixed: Diagnostic[];
  resolvedCount: number;
  output: string;
  blockerOutput: string;
  hasBlockers: boolean;
}

export type RunnerMode = "all" | "fallback" | "first-success";

export interface RunnerDefinition {
  id: string;
  appliesTo: readonly FileKind[];
  priority: number;
  enabledByDefault: boolean;
  skipTestFiles?: boolean;
  timeoutMs?: number;
  when?: (ctx: DispatchContext) => Promise<boolean> | boolean;
  run(ctx: DispatchContext): Promise<RunnerResult>;
}

export interface RunnerResult {
  status: "succeeded" | "failed" | "skipped";
  diagnostics: Diagnostic[];
  semantic: OutputSemantic;
  rawOutput?: string;
  failureKind?: string;
  failureMessage?: string;
}

export interface DispatchContext {
  readonly filePath: string;
  readonly projectRoot?: string;
  readonly cwd: string;
  readonly kind: FileKind | undefined;
  readonly fileRole: FileRole;
  readonly pi: PiAgentAPI;
  readonly autofix: boolean;
  readonly deltaMode: boolean;
  readonly facts: import("./fact-store.ts").FactStore;
  readonly projectConfig?: PiLensProjectConfig;
  readonly blockingOnly?: boolean;
  readonly modifiedRanges?: ModifiedRange[];
  readonly writeIndex?: number;
  readonly telemetryModel?: string;
  readonly telemetryProvider?: string;

  hasTool(command: string): Promise<boolean>;
  log(message: string): void;
}

export interface ToolPlan {
  name: string;
  groups: RunnerGroup[];
}

export interface RunnerGroup {
  mode: RunnerMode;
  runnerIds: string[];
  filterKinds?: readonly FileKind[];
  semantic?: OutputSemantic;
}

export interface RunnerRegistry {
  register(runner: RunnerDefinition): void;
  get(id: string): RunnerDefinition | undefined;
  getForKind(kind: FileKind, filePath?: string): RunnerDefinition[];
  list(): RunnerDefinition[];
  clear(): void;
}
