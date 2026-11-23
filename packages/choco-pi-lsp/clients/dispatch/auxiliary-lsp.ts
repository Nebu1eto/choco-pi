import type { LSPDiagnostic } from "../lsp/client.ts";
import { shouldDegradeAuxiliaryLsp } from "../lsp-budget.ts";
import { isSubagentSession } from "../subagent-mode.ts";
import type { FileRole } from "../file-role.ts";
import { findLocalOpengrepConfig } from "../opengrep-config.ts";
import { findLocalTyposConfig } from "../typos-config.ts";
import { findLocalZizmorConfig } from "../zizmor-config.ts";
import { classifyDefect } from "./diagnostic-taxonomy.ts";
import type { DefectClass, Diagnostic, OutputSemantic } from "./types.ts";

export interface AuxiliaryLspProfile {
  serverId: string;
  tool: string;
  sourceMatch: RegExp;
  killSwitchFlag?: string;
  enabledByDefault: boolean;
  allowBlocking?: (cwd: string) => boolean;
  semantic: (d: LSPDiagnostic, ctx: { blockingAllowed: boolean }) => OutputSemantic;
  defectClass?: (d: LSPDiagnostic) => DefectClass | undefined;
  isSuppressed?: (d: LSPDiagnostic, content: string) => boolean;
  skipTestFiles?: boolean;
}

const NOSEMGREP_RE = /(?:#|\/\/)\s*nosemgrep(?::\s*(.+))?/i;
const NOSEMGREP_STANDALONE_RE = /^\s*(?:#|\/\/)\s*nosemgrep(?::\s*(.+))?\s*$/i;
export function isNosemgrepSuppressed(d: LSPDiagnostic, content: string): boolean {
  const startLine = d.range?.start?.line;
  if (startLine == null) return false;
  const lines = content.split("\n");
  const ruleId = String(d.code ?? "");
  const checkLine = (text: string | undefined, standaloneOnly: boolean): boolean => {
    if (!text) return false;
    const m = (standaloneOnly ? NOSEMGREP_STANDALONE_RE : NOSEMGREP_RE).exec(text);
    if (!m) return false;
    if (m[1] === undefined) return true;
    return m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(ruleId);
  };
  return checkLine(lines[startLine], false) || checkLine(lines[startLine - 1], true);
}

const ZIZMOR_IGNORE_RE = /#\s*zizmor:\s*ignore\[([^\]]+)\]/i;
export function isZizmorIgnoreSuppressed(d: LSPDiagnostic, content: string): boolean {
  const startLine = d.range?.start?.line;
  if (startLine == null) return false;
  const line = content.split("\n")[startLine];
  if (!line) return false;
  const match = ZIZMOR_IGNORE_RE.exec(line);
  if (!match) return false;
  const ruleId = String(d.code ?? "").toLowerCase();
  return match[1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(ruleId);
}

const blockOnErrorWhenAllowed = (
  d: LSPDiagnostic,
  { blockingAllowed }: { blockingAllowed: boolean },
): OutputSemantic => (blockingAllowed && d.severity === 1 ? "blocking" : "warning");

export const AUXILIARY_LSP_PROFILES: readonly AuxiliaryLspProfile[] = [
  {
    serverId: "opengrep",
    tool: "opengrep",
    sourceMatch: /opengrep|semgrep/i,
    killSwitchFlag: "no-opengrep",
    enabledByDefault: true,
    allowBlocking: (cwd) => Boolean(findLocalOpengrepConfig(cwd)),
    semantic: blockOnErrorWhenAllowed,
    defectClass: (d) => classifyDefect(String(d.code ?? ""), "opengrep", d.message ?? ""),
    isSuppressed: isNosemgrepSuppressed,
  },
  {
    serverId: "ast-grep",
    tool: "ast-grep",
    sourceMatch: /ast[-_]?grep/i,
    killSwitchFlag: "no-ast-grep",
    enabledByDefault: true,
    skipTestFiles: true,
    allowBlocking: () => true,
    semantic: blockOnErrorWhenAllowed,
    defectClass: (d) => classifyDefect(String(d.code ?? ""), "ast-grep", d.message ?? ""),
  },
  {
    serverId: "zizmor",
    tool: "zizmor",
    sourceMatch: /zizmor/i,
    killSwitchFlag: "no-zizmor",
    enabledByDefault: true,
    allowBlocking: (cwd) => Boolean(findLocalZizmorConfig(cwd)),
    semantic: blockOnErrorWhenAllowed,
    defectClass: (d) => classifyDefect(String(d.code ?? ""), "zizmor", d.message ?? ""),
    isSuppressed: isZizmorIgnoreSuppressed,
  },
  {
    serverId: "typos",
    tool: "typos",
    sourceMatch: /typos/i,
    killSwitchFlag: "no-typos",
    enabledByDefault: true,
    allowBlocking: (cwd) => Boolean(findLocalTyposConfig(cwd)),
    semantic: blockOnErrorWhenAllowed,
    defectClass: () => "style",
  },
];

export type GetFlag = (flag: string) => boolean | string | undefined;

export function enabledAuxiliaryLspServerIds(getFlag: GetFlag): string[] {
  if (shouldDegradeAuxiliaryLsp() || isSubagentSession()) return [];
  return AUXILIARY_LSP_PROFILES.flatMap((p) =>
    p.enabledByDefault && !(p.killSwitchFlag && getFlag(p.killSwitchFlag) === true)
      ? [p.serverId]
      : [],
  );
}

const profileForSourceCache = new Map<string, AuxiliaryLspProfile | undefined>();

export function findAuxiliaryProfileForSource(
  source: string | undefined,
): AuxiliaryLspProfile | undefined {
  if (!source) return undefined;
  const cached = profileForSourceCache.get(source);
  if (cached !== undefined || profileForSourceCache.has(source)) return cached;
  const found = AUXILIARY_LSP_PROFILES.find((p) => p.sourceMatch.test(source));
  profileForSourceCache.set(source, found);
  return found;
}

export function isAuxiliaryDiagnosticSuppressed(d: LSPDiagnostic, content: string): boolean {
  const profile = findAuxiliaryProfileForSource(d.source);
  return Boolean(profile?.isSuppressed?.(d, content));
}

export function applyAuxiliarySuppressions(
  diagnostics: readonly LSPDiagnostic[],
  content: string,
  opts?: { fileRole?: FileRole },
): LSPDiagnostic[] {
  return diagnostics.filter((d) => {
    if (isAuxiliaryDiagnosticSuppressed(d, content)) return false;
    if (opts?.fileRole === "test") {
      const profile = findAuxiliaryProfileForSource(d.source);
      if (profile?.skipTestFiles) return false;
    }
    return true;
  });
}

export function retagAuxiliaryDiagnostics(
  diagnostics: Diagnostic[],
  rawLspDiags: readonly LSPDiagnostic[],
  content: string,
  ctx: { cwd: string; fileRole: FileRole },
): Diagnostic[] {
  const blockingAllowedByProfile = new Map<AuxiliaryLspProfile, boolean>();
  const suppressedIndices = new Set<number>();
  for (let i = 0; i < diagnostics.length; i++) {
    const profile = findAuxiliaryProfileForSource(rawLspDiags[i]?.source);
    if (!profile) continue;
    if (profile.skipTestFiles && ctx.fileRole === "test") {
      suppressedIndices.add(i);
      continue;
    }
    if (isAuxiliaryDiagnosticSuppressed(rawLspDiags[i], content)) {
      suppressedIndices.add(i);
      continue;
    }
    let blockingAllowed = blockingAllowedByProfile.get(profile);
    if (blockingAllowed === undefined) {
      blockingAllowed = profile.allowBlocking?.(ctx.cwd) ?? false;
      blockingAllowedByProfile.set(profile, blockingAllowed);
    }
    const d = diagnostics[i];
    d.tool = profile.tool;
    d.semantic = profile.semantic(rawLspDiags[i], { blockingAllowed });
    if (d.semantic !== "blocking" && d.severity === "error") {
      d.severity = "warning";
    }
    const defectClass = profile.defectClass?.(rawLspDiags[i]);
    if (defectClass) d.defectClass = defectClass;
  }
  return suppressedIndices.size
    ? diagnostics.filter((_, i) => !suppressedIndices.has(i))
    : diagnostics;
}
