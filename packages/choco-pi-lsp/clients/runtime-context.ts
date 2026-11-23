import { isString } from "./runtime-guards.ts";
import type { CacheManager } from "./cache-manager.ts";
import type { TurnEndFindingsCache } from "./git-guard.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import {
  provenanceStamp,
  validateAdvisoryProvenance,
  type AdvisoryProvenance,
} from "./advisory-provenance.ts";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.ts";
import { logLatency } from "./latency-logger.ts";

type TurnEndMessageResultContract = { role: "user"; content: string };

export const AUTOMATION_FRAMING = "[choco-pi-lsp automated check — not a user request] ";

type ContextResult = { messages: Array<{ role: "user"; content: string }> };

const MAX_LOGGED_REASONS = 8;

function boundedReasons(reasons: string[]): string[] {
  if (reasons.length <= MAX_LOGGED_REASONS) return reasons;
  return [...reasons.slice(0, MAX_LOGGED_REASONS), `+${reasons.length - MAX_LOGGED_REASONS} more`];
}

function logProvenanceDecision(
  validation: ReturnType<typeof validateAdvisoryProvenance>,
  provenance: AdvisoryProvenance | undefined,
  advisoryKind: "turn-end" | "test-findings",
  cwd: string,
): void {
  logLatency({
    type: "phase",
    phase: "advisory_provenance_decision",
    filePath: cwd,
    durationMs: 0,
    metadata: {
      decision: validation.status === "current" ? "current" : "historical",
      reasons: boundedReasons(validation.reasons),
      changedPathCount: validation.changedPathCount,
      provenanceStamp: provenanceStamp(provenance),
      advisoryKind,
    },
  });
}

function historicalPrefix(provenance: AdvisoryProvenance | undefined): string {
  return `Historical finding; workspace changed since capture; re-run to confirm. (${provenanceStamp(provenance)})`;
}

function historicalTestContent(content: string, provenance?: AdvisoryProvenance): string {
  return content.startsWith("[from a prior turn")
    ? content
    : `${historicalPrefix(provenance)}\n\n${content}`;
}

function turnEndMessage(
  content: string,
  current: boolean,
  provenance?: AdvisoryProvenance,
): TurnEndMessageResultContract {
  return {
    role: "user",
    content: current
      ? `${AUTOMATION_FRAMING}Address 🔴 blockers before continuing; ℹ️ advisories are informational only.\n\n${content}`
      : `${AUTOMATION_FRAMING}${historicalPrefix(provenance)}\n\n${content}`,
  };
}

export function peekTurnEndFindings(
  cacheManager: CacheManager,
  cwd: string,
  runtime?: RuntimeCoordinator,
  logDelivery = false,
): ContextResult | undefined {
  const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>("turn-end-findings", cwd);
  if (!findings?.data?.content || findings.data.consumed === true) return;
  const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
  if (logDelivery) logProvenanceDecision(validation, findings.data.provenance, "turn-end", cwd);
  if (validation.allFilesDeleted) return;
  return {
    messages: [
      turnEndMessage(
        findings.data.content,
        validation.status === "current",
        findings.data.provenance,
      ),
    ],
  };
}

export function consumeTurnEndFindings(
  cacheManager: CacheManager,
  cwd: string,
  runtime?: RuntimeCoordinator,
): ContextResult | undefined {
  const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>("turn-end-findings", cwd);
  if (!findings?.data?.content || findings.data.consumed === true) return;
  const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
  logProvenanceDecision(validation, findings.data.provenance, "turn-end", cwd);

  if (findings.data.hasBlockers === true && isString(findings.data.sessionId)) {
    cacheManager.writeCache("turn-end-findings", { ...findings.data, consumed: true }, cwd);
  } else {
    cacheManager.clearCache("turn-end-findings", cwd);
  }
  if (validation.allFilesDeleted) return;
  return {
    messages: [
      turnEndMessage(
        findings.data.content,
        validation.status === "current",
        findings.data.provenance,
      ),
    ],
  };
}

export function peekTestFindings(
  cacheManager: CacheManager,
  cwd: string,
  runtime?: RuntimeCoordinator,
  logDelivery = false,
): ContextResult | undefined {
  const findings = cacheManager.readCache<TestRunnerFindingsCache>("test-runner-findings", cwd);
  if (!findings?.data?.content) return;
  const validation = validateAdvisoryProvenance(findings.data, cwd, runtime);
  if (logDelivery)
    logProvenanceDecision(validation, findings.data.provenance, "test-findings", cwd);
  if (validation.allFilesDeleted) return;
  const current = validation.status === "current";
  return {
    messages: [
      {
        role: "user",
        content: current
          ? `${AUTOMATION_FRAMING}Test failures detected last turn — fix before continuing:\n\n${findings.data.content}`
          : `${AUTOMATION_FRAMING}${historicalTestContent(findings.data.content, findings.data.provenance)}`,
      },
    ],
  };
}

export function consumeTestFindings(
  cacheManager: CacheManager,
  cwd: string,
  runtime?: RuntimeCoordinator,
): ContextResult | undefined {
  const record = cacheManager.readCache<TestRunnerFindingsCache>("test-runner-findings", cwd);
  if (!record?.data?.content) return;
  const findings = peekTestFindings(cacheManager, cwd, runtime, true);
  if (!findings) return;
  const priorGeneration = cacheManager.readCache<TestRunnerFindingsCache>(
    "test-runner-findings",
    cwd,
  )?.data?.testRunGeneration;
  cacheManager.writeCache(
    "test-runner-findings",

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    { content: "", testRunGeneration: priorGeneration } as TestRunnerFindingsCache,
    cwd,
  );
  return findings;
}

export function acknowledgeTurnEndFindings(cacheManager: CacheManager, cwd: string): void {
  const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>("turn-end-findings", cwd);
  if (!findings?.data?.content || findings.data.consumed === true) return;

  if (findings.data.hasBlockers === true && isString(findings.data.sessionId)) {
    cacheManager.writeCache("turn-end-findings", { ...findings.data, consumed: true }, cwd);
  } else {
    cacheManager.clearCache("turn-end-findings", cwd);
  }
}

export function acknowledgeTestFindings(cacheManager: CacheManager, cwd: string): void {
  const findings = cacheManager.readCache<TestRunnerFindingsCache>("test-runner-findings", cwd);
  if (!findings?.data?.content) return;
  cacheManager.writeCache(
    "test-runner-findings",

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    {
      content: "",
      testRunGeneration: findings.data.testRunGeneration,
    } as TestRunnerFindingsCache,
    cwd,
  );
}

export function consumeSessionStartGuidance(
  cacheManager: CacheManager,
  cwd: string,
): ContextResult | undefined {
  const guidance = cacheManager.readCache<{ content: string }>("session-start-guidance", cwd);
  if (!guidance?.data?.content) return;

  cacheManager.writeCache("session-start-guidance", null, cwd);

  return {
    messages: [
      {
        role: "user",
        content: `[choco-pi-lsp automated context — not a user request]\n\n${guidance.data.content}`,
      },
    ],
  };
}
