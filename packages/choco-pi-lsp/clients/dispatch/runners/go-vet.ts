import { relative, resolve, sep, posix } from "node:path";

import { GoClient } from "../../go-client.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { stripAnsi } from "../../sanitize.ts";
import { parseGoVetOutput } from "./utils/diagnostic-parsers.ts";
import type { DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { PRIORITY } from "../priorities.ts";

const goClient = new GoClient();

const goVetRunner: RunnerDefinition = {
  id: "go-vet",
  appliesTo: ["go"],
  priority: PRIORITY.SPECIALIZED_ANALYSIS,
  enabledByDefault: true,
  timeoutMs: 40_000,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    const goExe = await goClient.findGoPathAsync();
    if (!goExe) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const cwd = ctx.cwd || process.cwd();
    const fileRel = relative(cwd, ctx.filePath).split(sep).join(posix.sep);
    const pkgPath = fileRel.startsWith("../")
      ? "."
      : fileRel.includes("/")
        ? "./" + fileRel.slice(0, fileRel.lastIndexOf("/"))
        : ".";

    const result = await safeSpawnAsync(goExe, ["vet", pkgPath], {
      timeout: 30000,
      cwd,
    });

    const raw = stripAnsi(result.stdout + result.stderr);

    if (result.status === 0 && !raw.trim()) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const absTarget = resolve(ctx.filePath);
    const relevant = raw
      .split("\n")
      .filter((line) => {
        const m = line.match(/^(.+?):(\d+):(\d+):\s*(.+)/);
        return m != null && resolve(cwd, m[1].trim()) === absTarget;
      })
      .join("\n");

    const diagnostics = parseGoVetOutput(relevant, ctx.filePath);

    return diagnostics.length > 0
      ? { status: "failed", diagnostics, semantic: "warning" }
      : { status: "succeeded", diagnostics: [], semantic: "none" };
  },
};

export default goVetRunner;
