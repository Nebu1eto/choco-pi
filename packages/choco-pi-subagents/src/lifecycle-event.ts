import type { AgentRecord } from "./types.ts";

export function buildLifecycleMetadata(record: AgentRecord) {
  const model = record.session?.model ?? record.spawnModel;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    toolCallId: record.toolCallId ?? null,
    outputFile: record.outputFile ?? null,
    parentAgentId: record.parentAgentId ?? null,
    model: model ? `${model.provider}/${model.id}` : null,
    cwd: record.worktree?.workPath ?? record.runOptions?.cwd ?? record.spawnCwd ?? null,
    isBackground: record.isBackground,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? null,
  };
}

export function finalReportSummary(result: string | undefined): string | null {
  if (result === undefined || result.length === 0) return null;
  return Array.from(result.split(/\r\n|\n|\r/, 1)[0] ?? "")
    .slice(0, 200)
    .join("");
}
