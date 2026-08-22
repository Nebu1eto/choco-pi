import * as path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { findLocalBinUpwards } from "../../package-manager.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { getLinterPolicyForCwd } from "../../tool-policy.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import {
  createAvailabilityChecker,
  lspPrimaryCoversFile,
  resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.ts";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.ts";

const taplo = createAvailabilityChecker("taplo", ".exe");

const TaploResultSchema = Type.Object(
  {
    errors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            range: Type.Optional(
              Type.Object({ start: Type.Object({ line: Type.Number(), col: Type.Number() }) }),
            ),
            message: Type.String(),
            kind: Type.String(),
          },
          { additionalProperties: true },
        ),
      ),
    ),
  },
  { additionalProperties: true },
);

function parseTaploOutput(raw: string, filePath: string): Diagnostic[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Value.Check(TaploResultSchema, parsed)) return [];
    const errors = parsed.errors ?? [];

    return errors.map((err, idx) => ({
      id: `taplo-${err.kind}-${err.range?.start.line ?? idx}`,
      message: `[${err.kind}] ${err.message}`,
      filePath,
      line: (err.range?.start.line ?? 0) + 1,
      column: (err.range?.start.col ?? 0) + 1,
      severity: "error" as const,
      semantic: "blocking" as const,
      tool: "taplo",
      rule: err.kind,
      fixable: false,
    }));
  } catch {
    return [];
  }
}

const taploRunner: RunnerDefinition = {
  id: "taplo",
  appliesTo: ["toml"],
  priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();
    const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
    if (policy && !policy.preferredRunners.includes("taplo")) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    // #233: the `toml` LSP server IS `taplo lsp` (same binary). When that LSP
    // covers this file, the warm server already produces these diagnostics —
    // skip the redundant CLI scan to avoid double-reporting. Stays active when
    // the LSP is disabled/unavailable so TOML coverage never regresses.
    if (lspPrimaryCoversFile(ctx, "toml") && (await ctx.hasTool("taplo"))) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    // Project binary first (#1731, discipline B): `taplo.isAvailableAsync`
    // resolves through `findManagedNodeToolBinary`, choco-pi-lsp's own managed
    // shim — checked BEFORE any project-local candidate, so a project's own
    // `node_modules/.bin/taplo` (npm `@taplo/cli`) never won once the managed
    // copy answered. `findLocalBinUpwards` defaults to `.cmd` on Windows,
    // matching that npm shim; the availability checker's `.exe` extension is
    // correct for choco-pi-lsp's OWN managed install (a GitHub-release binary,
    // `clients/installer/index.ts` taplo entry), a different artifact with a
    // different extension, so it stays as the checker's fallback only.
    let cmd: string | null = findLocalBinUpwards("taplo", cwd) ?? null;
    if (!cmd) {
      if (await taplo.isAvailableAsync(cwd)) {
        cmd = taplo.getCommand(cwd);
      } else {
        cmd = await resolveToolCommandWithInstallFallback(cwd, "taplo");
      }
    }

    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const absPath = path.resolve(cwd, ctx.filePath);
    const result = await safeSpawnAsync(cmd, ["check", "--output=json", absPath], {
      cwd,
      timeout: 15000,
    });

    if (spawnFailedWithNoOutput(result)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const diagnostics = parseTaploOutput(result.stdout || "", ctx.filePath);
    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    return { status: "failed", diagnostics, semantic: "blocking" };
  },
};

export default taploRunner;
