import { isDeepStrictEqual } from "node:util";
import {
  DefaultResourceLoader,
  defineTool,
  type AgentSession,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RunOptions } from "../../../../.pi/packages/choco-pi-subagents/src/agent-runner.ts";
import { CHILD_OWNER_KEY_PREFIX } from "../../../../.pi/packages/choco-pi-subagents/src/child-compaction-bridge.ts";
import { InputSchema, type EvidenceRecord } from "../artifacts.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import { STEP_TOOL, stepResultText } from "../fake-sse.ts";
import { recordBranch } from "../transport-capture.ts";
import { evidence, type Host, type Scenario } from "./types.ts";
import { prepare } from "./workload.ts";

const CHILD_COUNT = 2;
const CHILD_CYCLES = 6;
const ToolsSchema = Type.Object(
  { childId: Type.String(), activeTools: Type.Array(Type.String()) },
  { additionalProperties: true },
);
const CompactionSchema = Type.Object(
  { childIndex: Type.Integer() },
  { additionalProperties: true },
);

interface ChildProbe {
  host: Host;
  index: number;
  refs: number[];
}
type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

interface ChildRuns {
  readonly refs: number[];
  readonly completed: string[];
  readonly checkpointCounts: number[];
  readonly parentUnchanged: boolean;
}

function registerStep(pi: Parameters<ExtensionFactory>[0]): void {
  pi.registerTool(
    defineTool({
      name: STEP_TOOL,
      label: "harness child step",
      description: "Offline step",
      parameters: Type.Object({ label: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: stepResultText(params.label) }], details: {} };
      },
    }),
  );
}

function childStarted(probe: ChildProbe, ctx: ExtensionContext): void {
  probe.host.observeCoordinators();
  probe.refs.push(
    probe.host.recorder.record("child-start", {
      childId: ctx.sessionManager.getSessionId(),
      parentId: probe.host.manager.getSessionId(),
      index: probe.index,
    }),
  );
}

/** The lean tool surface declares only always-active tools; keep the step tool declared. */
function keepStepActive(pi: Parameters<ExtensionFactory>[0]): void {
  const active = pi.getActiveTools();
  if (!active.includes(STEP_TOOL)) pi.setActiveTools([...active, STEP_TOOL]);
}

function childFactory(probe: ChildProbe): ExtensionFactory {
  return (pi) => {
    registerStep(pi);
    pi.on("session_start", (_event, ctx) => childStarted(probe, ctx));
    pi.on("before_agent_start", () => keepStepActive(pi));
    pi.on("before_provider_request", (event, ctx) => {
      const ref = probe.host.recorder.record("child-before-provider", {
        childId: ctx.sessionManager.getSessionId(),
        activeTools: pi.getActiveTools(),
        payload: Value.Parse(InputSchema, event.payload),
      });
      probe.refs.push(ref);
    });
  };
}

function childLoader(options: LoaderOptions, probe: ChildProbe): DefaultResourceLoader {
  const observer = { name: "harness-child-observer", hidden: true, factory: childFactory(probe) };
  return new DefaultResourceLoader({
    ...options,
    extensionFactories: [...(options.extensionFactories ?? []), observer],
  });
}

function sessionCreated(probe: ChildProbe, child: AgentSession): void {
  probe.host.registerChild(child);
  const childId = child.sessionManager.getSessionId();
  child.subscribe((event) => {
    probe.refs.push(
      probe.host.recorder.record("child-event", {
        childId,
        event: Value.Parse(InputSchema, event),
      }),
    );
  });
}

/** Child 0 runs isolated; child 1 is readOnly on a main-session fork. */
function childOptions(
  probe: ChildProbe,
  options: Pick<RunOptions, "pi" | "mainSessionFork">,
): RunOptions {
  return {
    ...options,
    isolated: probe.index === 0,
    readOnly: probe.index === 1,
    maxTurns: CHILD_CYCLES + 2,
    createResourceLoader: (loaderOptions) => childLoader(loaderOptions, probe),
    onSessionCreated: (child) => sessionCreated(probe, child),
    onCompaction: (info) => {
      probe.refs.push(
        probe.host.recorder.record("runner-onCompaction", { childIndex: probe.index, ...info }),
      );
    },
  };
}

function assertParent(host: Host, leaf: string | null): void {
  if (!host.isCurrent()) throw new Error("Harness owner disposed during child work");
  if (host.manager.getLeafId() !== leaf) throw new Error("Child mutated parent leaf");
}

function recordCompletion(probe: ChildProbe, child: AgentSession): number {
  const checkpoints = child.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "compaction").length;
  probe.refs.push(recordBranch(probe.host.recorder, child.sessionManager.getBranch()));
  probe.refs.push(
    probe.host.recorder.record("child-completed", {
      childId: child.sessionManager.getSessionId(),
      tools: child.getActiveToolNames(),
      registeredTools: child.getAllTools().map((tool) => tool.name),
      checkpoints,
    }),
  );
  return checkpoints;
}

function childConfig(index: number) {
  return {
    name: `harness-child-${index}`,
    description: "Offline deterministic child",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: `HARNESS-CHILD-${index}-GOVERNING-REQUEST`,
    promptMode: "replace" as const,
    persistSession: false,
  };
}

/** Actual runner, including hidden production attachment; no synthetic child host. */
async function runChildren(host: Host): Promise<ChildRuns> {
  const { pi, ctx } = host.parent();
  const parentEntries = structuredClone(host.manager.getBranch());
  const parentLeaf = host.manager.getLeafId();
  const runner = await import("../../../../.pi/packages/choco-pi-subagents/src/agent-runner.ts");
  assertParent(host, parentLeaf);
  const agents = await import("../../../../.pi/packages/choco-pi-subagents/src/agent-types.ts");
  assertParent(host, parentLeaf);
  const childContext =
    await import("../../../../.pi/packages/choco-pi-subagents/src/child-context.ts");
  assertParent(host, parentLeaf);
  const configs = Array.from({ length: CHILD_COUNT }, (_unused, index) => childConfig(index));
  agents.registerAgents(new Map(configs.map((config) => [config.name, config])));
  const runs: ChildRuns = { refs: [], completed: [], checkpointCounts: [], parentUnchanged: false };
  for (const [index, config] of configs.entries()) {
    const probe = { host, index, refs: runs.refs };
    const fork = index === 1 ? runner.captureMainSessionFork(ctx) : undefined;
    const result = await runner.runAgent(
      ctx,
      config.name,
      `HARNESS-CHILD-${index}-PROMPT`,
      childOptions(probe, { pi, mainSessionFork: fork }),
    );
    assertParent(host, parentLeaf);
    runs.checkpointCounts.push(recordCompletion(probe, result.session));
    const childId = result.session.sessionManager.getSessionId();
    runs.completed.push(childId);
    await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assertParent(host, parentLeaf);
    result.session.dispose();
    host.unregisterChild(childId, result.session);
    childContext.unregisterChildSessionId(childId);
  }
  const parentUnchanged =
    isDeepStrictEqual(host.manager.getBranch(), parentEntries) &&
    host.manager.getLeafId() === parentLeaf;
  return { ...runs, parentUnchanged };
}

/** Prepares each child's own coordinator during its second request (text backend). */
function prepareChildren(host: Host): string[] {
  const prepared: string[] = [];
  const mainId = host.manager.getSessionId();
  host.setForegroundObserver(async (dispatch) => {
    if (dispatch.sessionId === mainId || dispatch.index !== 1) return;
    const ownerKey = `${CHILD_OWNER_KEY_PREFIX}${dispatch.sessionId}`;
    if (await prepare(host, () => host.coordinatorFor(ownerKey))) prepared.push(dispatch.sessionId);
  });
  return prepared;
}

/** First and last active-tool sets each child declared on the wire. */
function toolDrift(records: readonly EvidenceRecord[], childId: string): unknown[] {
  const sets = records.flatMap((record) =>
    record.kind === "child-before-provider" &&
    Value.Check(ToolsSchema, record.data) &&
    record.data.childId === childId
      ? [record.data.activeTools]
      : [],
  );
  return [sets[0], sets.at(-1)];
}

function onCompactionCounts(records: readonly EvidenceRecord[]): number[] {
  const counts = Array.from({ length: CHILD_COUNT }, () => 0);
  for (const record of records) {
    if (record.kind !== "runner-onCompaction" || !Value.Check(CompactionSchema, record.data))
      continue;
    counts[record.data.childIndex] = (counts[record.data.childIndex] ?? 0) + 1;
  }
  return counts;
}

function isolationObservations(
  host: Host,
  runs: ChildRuns,
  prepared: readonly string[],
): Observation[] {
  const drift = runs.completed.map((childId) => {
    const [first, last] = toolDrift(host.recorder.records, childId);
    return {
      description: `Child ${childId} tool set unchanged by attachment`,
      actual: last,
      expected: first,
      evidenceRefs: runs.refs,
    };
  });
  return [
    {
      description: "Isolated and readOnly/mainSessionFork children leave the parent untouched",
      actual: runs.parentUnchanged,
      expected: true,
      evidenceRefs: runs.refs,
    },
    {
      description: "Each child prepared on its own coordinator and holds one checkpoint",
      actual: { prepared: [...prepared], checkpoints: runs.checkpointCounts },
      expected: { prepared: runs.completed, checkpoints: [1, 1] },
      evidenceRefs: runs.refs,
    },
    ...drift,
  ];
}

/** Runner onCompaction once per child, coordinator consumers once per adoption. */
function childConsumerEvidence(host: Host, result: CheckEvidence): void {
  const childNotices = host.notifications.filter((notice) =>
    notice.adoptionId.startsWith(CHILD_OWNER_KEY_PREFIX),
  );
  result.notifications = childNotices.map(({ consumer, adoptionId, evidenceRef }) => ({
    consumer,
    adoptionId,
    evidenceRef,
  }));
  const roster = new Set(
    host.consumerRegistrations
      .filter((item) => item.ownerKey.startsWith(CHILD_OWNER_KEY_PREFIX))
      .map((item) => item.consumer),
  );
  const adoptionIds = [...new Set(childNotices.map((notice) => notice.adoptionId))];
  result.expectedNotifications = adoptionIds.flatMap((adoptionId) =>
    [...roster].map((consumer) => ({ consumer, adoptionId })),
  );
  const counts = onCompactionCounts(host.recorder.records);
  const ref = host.recorder.record("runner-onCompaction-counts", { counts });
  result.observations["consumers-notified-once"] = [
    {
      description: "Runner onCompaction fired exactly once per child",
      actual: counts,
      expected: Array.from({ length: CHILD_COUNT }, () => 1),
      evidenceRefs: [ref],
    },
  ];
}

async function runParentAndChildren(host: Host): Promise<CheckEvidence> {
  const prepared = prepareChildren(host);
  const runs = await runChildren(host);
  host.setForegroundObserver(undefined);
  const result = evidence(host);
  result.observations["child-isolation"] = isolationObservations(host, runs, prepared);
  result.observations["child-completion"] = [
    {
      description: "Two real runner completions with distinct child IDs",
      actual: new Set(runs.completed).size,
      expected: CHILD_COUNT,
      evidenceRefs: runs.refs,
    },
  ];
  childConsumerEvidence(host, result);
  return result;
}

export const scenario: Scenario = {
  name: "child-session-adoption",
  description: "Parent and two filtered children adopt their own text checkpoints",
  settings: { enabled: true, text: true, minReductionTokens: 0 },
  checks: ["child-isolation", "child-completion", "consumers-notified-once"],
  markers: ["HARNESS-CHILD-0-PROMPT", "HARNESS-CHILD-1-PROMPT"],
  pending: [
    "Mixed native children: the launcher serves one model per process and no Codex child transport fixture is integrated",
  ],
  execute: runParentAndChildren,
};
