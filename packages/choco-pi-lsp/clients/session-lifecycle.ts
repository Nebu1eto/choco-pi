import { isFunction, type LspBoundaryValue } from "./runtime-guards.ts";

let activeCtx: unknown | undefined;
let activeSessionId: string | undefined;
let secondarySessionCount = 0;

export type SessionStartClassification =
  | "primary"
  | "sequential-replacement"
  | "concurrent-secondary";

export interface ClassifySessionStartInput {
  hasPrior: boolean;
  priorCtxActive: boolean | undefined;
  sameSessionId: boolean;
}

export function classifySessionStart(input: ClassifySessionStartInput): SessionStartClassification {
  const { hasPrior, priorCtxActive, sameSessionId } = input;

  if (!hasPrior) return "primary";
  if (sameSessionId) return "sequential-replacement";
  if (priorCtxActive === false) return "sequential-replacement";
  if (priorCtxActive === true) return "concurrent-secondary";
  return "sequential-replacement";
}

function guardEnabled(): boolean {
  return process.env.CHOCO_PI_LSP_CONCURRENT_SESSION_GUARD !== "0";
}

export function probeCtxActive(ctx: LspBoundaryValue): boolean | undefined {
  try {
    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const candidate = ctx as { isIdle?: unknown } | null | undefined;

    if (candidate === null || candidate === undefined || !isFunction(candidate.isIdle)) {
      return undefined;
    }

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    (candidate.isIdle as () => LspBoundaryValue)();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("stale after session replacement")) {
      return false;
    }
    return undefined;
  }
}

export function registerPrimarySession(ctx: LspBoundaryValue, sessionId: string | undefined): void {
  activeCtx = ctx;
  activeSessionId = sessionId;
  secondarySessionCount = 0;
}

export function registerSecondarySession(): void {
  secondarySessionCount += 1;
}

export type SessionShutdownClassification = "primary" | "secondary";

export function noteSessionShutdown(
  ctx: LspBoundaryValue,
  sessionId: string | undefined,
): SessionShutdownClassification {
  if (ctx !== undefined && ctx === activeCtx) {
    return "primary";
  }
  if (activeCtx === undefined && activeSessionId === undefined) {
    return "primary";
  }
  if (sessionId !== undefined && sessionId === activeSessionId) {
    return "primary";
  }
  if (sessionId === undefined || activeSessionId === undefined) {
    return "primary";
  }
  const primaryStillActive = probeCtxActive(activeCtx);
  if (primaryStillActive === true) {
    return "secondary";
  }
  return "primary";
}

export function classifyCurrentSessionEmission(
  ctx: LspBoundaryValue,
  sessionId: string | undefined,
): "primary" | "concurrent-secondary" {
  if (!guardEnabled()) return "primary";
  if (activeCtx === undefined && activeSessionId === undefined) return "primary";
  if (ctx !== undefined && ctx === activeCtx) return "primary";
  if (sessionId !== undefined && sessionId === activeSessionId) return "primary";
  if (sessionId === undefined || activeSessionId === undefined) return "primary";
  const primaryStillActive = probeCtxActive(activeCtx);
  if (primaryStillActive === true) return "concurrent-secondary";
  return "primary";
}

export function getSecondarySessionCount(): number {
  return secondarySessionCount;
}

export function decrementSecondarySessionCount(): void {
  if (secondarySessionCount > 0) secondarySessionCount -= 1;
}

export function classifySessionStartGuarded(
  input: ClassifySessionStartInput,
): SessionStartClassification {
  if (!guardEnabled()) return input.hasPrior ? "sequential-replacement" : "primary";
  return classifySessionStart(input);
}

export function _resetSessionLifecycleForTests(): void {
  activeCtx = undefined;
  activeSessionId = undefined;
  secondarySessionCount = 0;
}

export interface SessionStartGuardDecision {
  classification: SessionStartClassification;
  runFullSessionStart: boolean;
  secondaryCount: number;
}

export function decideSessionStart(
  ctx: LspBoundaryValue,
  sessionId: string | undefined,
): SessionStartGuardDecision {
  const hasPrior = activeCtx !== undefined || activeSessionId !== undefined;
  const priorCtxActive = hasPrior ? probeCtxActive(activeCtx) : undefined;
  const sameCtx = hasPrior && ctx !== undefined && ctx === activeCtx;
  const sameSessionId =
    sameCtx || (hasPrior && sessionId !== undefined && sessionId === activeSessionId);

  const classification = classifySessionStartGuarded({
    hasPrior,
    priorCtxActive,
    sameSessionId,
  });

  if (classification === "concurrent-secondary") {
    registerSecondarySession();
    return {
      classification,
      runFullSessionStart: false,
      secondaryCount: secondarySessionCount,
    };
  }

  registerPrimarySession(ctx, sessionId);
  return {
    classification,
    runFullSessionStart: true,
    secondaryCount: secondarySessionCount,
  };
}
