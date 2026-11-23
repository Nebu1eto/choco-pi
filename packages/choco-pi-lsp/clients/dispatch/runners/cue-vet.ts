import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { createAvailabilityChecker, resolveAvailableOrInstall } from "./utils/runner-helpers.ts";
import { spawnFailedWithNoOutput } from "./utils/spawn-outcome.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { PRIORITY } from "../priorities.ts";

const cue = createAvailabilityChecker("cue", ".exe", ["version"]);

interface CueVetLocation {
  file: string;
  line: number;
  column: number;
}

interface CueVetError {
  message: string;
  locations: CueVetLocation[];
}

export function parseCueVetOutput(raw: string): CueVetError[] {
  const errors: CueVetError[] = [];
  let current: CueVetError | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^\s/.test(rawLine)) {
      if (current) {
        const loc = rawLine.trim().match(/^(.+):(\d+):(\d+)$/);
        if (loc) {
          current.locations.push({
            file: loc[1],
            line: Number.parseInt(loc[2], 10),
            column: Number.parseInt(loc[3], 10),
          });
        }
      }
      continue;
    }
    if (current) errors.push(current);
    current = { message: rawLine.replace(/:\s*$/, "").trim(), locations: [] };
  }
  if (current) errors.push(current);
  return errors;
}

export function directoryScopeUnavailable(raw: string): boolean {
  return (
    /build constraints exclude all CUE files/.test(raw) ||
    /found packages ".+"\s*\(.+\)\s+and\s+".+"\s*\(.+\)\s+in\s+".*"/.test(raw)
  );
}

export function hasPackageClause(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@")) continue;
    return /^package\s+[A-Za-z_]\w*\b/.test(trimmed);
  }
  return false;
}

function locationMatchesFile(location: CueVetLocation, fileName: string): boolean {
  const normalized = location.file.replace(/\\/g, "/").replace(/^\.\//, "");
  return path.posix.basename(normalized) === fileName;
}

function toDiagnostic(
  id: string,
  message: string,
  fileName: string,
  line: number,
  column: number,
): Diagnostic {
  return {
    id,
    message: message || "cue vet reported an error",
    filePath: fileName,
    line,
    column,
    severity: "error",
    semantic: "blocking",
    tool: "cue-vet",
    rule: "vet",
    fixable: false,
  };
}

export function filterToTouchedFile(
  errors: CueVetError[],
  fileName: string,
): Diagnostic[] | undefined {
  if (errors.length === 0) return undefined;
  const withLocation = errors.filter((error) => error.locations.length > 0);
  const unattributable = errors.filter((error) => error.locations.length === 0);
  if (withLocation.length === 0) return undefined;

  const diagnostics: Diagnostic[] = [];
  for (const error of withLocation) {
    const match = error.locations.find((location) => locationMatchesFile(location, fileName));
    if (!match) continue;
    diagnostics.push(
      toDiagnostic(
        `cue-vet-${diagnostics.length + 1}-${match.line}`,
        error.message,
        fileName,
        match.line,
        match.column,
      ),
    );
  }
  for (const error of unattributable) {
    diagnostics.push(
      toDiagnostic(`cue-vet-unattributed-${diagnostics.length + 1}`, error.message, fileName, 1, 1),
    );
  }
  return diagnostics;
}

const cueVetRunner: RunnerDefinition = {
  id: "cue-vet",
  appliesTo: ["cue"],
  priority: PRIORITY.GENERAL_ANALYSIS,
  enabledByDefault: true,
  skipTestFiles: false,
  timeoutMs: 30_000,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const cwd = ctx.cwd || process.cwd();

    let cmd: string | null = null;
    if (await cue.isAvailableAsync(cwd)) {
      cmd = cue.getCommand(cwd);
    } else {
      cmd = await resolveAvailableOrInstall(cue, "cue", cwd);
    }
    if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

    const absPath = path.resolve(cwd, ctx.filePath);
    const fileDir = path.dirname(absPath);
    const fileName = path.basename(absPath);
    const singleFileArgs = ["vet", "-c=false", `./${fileName}`] as const;

    let touchedContent: string | null = null;
    try {
      touchedContent = fs.readFileSync(absPath, "utf8");
    } catch {
      touchedContent = null;
    }
    const touchedIsPackageLess = touchedContent !== null && !hasPackageClause(touchedContent);

    let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
    if (touchedIsPackageLess) {
      result = await safeSpawnAsync(cmd, [...singleFileArgs], {
        cwd: fileDir,
        timeout: 30_000,
      });
    } else {
      result = await safeSpawnAsync(cmd, ["vet", "-c=false", "."], {
        cwd: fileDir,
        timeout: 30_000,
      });

      if (
        !spawnFailedWithNoOutput(result, `${result.stdout}${result.stderr}`) &&
        result.status !== 0 &&
        directoryScopeUnavailable(`${result.stdout || ""}${result.stderr || ""}`)
      ) {
        result = await safeSpawnAsync(cmd, [...singleFileArgs], {
          cwd: fileDir,
          timeout: 30_000,
        });
      }
    }

    if (spawnFailedWithNoOutput(result, `${result.stdout}${result.stderr}`)) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    if (result.status === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const raw = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const errors = parseCueVetOutput(raw);
    const filtered = filterToTouchedFile(errors, fileName);

    if (filtered === undefined) {
      return {
        status: "failed",
        diagnostics: [
          {
            id: "cue-vet-unparsed",
            message: raw.slice(0, 300) || "cue vet exited non-zero",
            filePath: ctx.filePath,
            line: 1,
            column: 1,
            severity: "error",
            semantic: "blocking",
            tool: "cue-vet",
            rule: "vet",
            fixable: false,
          },
        ],
        semantic: "blocking",
      };
    }

    if (filtered.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    return { status: "failed", diagnostics: filtered, semantic: "blocking" };
  },
};

export default cueVetRunner;
