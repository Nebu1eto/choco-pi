import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomicAsync } from "../atomic-write.ts";
import { createGunzip } from "node:zlib";
import { logSessionStart } from "../sessionstart-logger.ts";
import { githubApiAuthHeaders, httpsGet, runCommand } from "./download.ts";
import { deriveHashiCorpReleaseAsset, pickReleaseAsset } from "./github-assets.ts";
import { GITHUB_BIN_DIR, debugLog } from "./installer-env.ts";
import type { ToolDefinition } from "./tool-catalog.ts";
import { getArchiveBinaryCandidates, getGitHubInstalledBinaryName } from "./tool-resolution.ts";

export async function installGitHubTool(tool: ToolDefinition): Promise<string | undefined> {
  const spec = tool.github;
  if (!spec) return undefined;

  const platform = process.platform;
  const arch = process.arch;
  const assetSubstring = spec.assetMatch(platform, arch);
  if (!assetSubstring) {
    logSessionStart(`github-install ${tool.id}: unsupported platform=${platform} arch=${arch}`);
    return undefined;
  }

  logSessionStart(`github-install ${tool.id}: fetching release metadata from ${spec.repo}`);
  let releaseJson: {
    tag_name?: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  try {
    const body = await httpsGet(
      `https://api.github.com/repos/${spec.repo}/releases/latest`,
      5,
      githubApiAuthHeaders(),
    );
    releaseJson = JSON.parse(body.toString("utf8"));
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`github-install ${tool.id}: release fetch failed: ${(err as Error).message}`);
    return undefined;
  }

  const asset =
    pickReleaseAsset(releaseJson.assets, assetSubstring) ??
    deriveHashiCorpReleaseAsset(tool, releaseJson.tag_name, assetSubstring);
  if (!asset) {
    logSessionStart(`github-install ${tool.id}: no asset matched "${assetSubstring}"`);
    return undefined;
  }

  logSessionStart(`github-install ${tool.id}: downloading ${asset.name}`);
  debugLog(`[github] downloading ${asset.name} from ${asset.browser_download_url}`);

  const downloadStart = Date.now();
  let assetBuffer: Buffer;
  try {
    assetBuffer = await httpsGet(asset.browser_download_url);
    logSessionStart(
      `github-install ${tool.id}: downloaded ${asset.name} (${assetBuffer.length} bytes, ${Date.now() - downloadStart}ms)`,
    );
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`github-install ${tool.id}: download failed: ${(err as Error).message}`);
    return undefined;
  }

  await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });

  const binaryName = tool.binaryName ?? tool.id;
  const isWindows = platform === "win32";
  const finalBinaryName = getGitHubInstalledBinaryName(binaryName, platform, asset.name);
  const destPath = path.join(GITHUB_BIN_DIR, finalBinaryName);

  const assetName = asset.name;

  try {
    if (assetName.endsWith(".gz") && !assetName.endsWith(".tar.gz")) {
      const decompressed = await new Promise<Buffer>((resolve, reject) => {
        const gunzip = createGunzip();
        const chunks: Buffer[] = [];
        gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
        gunzip.on("end", () => resolve(Buffer.concat(chunks)));
        gunzip.on("error", reject);
        gunzip.end(assetBuffer);
      });
      await writeFileAtomicAsync(destPath, decompressed, {
        bestEffort: false,
        mode: 0o750,
      });
    } else if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tar.xz")) {
      const tmpArchive = path.join(GITHUB_BIN_DIR, `_tmp_${assetName}`);
      await fs.writeFile(tmpArchive, assetBuffer);
      const tmpDir = path.join(GITHUB_BIN_DIR, `_tmp_extract_${tool.id}`);
      await fs.mkdir(tmpDir, { recursive: true });

      const extracted = await runCommand("tar", ["xf", tmpArchive, "-C", tmpDir], GITHUB_BIN_DIR);
      await fs.rm(tmpArchive, { force: true });

      if (!extracted) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        logSessionStart(`github-install ${tool.id}: tar extraction failed for ${assetName}`);
        return undefined;
      }

      const tarBinaryName = spec.binaryInArchive ?? binaryName;
      const tarSrcBinary = await findFirstFileRecursive(
        tmpDir,
        getArchiveBinaryCandidates(tarBinaryName, platform, assetName),
      );
      if (!tarSrcBinary) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        logSessionStart(
          `github-install ${tool.id}: binary candidates ${JSON.stringify(
            getArchiveBinaryCandidates(tarBinaryName, platform, assetName),
          )} not found in tar ${assetName}`,
        );
        return undefined;
      }
      await fs.rename(tarSrcBinary, destPath);
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (!isWindows) await fs.chmod(destPath, 0o750);
    } else if (assetName.endsWith(".zip")) {
      const tmpArchive = path.join(GITHUB_BIN_DIR, `_tmp_${assetName}`);
      await fs.writeFile(tmpArchive, assetBuffer);
      const tmpDir = path.join(GITHUB_BIN_DIR, `_tmp_extract_${tool.id}`);
      await fs.mkdir(tmpDir, { recursive: true });

      const extracted = isWindows
        ? await runCommand(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `Expand-Archive -LiteralPath '${tmpArchive}' -DestinationPath '${tmpDir}' -Force`,
            ],
            GITHUB_BIN_DIR,
          )
        : await runCommand("unzip", ["-q", "-o", tmpArchive, "-d", tmpDir], GITHUB_BIN_DIR);

      await fs.rm(tmpArchive, { force: true });

      if (!extracted) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        logSessionStart(`github-install ${tool.id}: zip extraction failed for ${assetName}`);
        return undefined;
      }

      const archiveBinaryName = spec.binaryInArchive ?? binaryName;
      const srcBinary = await findFirstFileRecursive(
        tmpDir,
        getArchiveBinaryCandidates(archiveBinaryName, platform, assetName),
      );
      if (!srcBinary) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        logSessionStart(
          `github-install ${tool.id}: binary candidates ${JSON.stringify(
            getArchiveBinaryCandidates(archiveBinaryName, platform, assetName),
          )} not found in zip ${assetName}`,
        );
        return undefined;
      }
      await fs.rename(srcBinary, destPath);
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (!isWindows) await fs.chmod(destPath, 0o750);
    } else {
      await writeFileAtomicAsync(destPath, assetBuffer, {
        bestEffort: false,
        mode: 0o750,
      });
    }
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`github-install ${tool.id}: install failed: ${(err as Error).message}`);
    return undefined;
  }

  for (const extraName of spec.extraAssets?.(platform, arch) ?? []) {
    const extraAsset = releaseJson.assets.find((a) => a.name === extraName);
    if (!extraAsset) {
      logSessionStart(`github-install ${tool.id}: required extra asset "${extraName}" not found`);
      return undefined;
    }
    try {
      const extraBuffer = await httpsGet(extraAsset.browser_download_url);
      await writeFileAtomicAsync(path.join(GITHUB_BIN_DIR, extraName), extraBuffer, {
        bestEffort: false,
        mode: 0o750,
      });
      logSessionStart(
        `github-install ${tool.id}: installed extra asset ${extraName} (${extraBuffer.length} bytes)`,
      );
    } catch (err) {
      logSessionStart(
        // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
        `github-install ${tool.id}: extra asset ${extraName} download failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  debugLog(`[github] installed ${tool.name} → ${destPath}`);
  logSessionStart(`github-install ${tool.id}: installed → ${destPath}`);
  return destPath;
}

async function findFirstFileRecursive(dir: string, names: string[]): Promise<string | undefined> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFirstFileRecursive(full, names);
      if (found) return found;
    } else if (wanted.has(entry.name.toLowerCase())) {
      return full;
    }
  }
  return undefined;
}
