/**
 * Maven Central jar installs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomicAsync } from "../atomic-write.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { isCommandAvailable } from "./command-probe.ts";
import { httpsGet } from "./download.ts";
import { GITHUB_BIN_DIR, debugLog } from "./installer-env.ts";
import type { ToolDefinition } from "./tool-catalog.ts";

const MAVEN_CENTRAL_BASE = "https://repo1.maven.org/maven2";

/**
 * Install a Maven-distributed runnable fat JAR: download it into the managed bin
 * and write a `java -jar` launcher next to it (so it resolves like any managed
 * binary via findGitHubToolPath). Requires a JRE — gated on `java` availability.
 */
export async function installMavenTool(tool: ToolDefinition): Promise<string | undefined> {
  const spec = tool.maven;
  if (!spec) return undefined;
  const binaryName = tool.binaryName ?? tool.id;
  const isWindows = process.platform === "win32";

  if (!(await isCommandAvailable("java", ["-version"]))) {
    logSessionStart(
      `maven-install ${tool.id}: java not found — a JAR tool can't run without a JRE`,
    );
    return undefined;
  }

  // Strip trailing slashes without a regex (the `\/+$` form trips ReDoS
  // scanners — S5852 — even though the input is a trusted constant/registry
  // value). A plain loop is unambiguously linear.
  let base = spec.repoBaseUrl ?? MAVEN_CENTRAL_BASE;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const groupPath = spec.groupId.replace(/\./g, "/");
  const jarFile = `${spec.artifactId}-${spec.version}${
    spec.classifier ? `-${spec.classifier}` : ""
  }.jar`;
  const url = `${base}/${groupPath}/${spec.artifactId}/${spec.version}/${jarFile}`;

  logSessionStart(`maven-install ${tool.id}: downloading ${url}`);
  let jarBuffer: Buffer;
  try {
    jarBuffer = await httpsGet(url);
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`maven-install ${tool.id}: download failed: ${(err as Error).message}`);
    return undefined;
  }

  try {
    await fs.mkdir(GITHUB_BIN_DIR, { recursive: true });
    const jarPath = path.join(GITHUB_BIN_DIR, `${tool.id}.jar`);
    await writeFileAtomicAsync(jarPath, jarBuffer, { bestEffort: false });

    // Launcher so the tool resolves as a normal command in the managed bin.
    const launcherName = isWindows ? `${binaryName}.bat` : binaryName;
    const launcherPath = path.join(GITHUB_BIN_DIR, launcherName);
    if (isWindows) {
      await writeFileAtomicAsync(
        launcherPath,
        `@echo off\r\njava -jar "%~dp0${tool.id}.jar" %*\r\n`,
        { bestEffort: false },
      );
    } else {
      await writeFileAtomicAsync(
        launcherPath,
        `#!/bin/sh\nexec java -jar "$(dirname "$0")/${tool.id}.jar" "$@"\n`,
        { bestEffort: false, mode: 0o750 },
      );
    }
    logSessionStart(
      `maven-install ${tool.id}: installed → ${launcherPath} (${jarBuffer.length} bytes)`,
    );
    debugLog(`[maven] installed ${tool.name} → ${launcherPath}`);
    return launcherPath;
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`maven-install ${tool.id}: install failed: ${(err as Error).message}`);
    return undefined;
  }
}
