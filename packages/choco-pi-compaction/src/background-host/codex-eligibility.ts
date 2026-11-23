import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { CODEX_BACKEND_SETTING_ID } from "../background/settings.ts";
import {
  CODEX_ELIGIBILITY_SLOT,
  type CodexEligibility,
  type CodexEligibilityModel,
  publishedCodexResponsesCompaction,
  readCodexEligibility,
} from "../ownership.ts";
import { startMainSession } from "./main-session.ts";
import { errorText } from "./notices.ts";
import type { HostRuntime } from "./runtime.ts";

export { CODEX_ELIGIBILITY_SLOT, publishedCodexResponsesCompaction, readCodexEligibility };
export type { CodexEligibility, CodexEligibilityModel };

interface OwnerDecision {
  readonly modelKey: string;
  readonly native: boolean;
}

function modelKeyOf(model: CodexEligibilityModel): string {
  return JSON.stringify([model.provider, model.api, model.id, model.baseUrl]);
}

function decide(slot: CodexEligibility, model: CodexEligibilityModel): OwnerDecision {
  const native: unknown = slot.isNativeCompactionOwner(model);
  return { modelKey: modelKeyOf(model), native: native === true };
}

function ownerDecision(rt: HostRuntime, model: CodexEligibilityModel): OwnerDecision | undefined {
  const core = rt.main?.core;
  if (core === undefined || core.scope.model !== model.id || core.scope.provider !== model.provider)
    return undefined;
  const modelKey = modelKeyOf(model);
  if (core.backendId === CODEX_BACKEND_SETTING_ID) return { modelKey, native: true };
  if (core.backendId !== undefined || core.backendIds.includes(CODEX_BACKEND_SETTING_ID))
    return { modelKey, native: false };
  return undefined;
}

function boundHost(rt: HostRuntime) {
  const ctx = rt.main?.lastCtx ?? rt.parent?.ctx;
  if (ctx === undefined) return undefined;
  try {
    return { ctx, sessionId: ctx.sessionManager.getSessionId(), model: ctx.model };
  } catch (cause) {
    if (cause instanceof Error && isStaleContextError(cause)) return undefined;
    throw cause;
  }
}

function decisionChanged(before: OwnerDecision | undefined, after: OwnerDecision): boolean {
  return (
    before === undefined || before.modelKey !== after.modelKey || before.native !== after.native
  );
}

function journalTransition(rt: HostRuntime, sessionId: string, after: OwnerDecision): void {
  rt.journal({
    at: Date.now(),
    sessionId,
    provider: "codex",
    route: "config-change",
    event: "yield",
    from: after.native ? "local" : "codex-native-v2",
    to: after.native ? "codex-native-v2" : "local",
    reason: after.native ? "incompatible" : "mode-off",
    detail: "codex-eligibility",
    noticeAttempted: false,
  });
}

function restartMainOwner(
  rt: HostRuntime,
  ctx: NonNullable<ReturnType<typeof boundHost>>["ctx"],
): void {
  const childProvider = rt.childProvider;
  if (childProvider === undefined) return;
  void startMainSession(rt, ctx, { reloadSettings: true, childProvider }).catch(
    (cause: unknown) => {
      if (cause instanceof Error && isStaleContextError(cause)) return;
      rt.notify(ctx, `Codex eligibility refresh failed: ${errorText(cause)}`);
    },
  );
}

export function watchCodexEligibility(
  rt: HostRuntime,
  onChange: (eligibility: CodexEligibility) => void,
): () => void {
  const slot = readCodexEligibility();
  if (slot === undefined) {
    return () => {};
  }
  let seen = slot.revision;
  const initial = boundHost(rt);
  let decision = initial?.model === undefined ? undefined : decide(slot, initial.model);
  return slot.subscribe((revision) => {
    if (revision === seen) return;
    seen = revision;
    const host = boundHost(rt);
    onChange(slot);
    if (host === undefined) return;
    if (host.model === undefined) {
      restartMainOwner(rt, host.ctx);
      return;
    }
    const next = decide(slot, host.model);
    const known = decision?.modelKey === next.modelKey ? decision : ownerDecision(rt, host.model);
    const changed = decisionChanged(known, next);
    decision = next;
    if (!changed) return;
    journalTransition(rt, host.sessionId, next);
    restartMainOwner(rt, host.ctx);
  });
}
