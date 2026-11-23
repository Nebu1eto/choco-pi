/**
 * GitHub release asset selection, including derived HashiCorp release assets.
 */
import { TOOLS, type ToolDefinition } from "./tool-catalog.ts";
import { getArchiveBinaryCandidates, getGitHubInstalledBinaryName } from "./tool-resolution.ts";

/**
 * GitHub-release tools that ship an asset for **every** supported
 * platform/arch combo (linux/darwin/win32 × x64/arm64). This is the set the
 * full asset-matrix test (tests/clients/installer/github-release.test.ts)
 * iterates, so membership must stay in lockstep with the registry — the
 * tool-registry-consistency test enforces that every `installStrategy: "github"`
 * entry resolving all six combos appears here, and vice versa.
 *
 * `swiftlint` is deliberately absent: it has no Windows asset (macOS + Linux
 * only), so it cannot satisfy the full matrix and is covered by the weaker
 * "at least one platform" guard instead.
 */
export const GITHUB_TOOLS = [
  "shellcheck",
  "shfmt",
  "rust-analyzer",
  "golangci-lint",
  "ktlint",
  "actionlint",
  "zizmor",
  "typos-lsp",
  "tflint",
  "terragrunt",
  "terraform-ls",
  "zls",
  "hadolint",
  "helm",
  "taplo",
  "vale",
  "opengrep",
  "deno",
  "clojure-lsp",
  "cue",
  "gleam",
  "marksman",
  "expert",
] as const;
export type GitHubToolId = (typeof GITHUB_TOOLS)[number];

/**
 * Resolve the GitHub asset filename substring for a tool on a given platform/arch.
 * Returns undefined if the tool has no GitHub spec or no asset for the platform.
 * Exported for testing only.
 */
export function resolveGitHubAsset(
  toolId: GitHubToolId,
  platform: string,
  arch: string,
): string | undefined {
  const tool = TOOLS.find((t) => t.id === toolId);
  return tool?.github?.assetMatch(platform, arch);
}

export function resolveGitHubInstalledBinaryName(
  toolId: GitHubToolId,
  platform: string,
  assetName: string,
): string | undefined {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return undefined;
  return getGitHubInstalledBinaryName(tool.binaryName ?? tool.id, platform, assetName);
}

export function resolveGitHubArchiveBinaryCandidates(
  toolId: GitHubToolId,
  platform: string,
  assetName: string,
): string[] | undefined {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return undefined;
  const binaryName = tool.github?.binaryInArchive ?? tool.binaryName ?? tool.id;
  return getArchiveBinaryCandidates(binaryName, platform, assetName);
}

type DownloadAsset = { name: string; browser_download_url: string };

// Signature/checksum siblings a release publishes next to the real asset. A
// bare-binary tool's substring IS the whole asset name, so `includes` alone
// matches `<asset>.asc` too and would install a signature file as the binary.
const ASSET_SIDECAR_SUFFIXES = [
  ".asc",
  ".sig",
  ".minisig",
  ".pem",
  ".cert",
  ".sbom",
  ".sha256",
  ".sha256sum",
  ".md5",
];

function isAssetSidecar(name: string): boolean {
  const lower = name.toLowerCase();
  return ASSET_SIDECAR_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function pickReleaseAsset<T extends { name: string }>(
  assets: T[],
  assetSubstring: string,
): T | undefined {
  return (
    assets.find((a) => a.name === assetSubstring) ??
    assets.find((a) => a.name.includes(assetSubstring) && !isAssetSidecar(a.name))
  );
}

export function deriveHashiCorpReleaseAsset(
  tool: ToolDefinition,
  tagName: string | undefined,
  assetSubstring: string,
): DownloadAsset | undefined {
  const product = tool.github?.hashiCorpReleaseProduct;
  if (!product || !tagName) return undefined;

  const version = tagName.replace(/^v/, "").trim();
  if (!version) return undefined;

  const assetName = `${product}_${version}_${assetSubstring}`;
  return {
    name: assetName,
    browser_download_url: `https://releases.hashicorp.com/${product}/${version}/${assetName}`,
  };
}

export function resolveDerivedHashiCorpReleaseAsset(
  toolId: string,
  tagName: string,
  platform: string,
  arch: string,
): DownloadAsset | undefined {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return undefined;
  const assetSubstring = tool.github?.assetMatch(platform, arch);
  if (!assetSubstring) return undefined;
  return deriveHashiCorpReleaseAsset(tool, tagName, assetSubstring);
}
