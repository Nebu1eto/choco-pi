import type { Api, Model } from "@earendil-works/pi-ai";

import type {
  ChildCompactionProvider,
  ChildCoordinatorAttachment,
  ChildCoordinatorContext,
} from "../../../choco-pi-subagents/src/child-compaction-bridge.ts";
import type { ProviderScope } from "../background/contract.ts";
import type { LaneRecordInput } from "../background/lane-journal.ts";
import { backgroundCompactionActive } from "../background/settings.ts";
import { candidateRecordsOf } from "./branch.ts";
import { nativeLaneSwitches } from "./native-lanes.ts";
import { announceVia, errorText } from "./notices.ts";
import { createOwnerCore, type OwnerCore } from "./owner-core.ts";
import type { OwnerSpec } from "./owner-spec.ts";
import { resolveProviderScope } from "./provider-scope.ts";
import { type HostRuntime, registryUsable } from "./runtime.ts";

// ---------------------------------------------------------------------------
// Child sessions: the subagent runner's bridge attaches a coordinator per child
// ---------------------------------------------------------------------------

/** The provider this registration publishes for the subagent runner's bridge. */
export function createChildProvider(rt: HostRuntime): ChildCompactionProvider {
  return {
    version: 1,
    isEnabled: () => childCompactionEnabled(rt),
    createChildCoordinator: (child) => createChildAttachment(rt, child),
  };
}

function childCompactionEnabled(rt: HostRuntime): boolean {
  const settings = rt.loaded.settings;
  // The same switch as the main session: any enabled lane (text, Codex, Anthropic).
  return backgroundCompactionActive(settings) && registryUsable(rt, rt.parent?.ctx);
}

/** Provider, model and endpoint only: the scope a child keeps when its auth cannot be read. */
function plainScope(model: Model<Api>): ProviderScope {
  const scope: ProviderScope = { provider: model.provider, model: model.id };
  if (model.baseUrl.length > 0) scope.baseUrl = model.baseUrl;
  return scope;
}

/**
 * A child's provider scope, resolved like the main session's (auth mode for
 * Anthropic, hashed account for Codex) so its native backends admit it. An
 * unreadable credential keeps the plain scope: native capability checks then
 * fail closed and the text lane still serves the child.
 */
async function childScope(
  model: Model<Api>,
  registry: ChildHostRegistry,
  settings: HostRuntime["loaded"]["settings"],
  report: (message: string) => void,
): Promise<ProviderScope> {
  try {
    return await resolveProviderScope(model, registry, settings);
  } catch (cause) {
    report(`provider scope unavailable: ${errorText(cause)}`);
    return plainScope(model);
  }
}

type ChildHostRegistry = NonNullable<HostRuntime["parent"]>["modelRegistry"];

async function createChildAttachment(
  rt: HostRuntime,
  child: ChildCoordinatorContext,
): Promise<ChildCoordinatorAttachment | undefined> {
  const settings = rt.loaded.settings;
  const host = rt.parent;
  const model = child.model;
  if (!childCompactionEnabled(rt) || host === undefined || model === undefined) return undefined;
  const report = (message: string): void => rt.notify(host.ctx, `subagent: ${message}`);
  const scope = await childScope(model, host.modelRegistry, settings, report);
  // Detached (cancel, timeout, disposal) while the scope resolved: attach nothing.
  if (child.signal.aborted) return undefined;
  const core = await createOwnerCore(
    childOwnerSpec(rt, { host, child, model, scope, report }),
    rt.options,
  );
  if (core === undefined) return undefined;
  // An abort before the listener exists would never dispose the core.
  if (child.signal.aborted) {
    core.dispose();
    return undefined;
  }
  child.signal.addEventListener("abort", () => core.dispose(), { once: true });
  recoverChildCandidates(child, core, report);
  return {
    coordinator: core.coordinator,
    observeBoundary: (boundary) => {
      // The previous boundary has completed; an uncommitted proposal returns to ready.
      void core.settle();
      core.observeUsage(boundary.contextUsage);
    },
    acknowledgeCommit: () => {
      void core.settle();
    },
  };
}

/**
 * The runtime fields a child owner spec reads. The journal, transition memo,
 * Anthropic session switch and shared gate are optional only for partial test
 * runtimes; the host always passes its full runtime.
 */
export type ChildSpecRuntime = Pick<HostRuntime, "loaded" | "xaiMode" | "xaiGate"> &
  Partial<Pick<HostRuntime, "journal" | "transitions" | "serverSide" | "foregroundGate">>;

/**
 * The owner spec of a child coordinator: the child's own session, model and
 * scope, the parent's registry and policies, and the provider-native lanes
 * the child's model selects — the same {@link nativeLaneSwitches} the main
 * session's spec uses, so a Codex child gets the Codex backend, an Anthropic
 * child the Anthropic native backend, and an admitted xAI child leaves the
 * compaction to xAI server-side, exactly as in the main session.
 */
export function childOwnerSpec(
  rt: ChildSpecRuntime,
  parts: {
    readonly host: Pick<NonNullable<HostRuntime["parent"]>, "modelRegistry" | "state">;
    readonly child: ChildCoordinatorContext;
    readonly model: Model<Api>;
    readonly scope: ProviderScope;
    readonly report: (message: string) => void;
  },
): OwnerSpec {
  const { host, child, model, scope, report } = parts;
  const childSessionId = child.childSessionId;
  // The bridge persists candidate records only, so a child's lane records are
  // journaled through this registration under the child's session id.
  const journal = (record: LaneRecordInput): void => {
    if (!child.signal.aborted) rt.journal?.(record);
  };
  return {
    ownerKey: child.ownerKey,
    ownerGeneration: child.ownerGeneration,
    sessionId: child.childSessionId,
    sessionManager: child.sessionManager,
    model,
    modelRegistry: host.modelRegistry,
    thinkingLevel: undefined,
    retryPolicy: host.state.retryPolicy,
    compactionPolicy: host.state.compactionPolicy,
    codexCompaction: host.state.codexCompaction,
    settings: rt.loaded.settings,
    scope,
    appendRecord: child.appendRecord,
    // The bridge appends a model-invisible anchor entry in the child and
    // returns its ID ("" once detached, which fails closed in the coordinator).
    appendAnchor: () => child.appendAnchor(),
    isOwnerCurrent: () => !child.signal.aborted,
    ...nativeLaneSwitches(rt, model),
    report,
    journal,
    announce: (text, _level, policy, record) => {
      if (child.signal.aborted) return;
      const transitions = rt.transitions;
      if (transitions === undefined) return;
      announceVia({ journal, transitions }, record, policy, () => report(text));
    },
    anthropicDisabled: () => rt.serverSide?.isDisabled(childSessionId) === true,
    anthropicGate: rt.foregroundGate,
  };
}

function recoverChildCandidates(
  child: ChildCoordinatorContext,
  core: OwnerCore,
  report: (message: string) => void,
): void {
  const records = candidateRecordsOf(child.sessionManager.getBranch());
  if (records.length === 0) return;
  core.coordinator.recover(records).catch((cause: unknown) => {
    report(`candidate recovery failed: ${errorText(cause)}`);
  });
}
