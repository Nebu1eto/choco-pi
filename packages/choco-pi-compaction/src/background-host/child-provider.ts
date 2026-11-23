import type { Api, Model } from "@earendil-works/pi-ai";

import type {
  ChildCompactionProvider,
  ChildCoordinatorAttachment,
  ChildCoordinatorContext,
} from "../background/child-provider-contract.ts";
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

export function createChildProvider(rt: HostRuntime): ChildCompactionProvider {
  return {
    version: 1,
    isEnabled: () => childCompactionEnabled(rt),
    createChildCoordinator: (child) => createChildAttachment(rt, child),
  };
}

function childCompactionEnabled(rt: HostRuntime): boolean {
  const settings = rt.loaded.settings;
  return backgroundCompactionActive(settings) && registryUsable(rt, rt.parent?.ctx);
}

function plainScope(model: Model<Api>): ProviderScope {
  const scope: ProviderScope = { provider: model.provider, model: model.id };
  if (model.baseUrl.length > 0) scope.baseUrl = model.baseUrl;
  return scope;
}

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
  if (child.signal.aborted) return undefined;
  const core = await createOwnerCore(
    childOwnerSpec(rt, { host, child, model, scope, report }),
    rt.options,
  );
  if (core === undefined) return undefined;
  if (child.signal.aborted) {
    core.dispose();
    return undefined;
  }
  child.signal.addEventListener("abort", () => core.dispose(), { once: true });
  recoverChildCandidates(child, core, report);
  return {
    coordinator: core.coordinator,
    observeBoundary: (boundary) => {
      void core.settle();
      core.observeUsage(boundary.contextUsage);
    },
    acknowledgeCommit: () => {
      void core.settle();
    },
  };
}

export type ChildSpecRuntime = Pick<HostRuntime, "loaded" | "xaiMode" | "xaiGate"> &
  Partial<Pick<HostRuntime, "journal" | "transitions" | "serverSide" | "foregroundGate">>;

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
