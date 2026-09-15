import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseNamedOptions, requiredStringOption } from "./io.ts";
import { isString } from "../../.pi/extensions/lib/runtime-values.ts";
import { runPi } from "./pi-runner.ts";
import { buildPrefixReport } from "./prefix-report.ts";
import { readSessionUsage } from "./session-usage.ts";
import type { AuditReport } from "./types.ts";

function readableReport(report: AuditReport): string {
  const prefix = report.prefixTokens;
  const lines = [
    `Model: ${report.model} (${report.thinking})`,
    `Working directory: ${report.cwd}`,
    `Requests: ${report.requests.length}`,
    `Structural rewrites: ${report.rewrites}`,
    `Request 1 prefix tokens: ${prefix ? Math.round(prefix.total) : "unavailable"}`,
  ];
  if (prefix) {
    lines.push(`  system: ${Math.round(prefix.system)}`);
    lines.push(`  tools: ${Math.round(prefix.tools)}`);
    lines.push(`  method: ${prefix.method}`);
  }
  for (const change of report.changes.slice(1)) {
    lines.push(
      `Request ${change.requestIndex}: systemChanged=${change.systemChanged}, toolsChanged=${change.toolsChanged}, added=[${change.added.join(", ")}], removed=[${change.removed.join(", ")}], orderChanged=${change.orderChanged}`,
    );
  }
  lines.push(`Request 1 tools: ${report.toolNames.join(", ")}`);
  lines.push(...report.notes.map((note) => `Note: ${note}`));
  return `${lines.join("\n")}\n`;
}

export async function runAudit(options: {
  model: string;
  thinking: string;
  cwd: string;
  outDir: string;
}): Promise<AuditReport> {
  await mkdir(options.outDir, { recursive: true });
  const run = await runPi({
    model: options.model,
    thinking: options.thinking,
    cwd: options.cwd,
    outDir: options.outDir,
    prompts: ["Reply with exactly: ok", "ok again", "ok thrice"],
    timeoutMs: 240_000,
  });
  const usage = await readSessionUsage(run.sessionDirectory);
  const report = await buildPrefixReport({
    model: options.model,
    thinking: options.thinking,
    cwd: options.cwd,
    capturePath: run.capturePath,
    usage,
    wallMs: run.wallMs,
  });
  if (run.timedOut || run.exitCode !== 0) {
    report.notes.push(
      run.timedOut ? "Pi timed out." : `Pi exited with status ${run.exitCode ?? "unknown"}.`,
    );
  }
  await writeFile(`${options.outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return report;
}

async function main(): Promise<void> {
  const options = parseNamedOptions(process.argv.slice(2));
  const outDir = resolve(requiredStringOption(options, "out"));
  const cwdOption = options.get("cwd");
  const cwd = resolve(isString(cwdOption) ? cwdOption : process.cwd());
  const report = await runAudit({
    model: requiredStringOption(options, "model"),
    thinking: requiredStringOption(options, "thinking"),
    cwd,
    outDir,
  });
  process.stdout.write(readableReport(report));
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) await main();
