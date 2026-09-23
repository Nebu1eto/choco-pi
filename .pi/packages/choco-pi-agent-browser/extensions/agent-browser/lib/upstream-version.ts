import {
  AGENT_BROWSER_LEGACY_BASELINE_VERSION,
  AGENT_BROWSER_LATEST_TESTED_VERSION,
  AGENT_BROWSER_TESTED_VERSIONS,
  type AgentBrowserCapability,
  type AgentBrowserCapabilitySupport,
  type AgentBrowserCompatibilityProfile,
  type AgentBrowserCompatibilityWarning,
  type AgentBrowserTestedVersion,
} from "./compatibility-contract.ts";

export {
  AGENT_BROWSER_LEGACY_BASELINE_VERSION,
  AGENT_BROWSER_LATEST_TESTED_VERSION,
  AGENT_BROWSER_TESTED_VERSIONS,
};

export const TARGET_AGENT_BROWSER_VERSION = AGENT_BROWSER_LATEST_TESTED_VERSION;
export const TARGET_AGENT_BROWSER_VERSION_LABEL = `agent-browser ${TARGET_AGENT_BROWSER_VERSION}`;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

export function compareAgentBrowserVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] < parsedRight[key]) return -1;
    if (parsedLeft[key] > parsedRight[key]) return 1;
  }
  if (parsedLeft.prerelease === parsedRight.prerelease) return 0;
  if (parsedLeft.prerelease === undefined) return 1;
  if (parsedRight.prerelease === undefined) return -1;
  return parsedLeft.prerelease.localeCompare(parsedRight.prerelease, "en", { numeric: true }) < 0
    ? -1
    : 1;
}

export function parseAgentBrowserVersionOutput(stdout: string): string | undefined {
  const match = stdout.trim().match(/^agent-browser\s+(\S+)$/u);
  return match && parseVersion(match[1] ?? "") ? match[1] : undefined;
}

const CAPABILITY_INTRODUCTIONS = {
  "custom-ca-trust": "0.35.0",
  "delta-snapshot": "0.38.0",
  "explicit-file-access": "0.34.0",
  "input-mode": "0.38.0",
  "legacy-snapshot": "0.34.0",
  "managed-restore": "0.34.0",
  "namespace-session-identity": "0.34.0",
  "recording-contact-sheet": "0.38.0",
  "recording-cursor": "0.38.0",
  "recording-fps": "0.37.0",
  "screenshot-if-changed": "0.38.0",
  "sticky-tab-pinning": "0.34.0",
  webmcp: "0.36.0",
} as const satisfies Record<AgentBrowserCapability, string>;

function capabilityRecord(version: string | undefined, versionIsKnown: boolean) {
  const support = (capability: AgentBrowserCapability): AgentBrowserCapabilitySupport => {
    if (!version) return "unknown";
    const comparison = compareAgentBrowserVersions(version, CAPABILITY_INTRODUCTIONS[capability]);
    if (comparison === undefined) return "unknown";
    if (!versionIsKnown && comparison >= 0) return "unknown";
    return comparison >= 0 ? "supported" : "unsupported";
  };
  return {
    "custom-ca-trust": support("custom-ca-trust"),
    "delta-snapshot": support("delta-snapshot"),
    "explicit-file-access": support("explicit-file-access"),
    "input-mode": support("input-mode"),
    "legacy-snapshot": support("legacy-snapshot"),
    "managed-restore": support("managed-restore"),
    "namespace-session-identity": support("namespace-session-identity"),
    "recording-contact-sheet": support("recording-contact-sheet"),
    "recording-cursor": support("recording-cursor"),
    "recording-fps": support("recording-fps"),
    "screenshot-if-changed": support("screenshot-if-changed"),
    "sticky-tab-pinning": support("sticky-tab-pinning"),
    webmcp: support("webmcp"),
  } satisfies Record<AgentBrowserCapability, AgentBrowserCapabilitySupport>;
}

function testedProfileFor(version: string): AgentBrowserTestedVersion | undefined {
  const withoutBuild = version.split("+", 1)[0];
  return AGENT_BROWSER_TESTED_VERSIONS.find((tested) => tested === withoutBuild);
}

export function resolveAgentBrowserCompatibility(stdout: string): AgentBrowserCompatibilityProfile {
  const detectedVersion = parseAgentBrowserVersionOutput(stdout);
  const warnings: AgentBrowserCompatibilityWarning[] = [];
  if (!detectedVersion) {
    warnings.push({
      code: "malformed-version",
      message:
        "agent-browser --version returned an unrecognized value; continuing without claiming optional capabilities.",
    });
    return { capabilities: capabilityRecord(undefined, false), warnings };
  }
  const profileVersion = testedProfileFor(detectedVersion);
  const baselineComparison = compareAgentBrowserVersions(
    detectedVersion,
    AGENT_BROWSER_LEGACY_BASELINE_VERSION,
  );
  const latestComparison = compareAgentBrowserVersions(
    detectedVersion,
    AGENT_BROWSER_LATEST_TESTED_VERSION,
  );
  if (latestComparison === 1) {
    warnings.push({
      code: "newer-than-tested",
      message: `agent-browser ${detectedVersion} is newer than the latest tested release (${AGENT_BROWSER_LATEST_TESTED_VERSION}). Continuing with verified capabilities; newer command behavior may be unavailable.`,
    });
  } else if (baselineComparison === -1) {
    warnings.push({
      code: "older-than-baseline",
      message: `agent-browser ${detectedVersion} is older than the tested baseline (${AGENT_BROWSER_LEGACY_BASELINE_VERSION}). Common operations remain available, but optional capabilities are unverified.`,
    });
  } else if (!profileVersion) {
    warnings.push({
      code: "unrecognized-version",
      message: `agent-browser ${detectedVersion} is not an exact tested profile. Continuing with baseline capabilities only.`,
    });
  }
  return {
    capabilities: capabilityRecord(detectedVersion, profileVersion !== undefined),
    detectedVersion,
    profileVersion,
    warnings,
  };
}

/** @deprecated Version differences are advisory; use resolveAgentBrowserCompatibility. */
export function getAgentBrowserVersionValidationError(_stdout: string): undefined {
  return undefined;
}
