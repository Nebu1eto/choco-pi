/**
 * npm, pip, and gem installs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomicAsync } from "../atomic-write.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { installArgs, pmBinary, resolveNodePackageManager } from "../package-manager.ts";
import { safeSpawnAsync } from "../safe-spawn.ts";
import { verifyToolBinary } from "./command-probe.ts";
import { TOOLS_DIR } from "./install-lock.ts";
import { debugLog, installerPlatform } from "./installer-env.ts";
import { NEEDS_POSTINSTALL } from "./managed-npm.ts";

export async function installNpmTool(
  packageName: string,
  binaryName: string,
): Promise<string | undefined> {
  try {
    // Ensure tools directory exists
    await fs.mkdir(TOOLS_DIR, { recursive: true });

    // Create a minimal package.json if it doesn't exist
    const packageJsonPath = path.join(TOOLS_DIR, "package.json");
    try {
      await fs.access(packageJsonPath);
    } catch {
      await writeFileAtomicAsync(
        packageJsonPath,
        JSON.stringify({ name: "choco-pi-lsp-tools", version: "1.0.0" }, null, 2),
        { bestEffort: false },
      );
    }

    // Resolve the package manager for the tools dir and build install args.
    const isWindows = installerPlatform() === "win32";
    const pm = await resolveNodePackageManager(TOOLS_DIR);
    const testNpmScript =
      process.env.CHOCO_PI_LSP_TEST_MODE === "1"
        ? process.env.CHOCO_PI_LSP_TEST_NPM_SCRIPT
        : undefined;
    const pmCommand = testNpmScript ? process.execPath : pmBinary(pm);
    // Use --ignore-scripts unless the package explicitly needs postinstall
    // (e.g. biome downloads a platform-specific native binary via postinstall).
    const needsScripts = NEEDS_POSTINSTALL.has(packageName);
    const baseInstallArgs = installArgs(pm, packageName, {
      ignoreScripts: !needsScripts,
    });

    const INSTALL_TIMEOUT_MS = Number(process.env.CHOCO_PI_LSP_INSTALL_TIMEOUT_MS) || 120_000;
    const runInstallAttempt = async (args: string[]): Promise<{ ok: boolean; stderr: string }> => {
      const result = await safeSpawnAsync(pmCommand, args, {
        cwd: TOOLS_DIR,
        timeout: INSTALL_TIMEOUT_MS,
        ignoreAmbientSignal: true,
        lifetimeCoupled: true,
      });
      return {
        ok: result.status === 0,
        stderr: result.error?.message ?? result.stderr,
      };
    };

    let outcome = await runInstallAttempt([
      ...(testNpmScript ? [testNpmScript] : []),
      ...baseInstallArgs,
    ]);

    // --legacy-peer-deps is npm-only; retry just npm's ERESOLVE failures.
    const erResolve =
      outcome.ok === false &&
      /npm\s+error\s+ERESOLVE|\bERESOLVE\b|could not resolve/i.test(outcome.stderr);

    if (pm === "npm" && erResolve) {
      const retryArgs = installArgs(pm, packageName, {
        ignoreScripts: !needsScripts,
        legacyPeerDeps: true,
      });
      logSessionStart(
        `auto-install npm ${packageName}: retry with --legacy-peer-deps after ERESOLVE`,
      );
      outcome = await runInstallAttempt([...(testNpmScript ? [testNpmScript] : []), ...retryArgs]);
    }

    if (!outcome.ok) {
      throw new Error(`Failed to install ${packageName}: ${outcome.stderr}`);
    }

    // npm creates a command shim on Windows; retain that actual executable path
    // rather than probing/storing the extensionless POSIX sibling.
    const binBase = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);
    const binPath = installerPlatform() === "win32" ? `${binBase}.cmd` : binBase;

    // Make executable on Unix
    if (installerPlatform() !== "win32") {
      try {
        await fs.chmod(binPath, 0o750);
      } catch {
        /* ignore */
      }
    }

    // Brief delay — lets npm postinstall scripts finish writing bin wrappers
    // before we stat/exec them (eliminates a race on slow Windows I/O).
    await new Promise((r) => setTimeout(r, 500));

    // Verify the binary actually works, retrying with backoff to handle
    // postinstall scripts that complete asynchronously after npm exits 0.
    debugLog(`Verifying ${binaryName}...`);
    let isValid = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      isValid = await verifyToolBinary(binPath);
      if (isValid) break;
      if (attempt < 3) {
        logSessionStart(
          `auto-install verify ${binaryName}: attempt ${attempt} failed, retrying in ${attempt}s`,
        );
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!isValid) {
      logSessionStart(
        `auto-install ${packageName}: installed but verification failed, cleaning up`,
      );
      // Clean up the broken installation
      try {
        const packagePath = path.join(TOOLS_DIR, "node_modules", packageName);
        await fs.rm(packagePath, { recursive: true, force: true });
        await fs.rm(binBase, { force: true });
        if (isWindows) {
          await fs.rm(`${binBase}.cmd`, { force: true });
          await fs.rm(`${binBase}.ps1`, { force: true });
        }
      } catch {
        /* ignore cleanup errors */
      }
      return undefined;
    }

    return binPath;
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`auto-install npm ${packageName}: exception: ${(err as Error).message}`);
    return undefined;
  }
}
/**
 * Install a pip package tool
 */
export async function installPipTool(packageName: string): Promise<string | undefined> {
  try {
    const isWindows = process.platform === "win32";
    const pipCandidates = isWindows
      ? [
          { command: "pip", args: ["install", "--user", packageName] },
          {
            command: "py",
            args: ["-m", "pip", "install", "--user", packageName],
          },
          {
            command: "python",
            args: ["-m", "pip", "install", "--user", packageName],
          },
        ]
      : [
          { command: "pip3", args: ["install", "--user", packageName] },
          { command: "pip", args: ["install", "--user", packageName] },
          {
            command: "python3",
            args: ["-m", "pip", "install", "--user", packageName],
          },
          {
            command: "python",
            args: ["-m", "pip", "install", "--user", packageName],
          },
        ];

    let lastError = "";
    for (const candidate of pipCandidates) {
      const pipResult = await safeSpawnAsync(candidate.command, candidate.args, {
        timeout: 120_000,
        ignoreAmbientSignal: true,
        lifetimeCoupled: true,
      });
      const outcome = {
        ok: pipResult.status === 0,
        error: (pipResult.error?.message ?? pipResult.stderr).trim(),
      };

      if (outcome.ok) {
        // Ensure user-level scripts directory is available in current process PATH.
        // This helps tools installed via `pip install --user` become immediately callable.
        const userBaseResult = await new Promise<string>((resolve) => {
          let probe: ReturnType<typeof spawn>;
          try {
            probe = spawn(candidate.command, ["-m", "site", "--user-base"], {
              stdio: ["ignore", "pipe", "pipe"],
              shell: isWindows,
            });
          } catch {
            // SYNCHRONOUS spawn throw (Windows `spawn UNKNOWN`/EINVAL, the
            // pidusage bug class, #533) — best-effort probe, resolve empty.
            resolve("");
            return;
          }
          let stdout = "";
          probe.stdout?.on("data", (data) => (stdout += data));
          probe.on("exit", (code) => {
            if (code === 0) resolve(stdout.trim());
            else resolve("");
          });
          probe.on("error", () => resolve(""));
        });

        if (userBaseResult) {
          const candidateScriptDirs: string[] = [
            path.join(userBaseResult, isWindows ? "Scripts" : "bin"),
          ];

          if (isWindows) {
            // Some Python setups report USER_BASE as ...\Roaming\Python,
            // while scripts live in ...\Roaming\Python\PythonXY\Scripts.
            try {
              const children = await fs.readdir(userBaseResult, {
                withFileTypes: true,
              });
              for (const entry of children) {
                if (!entry.isDirectory()) continue;
                if (!/^python\d+$/i.test(entry.name)) continue;
                candidateScriptDirs.push(path.join(userBaseResult, entry.name, "Scripts"));
              }
            } catch {
              // ignore
            }
          }

          const currentPath = process.env.PATH || process.env.Path || process.env.path || "";
          const separator = isWindows ? ";" : ":";
          const normalizedPath = currentPath
            .toLowerCase()
            .split(separator)
            .map((p) => p.trim());

          for (const scriptsDir of candidateScriptDirs) {
            try {
              await fs.access(scriptsDir);
              if (!normalizedPath.includes(scriptsDir.toLowerCase())) {
                const existingPath = process.env.PATH || process.env.Path || process.env.path || "";
                const updatedPath = `${scriptsDir}${separator}${existingPath}`;
                process.env.PATH = updatedPath;
                if (isWindows) {
                  process.env.Path = updatedPath;
                }
                debugLog(`Added pip user scripts dir to PATH: ${scriptsDir}`);
              }
            } catch {
              debugLog(`pip user scripts dir not accessible: ${scriptsDir}`);
            }
          }
        }

        return packageName;
      }

      lastError = `${candidate.command} ${candidate.args.join(" ")}: ${outcome.error}`;
      debugLog(`[pip-fallback] ${lastError}`);
    }

    throw new Error(
      `Failed to install ${packageName}: no usable pip command found (${lastError || "unknown error"})`,
    );
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`auto-install pip ${packageName}: exception: ${(err as Error).message}`);
    return undefined;
  }
}

export async function installGemTool(packageName: string): Promise<string | undefined> {
  try {
    const gemResult = await safeSpawnAsync("gem", ["install", packageName, "--no-document"], {
      timeout: 120_000,
      ignoreAmbientSignal: true,
      lifetimeCoupled: true,
    });
    const outcome = {
      ok: gemResult.status === 0,
      error: (gemResult.error?.message ?? gemResult.stderr).trim(),
    };

    if (!outcome.ok) {
      throw new Error(`Failed to install ${packageName} via gem: ${outcome.error}`);
    }

    return packageName;
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    logSessionStart(`auto-install gem ${packageName}: exception: ${(err as Error).message}`);
    return undefined;
  }
}
