import { arr, obj, opt, str, compile } from "@earendil-works/pi-schema";
import { finiteNum } from "../../lsp/schema-guards.ts";
import { safeSpawnAsync } from "../../safe-spawn.ts";
import { PRIORITY } from "../priorities.ts";
import type { Diagnostic, DispatchContext, RunnerDefinition, RunnerResult } from "../types.ts";
import { createAvailabilityChecker } from "./utils/runner-helpers.ts";

const typos = createAvailabilityChecker("typos", ".exe");

const TypoSchema = obj(
  {
    path: opt(str()),
    line_num: opt(finiteNum()),
    byte_offset: opt(finiteNum()),
    typo: opt(str()),
    corrections: opt(arr(str())),
  },
  { open: true },
);
const isTypo = compile(TypoSchema).check;

function parseTyposOutput(raw: string, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!raw.trim()) {
    return diagnostics;
  }

  const lines = raw
    .trim()
    .split("\n")
    .filter((l) => l.trim());

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!isTypo(parsed) || !parsed.typo || !parsed.line_num) continue;

      const corrections = parsed.corrections?.join(", ") || "no suggestions";
      const message = `Typo: "${parsed.typo}" → ${corrections}`;

      diagnostics.push({
        id: `typos-${parsed.line_num}-${parsed.typo}`,
        message,
        filePath,
        line: parsed.line_num,
        column: 1,
        severity: "warning",
        semantic: "warning",
        tool: "typos",
        rule: "typo",
        fixable: !!parsed.corrections?.length,
        autoFixAvailable: false,
        fixKind: parsed.corrections?.length ? "suggestion" : undefined,
        fixSuggestion: parsed.corrections?.[0],
      });
    } catch (err) {
      void err;
    }
  }

  return diagnostics;
}

const spellcheckRunner: RunnerDefinition = {
  id: "spellcheck",
  appliesTo: ["markdown"],
  priority: PRIORITY.DOC_QUALITY,
  enabledByDefault: true,
  skipTestFiles: false,

  async run(ctx: DispatchContext): Promise<RunnerResult> {
    if (!(await typos.isAvailableAsync(ctx.cwd || process.cwd()))) {
      return { status: "skipped", diagnostics: [], semantic: "none" };
    }

    const args = ["--format", "json", ctx.filePath];

    const result = await safeSpawnAsync(typos.getCommand(ctx.cwd || process.cwd())!, args, {
      timeout: 15000,
    });

    const hasTypos = result.status === 2 || result.stdout?.trim();

    if (!hasTypos) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    const raw = result.stdout + result.stderr;
    const diagnostics = parseTyposOutput(raw, ctx.filePath);

    if (diagnostics.length === 0) {
      return { status: "succeeded", diagnostics: [], semantic: "none" };
    }

    return {
      status: "failed",
      diagnostics,
      semantic: "warning",
    };
  },
};

export default spellcheckRunner;
