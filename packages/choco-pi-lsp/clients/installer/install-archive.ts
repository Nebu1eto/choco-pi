/**
 * Archive URL resolution and archive installs.
 */
import { isRuntimeFunction } from "../../tools/runtime-values.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomicAsync } from "../atomic-write.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { safeSpawnAsync } from "../safe-spawn.ts";
import { httpsGet } from "./download.ts";
import { TOOLS_DIR } from "./install-lock.ts";
import { GITHUB_BIN_DIR, debugLog } from "./installer-env.ts";
import type { ArchiveSpec, ToolDefinition } from "./tool-catalog.ts";

/**
 * Install a tool that ships as a distribution archive (.tgz/.zip with a lib/ of
 * JARs + bin/ launchers — e.g. SpotBugs), not a single runnable binary or fat
 * JAR. Downloads the archive, extracts it (top-level dir stripped) into
 * ~/.choco-pi-lsp/tools/<id>/, then writes a thin launcher shim into the managed bin
 * so the tool resolves like any other via findGitHubToolPath. Extraction uses
 * `tar` (present on Windows 10+ as bsdtar, which also reads .zip).
 */
/**
 * Resolve an {@link ArchiveSpec} download URL for the current platform/arch.
 * A string URL is platform-agnostic; a function resolves per platform/arch and
 * may return `undefined` (unsupported → caller degrades to "unavailable").
 * Exported for the tool-registry contract test.
 */
function isArchiveUrlResolver(
  value: ArchiveSpec["url"],
): value is (platform: string, arch: string) => string | undefined {
  return isRuntimeFunction(value);
}

export function resolveArchiveUrl(
  spec: ArchiveSpec,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  return isArchiveUrlResolver(spec.url) ? spec.url(platform, arch) : spec.url;
}

export async function installArchiveTool(tool: ToolDefinition): Promise<string | undefined> {
  const spec = tool.archive;
  if (!spec) return undefined;
  const binaryName = tool.binaryName ?? tool.id;
  const isWindows = process.platform === "win32";

  const url = resolveArchiveUrl(spec);
  if (!url) {
    logSessionStart(
      `archive-install ${tool.id}: no archive for ${process.platform}/${process.arch} — unsupported, skipping`,
    );
    return undefined;
  }

  logSessionStart(`archive-install ${tool.id}: downloading ${url}`);
  let archiveBuffer: Buffer;
  try {
    archiveBuffer = await httpsGet(url);
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`archive-install ${tool.id}: download failed: ${(err as Error).message}`);
    return undefined;
  }

  // Use basenames + cwd:TOOLS_DIR for the tar spawn so no argument contains a
  // drive-letter colon — GNU tar (MSYS) otherwise reads `C:\…` as an rsync
  // `host:path` ("Cannot connect to C:"). Relative paths work for both GNU tar
  // and Windows bsdtar, so we avoid the GNU-only `--force-local` (which bsdtar
  // rejects). fs.* calls still use the absolute paths.
  const extractName = tool.id;
  const archiveName = `${tool.id}.download.${spec.kind === "zip" ? "zip" : "tgz"}`;
  const extractDir = path.join(TOOLS_DIR, extractName);
  const tmpArchive = path.join(TOOLS_DIR, archiveName);
  try {
    await fs.mkdir(TOOLS_DIR, { recursive: true });
    // Clear any prior extraction so a reinstall is clean.
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });
    await fs.writeFile(tmpArchive, archiveBuffer);

    // `--strip-components=N` drops N leading path components. Default 1 drops a
    // versioned top-level dir so a launcher path stays stable (bin/… not
    // spotbugs-X.Y.Z/bin/…). A TREE BUNDLE (stripComponents:0) has no wrapping
    // dir — stripping would flatten/merge its sibling module folders — so the
    // flag is omitted. bsdtar handles both .tgz and .zip with -xf.
    const stripComponents = spec.stripComponents ?? 1;
    const tarArgs = [
      spec.kind === "tgz" ? "-xzf" : "-xf",
      archiveName,
      "-C",
      extractName,
      ...(stripComponents > 0 ? [`--strip-components=${stripComponents}`] : []),
    ];
    // Resolve `tar` to an absolute path on Windows (System32\tar.exe is the
    // bsdtar shipped with Windows 10+) so extraction can't be hijacked via a
    // writable PATH entry — same hardening as the taskkill spawn. On POSIX `tar`
    // is a trusted coreutil whose absolute path varies by distro, so it stays
    // bare (consistent with every other tool spawn).
    const tarBin = isWindows
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
      : "tar";
    const extractResult = await safeSpawnAsync(tarBin, tarArgs, {
      cwd: TOOLS_DIR,
      timeout: 120_000,
      ignoreAmbientSignal: true,
      lifetimeCoupled: true,
    });
    const extracted = {
      ok: extractResult.status === 0,
      stderr: extractResult.error?.message ?? extractResult.stderr,
    };
    await fs.rm(tmpArchive, { force: true });
    if (!extracted.ok) {
      logSessionStart(`archive-install ${tool.id}: extraction failed: ${extracted.stderr}`);
      return undefined;
    }

    // Tree bundle (no launcher): the whole extracted tree IS the artifact. Verify
    // the marker exists and resolve to the extract dir — the consuming server
    // launches a runtime against a bootstrap inside it (e.g. PSES via pwsh).
    if (!spec.launcher) {
      const marker = spec.treeMarker
        ? path.join(extractDir, ...spec.treeMarker.split("/"))
        : extractDir;
      try {
        await fs.access(marker);
      } catch {
        logSessionStart(
          `archive-install ${tool.id}: tree marker not found at ${marker} after extraction`,
        );
        return undefined;
      }
      logSessionStart(
        `archive-install ${tool.id}: installed tree bundle → ${extractDir} (extracted ${archiveBuffer.length} bytes)`,
      );
      debugLog(`[archive] installed ${tool.name} bundle → ${extractDir}`);
      return extractDir;
    }

    // The launcher inside the extracted tree (e.g. bin/spotbugs[.bat]).
    const innerLauncher = path.join(extractDir, ...spec.launcher.split("/").map((p) => p));
    const resolvedInner = isWindows ? `${innerLauncher}.bat` : innerLauncher;
    try {
      await fs.access(resolvedInner);
    } catch {
      logSessionStart(
        `archive-install ${tool.id}: launcher not found at ${resolvedInner} after extraction`,
      );
      return undefined;
    }
    if (!isWindows) await fs.chmod(resolvedInner, 0o750).catch(() => {});

    // Thin shim in the managed bin so discovery (findGitHubToolPath) resolves
    // it like any other managed tool. `call`/`exec` preserves the real
    // launcher's own %~dp0/$0 so it still finds its sibling lib/.
    await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });
    const launcherName = isWindows ? `${binaryName}.bat` : binaryName;
    const shimPath = path.join(GITHUB_BIN_DIR, launcherName);
    if (isWindows) {
      await writeFileAtomicAsync(shimPath, `@echo off\r\ncall "${resolvedInner}" %*\r\n`, {
        bestEffort: false,
      });
    } else {
      await writeFileAtomicAsync(shimPath, `#!/bin/sh\nexec "${resolvedInner}" "$@"\n`, {
        bestEffort: false,
        mode: 0o750,
      });
    }
    logSessionStart(
      `archive-install ${tool.id}: installed → ${shimPath} (extracted ${archiveBuffer.length} bytes)`,
    );
    debugLog(`[archive] installed ${tool.name} → ${shimPath}`);
    return shimPath;
  } catch (err) {
    await fs.rm(tmpArchive, { force: true }).catch(() => {});
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`archive-install ${tool.id}: install failed: ${(err as Error).message}`);
    return undefined;
  }
}
