import type { Api, Model } from "@earendil-works/pi-ai";

import type {
  ChildCompactionProvider,
  ChildCoordinatorAttachment,
  ChildCoordinatorContext,
} from "../../../choco-pi-subagents/src/child-compaction-bridge.ts";
import type { ProviderScope } from "../background/contract.ts";
import { backgroundCompactionActive, isBackendEnabled } from "../background/settings.ts";
import { TEXT_BACKEND_ID } from "../background/text-backend.ts";
import { candidateRecordsOf } from "./branch.ts";
import { errorText } from "./notices.ts";
import { createOwnerCore, type OwnerCore } from "./owner-core.ts";
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
  return (
    backgroundCompactionActive(settings) &&
    isBackendEnabled(TEXT_BACKEND_ID, settings) &&
    registryUsable(rt, rt.parent?.ctx)
  );
}

/** Children use the text backend only, scoped to provider, model and endpoint. */
function childScope(model: Model<Api>): ProviderScope {
  const scope: ProviderScope = { provider: model.provider, model: model.id };
  if (model.baseUrl.length > 0) scope.baseUrl = model.baseUrl;
  return scope;
}

async function createChildAttachment(
  rt: HostRuntime,
  child: ChildCoordinatorContext,
): Promise<ChildCoordinatorAttachment | undefined> {
  const settings = rt.loaded.settings;
  const host = rt.parent;
  const model = child.model;
  if (!childCompactionEnabled(rt) || host === undefined || model === undefined) return undefined;
  const report = (message: string): void => rt.notify(host.ctx, `subagent: ${message}`);
  const core = await createOwnerCore(
    {
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
      settings,
      scope: childScope(model),
      appendRecord: child.appendRecord,
      // The bridge appends a model-invisible anchor entry in the child and
      // returns its ID ("" once detached, which fails closed in the coordinator).
      appendAnchor: () => child.appendAnchor(),
      isOwnerCurrent: () => !child.signal.aborted,
      allowAnthropic: false,
      allowForeign: false,
      report,
    },
    rt.options,
  );
  if (core === undefined) return undefined;
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
