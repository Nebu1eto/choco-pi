export const AGENT_BROWSER_TESTED_VERSIONS = [
  "0.34.0",
  "0.35.2",
  "0.36.0",
  "0.37.1",
  "0.38.1",
] as const;

export const AGENT_BROWSER_LEGACY_BASELINE_VERSION = "0.34.0";
export const AGENT_BROWSER_LATEST_TESTED_VERSION = "0.38.1";

export type AgentBrowserTestedVersion = (typeof AGENT_BROWSER_TESTED_VERSIONS)[number];

export const AGENT_BROWSER_CAPABILITIES = [
  "legacy-snapshot",
  "delta-snapshot",
  "screenshot-if-changed",
  "namespace-session-identity",
  "managed-restore",
  "sticky-tab-pinning",
  "explicit-file-access",
  "input-mode",
  "custom-ca-trust",
  "webmcp",
  "recording-fps",
  "recording-cursor",
  "recording-contact-sheet",
] as const;

export type AgentBrowserCapability = (typeof AGENT_BROWSER_CAPABILITIES)[number];
export type AgentBrowserCapabilitySupport = "supported" | "unknown" | "unsupported";

export interface AgentBrowserExecutableFingerprint {
  executablePath: string;
  realPath: string;
  size: number;
  modifiedAtMs: number;
  platform: NodeJS.Platform;
}

export interface AgentBrowserCompatibilityWarning {
  code: "malformed-version" | "newer-than-tested" | "older-than-baseline" | "unrecognized-version";
  message: string;
}

export interface AgentBrowserCompatibilityProfile {
  capabilities: Readonly<Record<AgentBrowserCapability, AgentBrowserCapabilitySupport>>;
  detectedVersion?: string;
  executable?: AgentBrowserExecutableFingerprint;
  profileVersion?: AgentBrowserTestedVersion;
  warnings: readonly AgentBrowserCompatibilityWarning[];
}

export interface AgentBrowserCompatibilityRequirement {
  capability: AgentBrowserCapability;
  reason: string;
  safetyCritical: boolean;
}
