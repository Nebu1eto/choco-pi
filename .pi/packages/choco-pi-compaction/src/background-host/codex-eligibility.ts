/**
 * Codex ownership parity (D12). The Codex package publishes its live
 * native-compaction eligibility on a process-global slot (read and validated
 * in `ownership.ts`, which `resolveOwner` and `selectBackendId` consult). This
 * module watches the slot's revision once per registration and, when it
 * changes, journals the owner transition and replaces the main owner so its
 * backend selection follows the new eligibility.
 */
import { isStaleContextError } from "../lifecycle.ts";
import { CODEX_BACKEND_SETTING_ID } from "../background/settings.ts";
import {
  CODEX_ELIGIBILITY_SLOT,
  type CodexEligibility,
  type CodexEligibilityModel,
  readCodexEligibility,
} from "../ownership.ts";
import { startMainSession } from "./main-session.ts";
import { errorText } from "./notices.ts";
import type { HostRuntime } from "./runtime.ts";

export { CODEX_ELIGIBILITY_SLOT, readCodexEligibility };
export type { CodexEligibility, CodexEligibilityModel };

/** The current owner model's native decision, keyed by the model it was taken for. */
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

/**
 * The current main owner's decision, read from the backend it selected: the
 * Codex lane means native; a resolved Codex lane not selected, or another lane
 * selected, means not native. Undefined when the owner's choice cannot tell
 * (no owner, another model, or no lane at all with the Codex lane unresolved).
 */
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

/** The bound host context and its model, or undefined when none is bound or it went stale. */
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

/**
 * Whether a revision changed the bound model's owner. Unknown when the
 * previous decision was taken for another model (or none was taken yet, the
 * watch starting before the first owner): the owner is then replaced to be safe.
 */
function decisionChanged(before: OwnerDecision | undefined, after: OwnerDecision): boolean {
  return (
    before === undefined || before.modelKey !== after.modelKey || before.native !== after.native
  );
}

/** Journal the owner transition of the bound model: one `config-change` record per changed decision. */
function journalTransition(rt: HostRuntime, sessionId: string, after: OwnerDecision): void {
  rt.journal({
    at: Date.now(),
    sessionId,
    provider: "codex",
    route: "config-change",
    event: "yield",
    // Codex native compaction turned off for this model: its lane yields to the local one;
    // turned on: the local lane no longer fits the owner.
    from: after.native ? "local" : "codex-native-v2",
    to: after.native ? "codex-native-v2" : "local",
    reason: after.native ? "incompatible" : "mode-off",
    detail: "codex-eligibility",
    noticeAttempted: false,
  });
}

/**
 * Replace the main owner after an eligibility change. Called synchronously
 * from the revision listener with the context just read, so no await lies
 * between the snapshot and `startMainSession`, which bumps the lifecycle
 * generation and tears the old owner down before its own first await (and
 * rechecks the generation after each). Containment matches the session
 * lifecycle: a stale context ends the refresh quietly; any other failure is
 * reported, since nothing awaits this restart.
 */
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

/**
 * Watch Codex eligibility for this registration; returns the disposer. One
 * subscription per registration (the caller keeps the disposer until
 * shutdown, which disposes it). On every revision change `onChange` runs;
 * when a session is bound and its model's decision changed (or is not known
 * yet), one `config-change` record is journaled and the main owner is
 * replaced once, so `selectBackendId` follows the new eligibility. With no
 * session bound (before the first start, after shutdown) nothing else
 * happens. No slot (Codex not loaded, or a foreign value) watches nothing;
 * the snapshot heuristic in `resolveOwner` then applies.
 */
export function watchCodexEligibility(
  rt: HostRuntime,
  onChange: (eligibility: CodexEligibility) => void,
): () => void {
  const slot = readCodexEligibility();
  if (slot === undefined) {
    return () => {
      // Nothing subscribed.
    };
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
