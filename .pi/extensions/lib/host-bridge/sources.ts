import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { RuntimeValue } from "../runtime-values.ts";

/**
 * Structural access to sibling-package runtimes. Nothing here imports another
 * package: each process-global slot is validated with typebox before use, so a
 * missing or older package degrades to "unavailable" instead of a type lie.
 */
export const SUBAGENT_REGISTRY_SYMBOL = Symbol.for("pi-subagents:manager");
export const SHELL_MANAGER_SYMBOL = Symbol.for("choco-pi-shells:manager");
export const GOAL_RUNTIME_SYMBOL = Symbol.for("choco-pi-goal:runtime");

const ModelRefSchema = Type.Object({ provider: Type.String(), id: Type.String() });

/** The AgentRecord fields the bridge reads (choco-pi-subagents/src/types.ts). */
export const AgentRecordSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  description: Type.String(),
  status: Type.String(),
  toolUses: Type.Number(),
  startedAt: Type.Number(),
  completedAt: Type.Optional(Type.Number()),
  result: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()),
  outputFile: Type.Optional(Type.String()),
  parentAgentId: Type.Optional(Type.String()),
  isBackground: Type.Optional(Type.Boolean()),
  rootSessionId: Type.Optional(Type.String()),
  spawnCwd: Type.Optional(Type.String()),
  spawnModel: Type.Optional(ModelRefSchema),
  worktree: Type.Optional(Type.Object({ workPath: Type.String() })),
  runOptions: Type.Optional(
    Type.Object({ cwd: Type.Optional(Type.String()), maxTurns: Type.Optional(Type.Number()) }),
  ),
  invocation: Type.Optional(Type.Object({ maxTurns: Type.Optional(Type.Number()) })),
  lifetimeUsage: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheWrite: Type.Number(),
  }),
});
export type AgentRecordView = Static<typeof AgentRecordSchema>;

const AgentSessionModelSchema = Type.Object({
  session: Type.Object({ model: ModelRefSchema }),
});

const SubagentRegistrySchema = Type.Object({
  getAllRecords: Type.Function([], Type.Array(Type.Unknown())),
  stop: Type.Function([Type.String()], Type.Boolean()),
  isChildSessionContext: Type.Function([], Type.Boolean()),
  isChildSessionId: Type.Function([Type.String()], Type.Boolean()),
});
type SubagentRegistry = Static<typeof SubagentRegistrySchema>;

export const ShellResultSchema = Type.Object({
  shellId: Type.String(),
  ownerId: Type.String(),
  name: Type.Optional(Type.String()),
  command: Type.String(),
  cwd: Type.String(),
  state: Type.String(),
  pid: Type.Optional(Type.Number()),
  exitCode: Type.Optional(Type.Number()),
  startedAt: Type.Number(),
  endedAt: Type.Optional(Type.Number()),
});
export type ShellResultView = Static<typeof ShellResultSchema>;

const ShellListResultSchema = Type.Object({ shells: Type.Array(ShellResultSchema) });
const ShellReadResultSchema = Type.Object({
  stdout: Type.Object({ endOffset: Type.Number() }),
  stderr: Type.Object({ endOffset: Type.Number() }),
});

const ShellListInputSchema = Type.Object({ requesterId: Type.String(), isAdmin: Type.Boolean() });
const ShellTargetInputSchema = Type.Object({
  requesterId: Type.String(),
  isAdmin: Type.Boolean(),
  shellId: Type.String(),
  maxBytes: Type.Optional(Type.Number()),
});

const ShellManagerSchema = Type.Object({
  list: Type.Function([ShellListInputSchema], Type.Unknown()),
  read: Type.Function([ShellTargetInputSchema], Type.Unknown()),
  stop: Type.Function([ShellTargetInputSchema], Type.Unknown()),
  toolCallIdOf: Type.Function([Type.String()], Type.Union([Type.String(), Type.Null()])),
});
type ShellManager = Static<typeof ShellManagerSchema>;

const GoalCompleteResultSchema = Type.Object({ ok: Type.Boolean(), message: Type.String() });

const GoalRuntimeSchema = Type.Object({
  owner: Type.String(),
  getGoal: Type.Function([], Type.Unknown()),
  completeGoal: Type.Function([Type.Unknown()], Type.Unknown()),
});
type GoalRuntime = Static<typeof GoalRuntimeSchema>;

function globalSlot(key: symbol): RuntimeValue {
  // SAFETY: Process-global symbol slots are published by sibling packages; the value is validated before use.
  const slots = globalThis as typeof globalThis & { [slot: symbol]: RuntimeValue };
  return slots[key];
}

function subagentRegistry(): SubagentRegistry | undefined {
  const slot = globalSlot(SUBAGENT_REGISTRY_SYMBOL);
  return Value.Check(SubagentRegistrySchema, slot) ? slot : undefined;
}

function shellManager(): ShellManager | undefined {
  const slot = globalSlot(SHELL_MANAGER_SYMBOL);
  return Value.Check(ShellManagerSchema, slot) ? slot : undefined;
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
    if (!Value.Check(AgentRecordSchema, raw)) continue;
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
        if (!Value.Check(AgentRecordSchema, raw) || raw.id !== id) continue;
        if (!Value.Check(AgentSessionModelSchema, raw)) return undefined;
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
    if (!Value.Check(ShellListResultSchema, listed)) return [];
    return listed.shells.filter((shell) => shell.ownerId === sessionId);
  };
  return {
    available: true,
    shells: owned,
    bytes: (shellId) => {
      const read = manager.read({ requesterId: sessionId, isAdmin: true, shellId, maxBytes: 1 });
      if (!Value.Check(ShellReadResultSchema, read)) return 0;
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
  if (!Value.Check(GoalRuntimeSchema, runtime)) return undefined;
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
      if (!Value.Check(GoalCompleteResultSchema, result)) {
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
