import { arr, bool, compile, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { finiteNum } from "../finite-number.ts";

import { isJsonRecord, isString, type RuntimeValue } from "../runtime-values.ts";

/**
 * Structural access to sibling-package runtimes. Nothing here imports another
 * package: each process-global slot is validated before use (pi-schema for data,
 * predicates for the function members JSON Schema cannot describe), so a
 * missing or older package degrades to "unavailable" instead of a type lie.
 */
export const SUBAGENT_REGISTRY_SYMBOL = Symbol.for("pi-subagents:manager");
export const SHELL_MANAGER_SYMBOL = Symbol.for("choco-pi-shells:manager");
export const GOAL_RUNTIME_SYMBOL = Symbol.for("choco-pi-goal:runtime");

const ModelRefSchema = obj({ provider: str(), id: str() }, { open: true });

/** The AgentRecord fields the bridge reads (choco-pi-subagents/src/types.ts). */
export const AgentRecordSchema = obj(
  {
    id: str(),
    type: str(),
    description: str(),
    status: str(),
    toolUses: finiteNum(),
    startedAt: finiteNum(),
    completedAt: opt(finiteNum()),
    result: opt(str()),
    toolCallId: opt(str()),
    outputFile: opt(str()),
    parentAgentId: opt(str()),
    isBackground: opt(bool()),
    rootSessionId: opt(str()),
    spawnCwd: opt(str()),
    spawnModel: opt(ModelRefSchema),
    worktree: opt(obj({ workPath: str() }, { open: true })),
    runOptions: opt(obj({ cwd: opt(str()), maxTurns: opt(finiteNum()) }, { open: true })),
    invocation: opt(obj({ maxTurns: opt(finiteNum()) }, { open: true })),
    lifetimeUsage: obj(
      { input: finiteNum(), output: finiteNum(), cacheWrite: finiteNum() },
      { open: true },
    ),
  },
  { open: true },
);
export type AgentRecordView = Static<typeof AgentRecordSchema>;
const isAgentRecord = compile(AgentRecordSchema).check;

const isAgentSessionModel = compile(
  obj({ session: obj({ model: ModelRefSchema }, { open: true }) }, { open: true }),
).check;

interface SubagentRegistry {
  getAllRecords(): RuntimeValue[];
  stop(id: string): boolean;
  isChildSessionContext(): boolean;
  isChildSessionId(id: string): boolean;
}

/** True when every named member of `value` is a function (arguments and results are not checked). */
function hasFunctionMembers(value: RuntimeValue, names: readonly string[]): boolean {
  return isJsonRecord(value) && names.every((name) => value[name] instanceof Function);
}

function isSubagentRegistry(value: RuntimeValue): value is SubagentRegistry {
  return hasFunctionMembers(value, [
    "getAllRecords",
    "stop",
    "isChildSessionContext",
    "isChildSessionId",
  ]);
}

/** Shell record as the shell manager reports it. */
export const ShellResultSchema = obj(
  {
    shellId: str(),
    ownerId: str(),
    name: opt(str()),
    command: str(),
    cwd: str(),
    state: str(),
    pid: opt(finiteNum()),
    exitCode: opt(finiteNum()),
    startedAt: finiteNum(),
    endedAt: opt(finiteNum()),
  },
  { open: true },
);
export type ShellResultView = Static<typeof ShellResultSchema>;

const isShellListResult = compile(obj({ shells: arr(ShellResultSchema) }, { open: true })).check;
const isShellReadResult = compile(
  obj(
    {
      stdout: obj({ endOffset: finiteNum() }, { open: true }),
      stderr: obj({ endOffset: finiteNum() }, { open: true }),
    },
    { open: true },
  ),
).check;

interface ShellListInput {
  requesterId: string;
  isAdmin: boolean;
}
interface ShellTargetInput extends ShellListInput {
  shellId: string;
  maxBytes?: number;
}

interface ShellManager {
  list(input: ShellListInput): RuntimeValue;
  read(input: ShellTargetInput): RuntimeValue;
  stop(input: ShellTargetInput): RuntimeValue;
  toolCallIdOf(shellId: string): string | null;
}

function isShellManager(value: RuntimeValue): value is ShellManager {
  return hasFunctionMembers(value, ["list", "read", "stop", "toolCallIdOf"]);
}

const isGoalCompleteResult = compile(obj({ ok: bool(), message: str() }, { open: true })).check;

interface GoalRuntime {
  owner: string;
  getGoal(): RuntimeValue;
  completeGoal(ctx: RuntimeValue): RuntimeValue;
}

function isGoalRuntime(value: RuntimeValue): value is GoalRuntime {
  return (
    hasFunctionMembers(value, ["getGoal", "completeGoal"]) &&
    isJsonRecord(value) &&
    isString(value.owner)
  );
}

function globalSlot(key: symbol): RuntimeValue {
  // SAFETY: Process-global symbol slots are published by sibling packages; the value is validated before use.
  const slots = globalThis as typeof globalThis & {
    [slot: symbol]: RuntimeValue;
  };
  return slots[key];
}

function subagentRegistry(): SubagentRegistry | undefined {
  const slot = globalSlot(SUBAGENT_REGISTRY_SYMBOL);
  return isSubagentRegistry(slot) ? slot : undefined;
}

function shellManager(): ShellManager | undefined {
  const slot = globalSlot(SHELL_MANAGER_SYMBOL);
  return isShellManager(slot) ? slot : undefined;
}

/** Live view of the subagent registry, narrowed to records owned by `sessionId`. */
export interface SubagentSource {
  readonly available: boolean;
  records(): AgentRecordView[];
  record(id: string): AgentRecordView | undefined;
  /** Session model of a live record as `provider/id`, when its session exposes one. */
  sessionModel(id: string): string | undefined;
  stop(id: string): boolean;
}

export interface ShellSource {
  readonly available: boolean;
  shells(): ShellResultView[];
  bytes(shellId: string): number;
  toolCallIdOf(shellId: string): string | null;
  stop(shellId: string): Promise<void>;
}

export interface GoalSource {
  readonly available: boolean;
  goal(): RuntimeValue;
  complete(ctx: RuntimeValue): void;
}

export interface HostBridgeSources {
  /** True when the current extension load runs inside a subagent child session. */
  inChildLoad(): boolean;
  isChildSession(sessionId: string): boolean;
  /**
   * Records narrowed to `sessionId` (a foreign `rootSessionId` is always
   * excluded) and to the caller's private ownership predicate.
   */
  subagents(sessionId: string, owns: (record: AgentRecordView) => boolean): SubagentSource;
  shells(sessionId: string): ShellSource;
  goals(sessionId: string): GoalSource;
}

function rawRecords(registry: SubagentRegistry): RuntimeValue[] {
  return registry.getAllRecords();
}

function ownedRecords(
  registry: SubagentRegistry,
  sessionId: string,
  owns: (record: AgentRecordView) => boolean,
): AgentRecordView[] {
  const owned: AgentRecordView[] = [];
  for (const raw of rawRecords(registry)) {
    if (!isAgentRecord(raw)) continue;
    // rootSessionId names the owning root session; a record of another root session is not ours.
    if (raw.rootSessionId !== undefined && raw.rootSessionId !== sessionId) continue;
    if (!owns(raw)) continue;
    owned.push(raw);
  }
  return owned;
}

function createSubagentSource(
  sessionId: string,
  owns: (record: AgentRecordView) => boolean,
): SubagentSource {
  const registry = subagentRegistry();
  if (registry === undefined) {
    return {
      available: false,
      records: () => [],
      record: () => undefined,
      sessionModel: () => undefined,
      stop: () => false,
    };
  }
  return {
    available: true,
    records: () => ownedRecords(registry, sessionId, owns),
    record: (id) => ownedRecords(registry, sessionId, owns).find((record) => record.id === id),
    sessionModel: (id) => {
      for (const raw of rawRecords(registry)) {
        if (!isAgentRecord(raw) || raw.id !== id) continue;
        if (!isAgentSessionModel(raw)) return undefined;
        return `${raw.session.model.provider}/${raw.session.model.id}`;
      }
      return undefined;
    },
    stop: (id) => {
      // Ownership is checked at this boundary, before the registry mutates anything.
      if (!ownedRecords(registry, sessionId, owns).some((record) => record.id === id)) return false;
      return registry.stop(id);
    },
  };
}

function createShellSource(sessionId: string): ShellSource {
  const manager = shellManager();
  if (manager === undefined) {
    return {
      available: false,
      shells: () => [],
      bytes: () => 0,
      toolCallIdOf: () => null,
      stop: async (shellId) => {
        throw new Error(`Shell not found: ${shellId}`);
      },
    };
  }
  const owned = (): ShellResultView[] => {
    const listed = manager.list({ requesterId: sessionId, isAdmin: true });
    if (!isShellListResult(listed)) return [];
    return listed.shells.filter((shell) => shell.ownerId === sessionId);
  };
  return {
    available: true,
    shells: owned,
    bytes: (shellId) => {
      const read = manager.read({
        requesterId: sessionId,
        isAdmin: true,
        shellId,
        maxBytes: 1,
      });
      if (!isShellReadResult(read)) return 0;
      return read.stdout.endOffset + read.stderr.endOffset;
    },
    toolCallIdOf: (shellId) => manager.toolCallIdOf(shellId),
    stop: async (shellId) => {
      if (!owned().some((shell) => shell.shellId === shellId)) {
        throw new Error(`Shell not found: ${shellId}`);
      }
      await manager.stop({ requesterId: sessionId, isAdmin: true, shellId });
    },
  };
}

function goalRuntime(sessionId: string): GoalRuntime | undefined {
  const slot = globalSlot(GOAL_RUNTIME_SYMBOL);
  if (!(slot instanceof Map)) return undefined;
  const runtime: RuntimeValue = slot.get(sessionId);
  if (!isGoalRuntime(runtime)) return undefined;
  // The map key is publisher-supplied; trust only an entry that names the same owner.
  return runtime.owner === sessionId ? runtime : undefined;
}

function createGoalSource(sessionId: string): GoalSource {
  const runtime = goalRuntime(sessionId);
  return {
    available: runtime !== undefined,
    goal: () => (runtime === undefined ? null : runtime.getGoal()),
    complete: (ctx) => {
      if (runtime === undefined) throw new Error("Goal runtime is not available for this session");
      const result = runtime.completeGoal(ctx);
      if (!isGoalCompleteResult(result)) {
        throw new Error("Goal runtime returned an invalid completion result");
      }
      if (!result.ok) throw new Error(result.message);
    },
  };
}

/** Default sources read the live process-global slots on every call. */
export function createProcessSources(): HostBridgeSources {
  return {
    inChildLoad: () => subagentRegistry()?.isChildSessionContext() === true,
    isChildSession: (sessionId) => subagentRegistry()?.isChildSessionId(sessionId) === true,
    subagents: createSubagentSource,
    shells: createShellSource,
    goals: createGoalSource,
  };
}
