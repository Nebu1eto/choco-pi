import type { CascadeNeighborResult, CascadeRun } from "./cascade-types.ts";
import type { LSPDiagnostic } from "./lsp/client.ts";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.ts";
import { toRunnerDisplayPath } from "./dispatch/runner-context.ts";

export function formatCascadeNeighborDiagnostics(
  cwd: string,
  neighbors: CascadeNeighborResult[],
  options: { noun?: string; includeReason?: boolean } = {},
): string {
  const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
  const inconclusive = neighbors.filter(
    (n) => n.inconclusive === true && n.diagnostics.length === 0,
  );
  const uncovered = neighbors.filter(
    (n) =>
      n.diagnostics.length === 0 &&
      n.inconclusive !== true &&
      (n.unconfirmedServerIds?.length ?? 0) > 0,
  );
  if (withErrors.length === 0 && inconclusive.length === 0 && uncovered.length === 0) {
    return "";
  }

  const noun = options.noun ?? "neighbor";
  let out =
    withErrors.length > 0
      ? `📐 Cascade errors in ${withErrors.length} ${noun} file(s) — fix before finishing turn:`
      : "";
  for (const neighbor of withErrors) {
    const display = toRunnerDisplayPath(cwd, neighbor.filePath);
    const reason = options.includeReason ? ` reason="${neighbor.reason}"` : "";
    out += `\n<diagnostics file="${display}"${reason}>`;
    for (const d of neighbor.diagnostics) {
      const line = d.line ?? 1;
      const col = d.column ?? 1;
      const rule = d.rule ? ` rule=${d.rule}` : "";
      out += `\n  line ${line}, col ${col}${rule}: ${d.message.split("\n")[0].slice(0, 100)}`;
    }
    out += "\n</diagnostics>";
  }
  if (inconclusive.length > 0) {
    if (out) out += "\n";
    out += `⚠️ Cascade diagnostics inconclusive for ${inconclusive.length} ${noun} file(s) — no clean result was confirmed:`;
    for (const neighbor of inconclusive) {
      out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)}`;
    }
  }
  if (uncovered.length > 0) {
    if (out) out += "\n";
    out += `⚠️ Cascade scanners did not cover ${uncovered.length} ${noun} file(s) — no findings does NOT mean clean here:`;
    for (const neighbor of uncovered) {
      const servers = (neighbor.unconfirmedServerIds ?? []).join(", ");
      out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)} (not scanned by ${servers})`;
    }
  }
  return out;
}

export function buildResolvedFoundCascadeRun(
  cwd: string,
  neighbor: { filePath: string; diagnostics: LSPDiagnostic[] },
): CascadeRun | undefined {
  const { filePath } = neighbor;
  const diagnostics = convertLspDiagnostics(
    neighbor.diagnostics.filter((d) => d.severity === 1),
    filePath,
    { tool: "lsp" },
  );
  if (diagnostics.length === 0) return undefined;
  const neighbors: CascadeNeighborResult[] = [
    { filePath, reason: "references", diagnostics, lspTouched: true },
  ];
  const formatted = formatCascadeNeighborDiagnostics(cwd, neighbors, {
    noun: "cold neighbor",
  });
  if (!formatted) return undefined;
  return {
    filePath,
    result: {
      filePath,
      impact: {
        filePath,
        changedSymbols: [],
        directImporters: [],
        directCallers: [],
        neighborFiles: [filePath],
        riskFlags: [],
      },
      neighbors,
      formatted,
    },
    neighborCount: 1,
    diagnosticCount: diagnostics.length,
  };
}
