import { isBoolean, isFunction, type LspBoundaryValue } from "./runtime-guards.ts";
import { logExtension } from "./extension-log.ts";
import { recordDegradation } from "./degradation-ledger.ts";

export type ProjectTrustState = "trusted" | "untrusted" | "unknown";

let trustState: ProjectTrustState = "unknown";
const installRefusalWarnings = new Set<string>();
const INSTALL_REFUSAL_WARNING_CAP = 200;
let trustGeneration = 0;

export function getProjectTrustGeneration(): number {
  return trustGeneration;
}

function latchProjectTrustState(next: ProjectTrustState): void {
  if (next === trustState) return;
  trustState = next;
  installRefusalWarnings.clear();
  trustGeneration += 1;
}

export function readProjectTrustFromContext(ctx: LspBoundaryValue): ProjectTrustState {
  try {
    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const accessor = (ctx as { isProjectTrusted?: unknown } | null | undefined)?.isProjectTrusted;

    if (!isFunction(accessor)) return "unknown";

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const trusted = (accessor as () => LspBoundaryValue).call(ctx);

    if (!isBoolean(trusted)) return "unknown";
    return trusted ? "trusted" : "untrusted";
  } catch (accessorErr) {
    logExtension({
      subsystem: "project-trust",
      level: "warn",
      message: "isProjectTrusted() threw -- latching untrusted (fail-closed)",
      metadata: { error: String(accessorErr) },
    });
    return "untrusted";
  }
}

export function setProjectTrustState(next: ProjectTrustState): void {
  const previous = trustState;
  latchProjectTrustState(next);
  if (previous !== next) {
    logExtension({
      subsystem: "project-trust",
      level: "debug",
      message: `project trust state transitioned: ${previous} -> ${next}`,
      metadata: { previous, next },
    });
  }
}

export function adoptProjectTrustFromContext(ctx: LspBoundaryValue): ProjectTrustState {
  const next = readProjectTrustFromContext(ctx);
  const previous = trustState;
  latchProjectTrustState(next);
  if (previous !== next) {
    logExtension({
      subsystem: "project-trust",
      level: "debug",
      message: `project trust state transitioned: ${previous} -> ${next}`,
      metadata: { previous, next },
    });
  }
  return next;
}

export function adoptProjectTrustFromPorts(
  ports: import("./host-ports.ts").HostPorts,
): ProjectTrustState {
  const next = ports.trust.isProjectTrusted();
  setProjectTrustState(next);
  return next;
}

export function getProjectTrustState(): ProjectTrustState {
  return trustState;
}

export function resetProjectTrust(): void {
  latchProjectTrustState("unknown");
  installRefusalWarnings.clear();
}

export function isToolInstallAllowedByTrust(): boolean {
  return trustState !== "untrusted";
}

export function assertInstallAllowed(context: string): boolean {
  if (isToolInstallAllowedByTrust()) return true;
  recordDegradation({
    kind: "trust-refusal",
    subject: context,
    reason: projectTrustDenialReason() ?? "project trust denied",
  });
  if (!installRefusalWarnings.has(context)) {
    if (installRefusalWarnings.size >= INSTALL_REFUSAL_WARNING_CAP) {
      installRefusalWarnings.clear();
    }
    installRefusalWarnings.add(context);
    logExtension({
      subsystem: "project-trust",
      level: "warn",
      message: `install/materialization blocked: ${context}`,
      metadata: { context, trustState },
    });
  }
  return false;
}

export function isLspSpawnAllowedByTrust(): boolean {
  return trustState !== "untrusted";
}

export function projectTrustDenialReason(): string | undefined {
  return trustState === "untrusted"
    ? "project is not trusted (host isProjectTrusted() === false)"
    : undefined;
}
