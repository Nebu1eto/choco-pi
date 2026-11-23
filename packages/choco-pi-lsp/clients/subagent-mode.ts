export type SubagentMarker = "pi-subagents" | "avtc-pi-subagent";

interface SubagentClassification {
  isSubagent: boolean;
  marker?: SubagentMarker;
}

let cachedClassification: SubagentClassification | undefined;

function classifySubagentSession(): SubagentClassification {
  if (cachedClassification !== undefined) return cachedClassification;

  if (process.env.PI_SUBAGENT_CHILD === "1") {
    cachedClassification = { isSubagent: true, marker: "pi-subagents" };
    return cachedClassification;
  }

  const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT || undefined;
  const parentPid = process.env.PI_SUBAGENT_PARENT_PID || undefined;
  if (childAgent !== undefined && parentPid !== undefined) {
    cachedClassification = { isSubagent: true, marker: "avtc-pi-subagent" };
    return cachedClassification;
  }

  cachedClassification = { isSubagent: false };
  return cachedClassification;
}

export function isSubagentSession(): boolean {
  if (process.env.CHOCO_PI_LSP_SUBAGENT_FULL === "1") return false;
  return classifySubagentSession().isSubagent;
}

export interface SubagentIdentity {
  runId?: string;
  agentName?: string;
  marker?: SubagentMarker;
  parentPid?: number;
}

export function getSubagentIdentity(): SubagentIdentity | undefined {
  const runId = process.env.PI_SUBAGENT_RUN_ID || undefined;
  const agentName = process.env.PI_SUBAGENT_CHILD_AGENT || undefined;
  const parentPidRaw = process.env.PI_SUBAGENT_PARENT_PID || undefined;
  const parsedParentPid = parentPidRaw === undefined ? undefined : Number(parentPidRaw);
  const parentPid =
    parsedParentPid !== undefined && Number.isSafeInteger(parsedParentPid) && parsedParentPid > 0
      ? parsedParentPid
      : undefined;
  const classification = classifySubagentSession();
  if (
    runId === undefined &&
    agentName === undefined &&
    parentPid === undefined &&
    !classification.isSubagent
  ) {
    return undefined;
  }
  return { runId, agentName, marker: classification.marker, parentPid };
}

export function subagentLightModeNotice(): string {
  return "subagent session — skipped background code-quality scans (set CHOCO_PI_LSP_SUBAGENT_FULL=1 to override)";
}

export function _resetSubagentModeForTests(): void {
  cachedClassification = undefined;
}
