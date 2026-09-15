import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { parseNamedOptions, readValidatedJson, requiredStringOption } from "./io.ts";
import { runPi } from "./pi-runner.ts";
import { countStructuralRewrites, readCaptureRecords } from "./prefix-report.ts";
import { readSessionUsage } from "./session-usage.ts";
import {
  MatrixSummarySchema,
  RunResultSchema,
  TaskSpecsSchema,
  type MatrixSummary,
  type RunResult,
  type TaskSpec,
} from "./types.ts";
import { evaluateTaskVerdict } from "./verdict.ts";
import { isString } from "../../.pi/extensions/lib/runtime-values.ts";

interface ModelSpec {
  model: string;
  thinking: string;
}

interface MatrixOptions {
  models: ModelSpec[];
  tasksPath: string;
  fixturePath: string;
  outDir: string;
  resume: boolean;
}

function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function parseModelSpec(value: string): ModelSpec {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Model entry must end in :thinking: ${value}`);
  }
  const model = value.slice(0, separator);
  const thinking = value.slice(separator + 1);
  if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh"]).has(thinking)) {
    throw new Error(`Unsupported thinking level: ${thinking}`);
  }
  return { model, thinking };
}

function orderModels(models: readonly ModelSpec[]): ModelSpec[] {
  return [...models].sort((left, right) => {
    const leftIsKimi = left.model.toLowerCase().includes("kimi");
    const rightIsKimi = right.model.toLowerCase().includes("kimi");
    return Number(leftIsKimi) - Number(rightIsKimi);
  });
}

function totalTokens(result: RunResult): number {
  return (
    result.tokens.input + result.tokens.cacheRead + result.tokens.cacheWrite + result.tokens.output
  );
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function requestOnePrefixTokens(
  captureRecords: Awaited<ReturnType<typeof readCaptureRecords>>,
): number {
  const firstRequest = captureRecords[0];
  return firstRequest ? Math.ceil((firstRequest.systemChars + firstRequest.toolsChars) / 4) : 0;
}

function markdownSummary(summary: MatrixSummary): string {
  const lines = [
    "# Prefix evaluation matrix",
    "",
    "Prefix tokens are request-1 chars/4 estimates. Total tokens are input + cacheRead + cacheWrite + output. Cost is reported separately.",
    "",
    "| Model | Pass | Fail | Timeout | Blocked | Avg prefix tokens (request 1) | Rewrite rate | Avg total tokens | Total cost |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const model of summary.models) {
    const rows = summary.results.filter((result) => result.model === model.model);
    const measuredPrefixes = rows
      .map((result) => result.requestOnePrefixTokens)
      .filter((tokens) => tokens > 0);
    const rewriteRate = rows.length
      ? rows.filter((result) => result.rewrites > 0).length / rows.length
      : 0;
    lines.push(
      `| ${model.model} | ${rows.filter((row) => row.verdict === "pass").length} | ${rows.filter((row) => row.verdict === "fail").length} | ${rows.filter((row) => row.verdict === "timeout").length} | ${rows.filter((row) => row.verdict === "blocked").length} | ${Math.round(average(measuredPrefixes))} | ${(rewriteRate * 100).toFixed(1)}% | ${Math.round(average(rows.map(totalTokens)))} | ${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(4)} |`,
    );
  }
  lines.push("", "## Results", "");
  lines.push("| Model | Task | Verdict | Turns | Rewrites | Total tokens | Reason |");
  lines.push("|---|---|---|---:|---:|---:|---|");
  for (const result of summary.results) {
    const reason = [result.reason, ...result.deviations]
      .join("; ")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
    lines.push(
      `| ${result.model} | ${result.taskId} | ${result.verdict} | ${result.turns} | ${result.rewrites} | ${totalTokens(result)} | ${reason} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

interface ModelMetrics {
  model: string;
  pass: number;
  fail: number;
  timeout: number;
  blocked: number;
  prefixEstimatedTokens: number;
  prefixCountedTokens?: number;
  rewriteRate: number;
  averageTotalTokens: number;
  totalCost: number;
}

interface MergedSummary extends MatrixSummary {
  perModel: ModelMetrics[];
}

const CountedPrefixReportSchema = Type.Object(
  {
    model: Type.String(),
    cwd: Type.String(),
    prefixTokens: Type.Optional(
      Type.Object({ total: Type.Number(), method: Type.String() }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

async function countedAnthropicPrefixes(
  runDirectories: readonly string[],
): Promise<Map<string, number[]>> {
  const measurements = new Map<string, number[]>();
  for (const runDirectory of runDirectories) {
    const entries = await readdir(runDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("audit-")) continue;
      try {
        const report = await readValidatedJson(
          join(runDirectory, entry.name, "report.json"),
          CountedPrefixReportSchema,
          "audit report",
        );
        if (
          !report.model.startsWith("anthropic/") ||
          report.prefixTokens?.method.startsWith("Anthropic count_tokens") !== true ||
          !report.cwd.includes("audit-fixture")
        ) {
          continue;
        }
        const modelMeasurements = measurements.get(report.model) ?? [];
        modelMeasurements.push(report.prefixTokens.total);
        measurements.set(report.model, modelMeasurements);
      } catch (error) {
        const reportIsMissing =
          error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!reportIsMissing) throw error;
      }
    }
  }
  return measurements;
}

function metricsForModel(
  model: string,
  results: readonly RunResult[],
  countedPrefixes: ReadonlyMap<string, readonly number[]>,
): ModelMetrics {
  const rows = results.filter((result) => result.model === model);
  const exactPrefixes = countedPrefixes.get(model) ?? [];
  const estimatedPrefixes = rows
    .map((result) => result.requestOnePrefixTokens)
    .filter((tokens) => tokens > 0);
  const metrics: ModelMetrics = {
    model,
    pass: rows.filter((row) => row.verdict === "pass").length,
    fail: rows.filter((row) => row.verdict === "fail").length,
    timeout: rows.filter((row) => row.verdict === "timeout").length,
    blocked: rows.filter((row) => row.verdict === "blocked").length,
    prefixEstimatedTokens: average(estimatedPrefixes),
    rewriteRate: rows.length > 0 ? rows.filter((row) => row.rewrites > 0).length / rows.length : 0,
    averageTotalTokens: average(rows.map(totalTokens)),
    totalCost: rows.reduce((sum, row) => sum + row.cost, 0),
  };
  if (exactPrefixes.length > 0) metrics.prefixCountedTokens = average(exactPrefixes);
  return metrics;
}

function mergedMarkdown(summary: MergedSummary): string {
  const lines = [
    "# Merged prefix evaluation matrix",
    "",
    "| Model | Pass | Fail | Timeout | Blocked | Prefix estimated tokens | Prefix counted tokens | Rewrite rate | Avg total tokens | Total cost |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const metrics of summary.perModel) {
    lines.push(
      `| ${metrics.model} | ${metrics.pass} | ${metrics.fail} | ${metrics.timeout} | ${metrics.blocked} | ${Math.round(metrics.prefixEstimatedTokens)} | ${metrics.prefixCountedTokens === undefined ? "—" : Math.round(metrics.prefixCountedTokens)} | ${(metrics.rewriteRate * 100).toFixed(1)}% | ${Math.round(metrics.averageTotalTokens)} | ${metrics.totalCost.toFixed(4)} |`,
    );
  }
  const taskIds = [...new Set(summary.results.map((result) => result.taskId))];
  lines.push("", "## Per-task verdicts", "");
  lines.push(`| Model | ${taskIds.join(" | ")} |`);
  lines.push(`|---|${taskIds.map(() => "---").join("|")}|`);
  for (const model of summary.models) {
    const verdicts = taskIds.map(
      (taskId) =>
        summary.results.find((result) => result.model === model.model && result.taskId === taskId)
          ?.verdict ?? "missing",
    );
    lines.push(`| ${model.model} | ${verdicts.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function mergeMatrices(
  runDirectories: readonly string[],
  outDirectory: string,
): Promise<MergedSummary> {
  const summaries = await Promise.all(
    runDirectories.map((directory) =>
      readValidatedJson(join(directory, "summary.json"), MatrixSummarySchema, "matrix summary"),
    ),
  );
  const models = summaries.flatMap((summary) => summary.models);
  const duplicateModels = models.filter(
    (model, index) => models.findIndex((candidate) => candidate.model === model.model) !== index,
  );
  if (duplicateModels.length > 0) {
    throw new Error(
      `Merged matrices contain duplicate models: ${duplicateModels.map((model) => model.model).join(", ")}`,
    );
  }
  const results = summaries.flatMap((summary) => summary.results);
  const countedPrefixes = await countedAnthropicPrefixes(runDirectories);
  const summary: MergedSummary = {
    models,
    results,
    perModel: models.map((model) => metricsForModel(model.model, results, countedPrefixes)),
  };
  await mkdir(outDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(join(outDirectory, "summary.md"), mergedMarkdown(summary), { mode: 0o600 }),
  ]);
  return summary;
}

async function persistSummary(outDir: string, summary: MatrixSummary): Promise<void> {
  await Promise.all([
    writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(join(outDir, "summary.md"), markdownSummary(summary), { mode: 0o600 }),
  ]);
}

async function readTasks(tasksPath: string): Promise<TaskSpec[]> {
  const tasks = await readValidatedJson(tasksPath, TaskSpecsSchema, "task specifications");
  const uniqueIds = new Set(tasks.map((task) => task.id));
  if (uniqueIds.size !== tasks.length) throw new Error("Task IDs must be unique");
  return tasks;
}

async function archiveIncompleteTaskDirectory(taskDirectory: string): Promise<void> {
  try {
    await rename(taskDirectory, `${taskDirectory}.attempt-${Date.now()}`);
  } catch (error) {
    const directoryIsMissing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!directoryIsMissing) throw error;
  }
}

function emptyFailure(model: string, taskId: string, reason: string): RunResult {
  return {
    model,
    taskId,
    verdict: "fail",
    reason,
    processTimedOut: false,
    turns: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    cacheHitRatio: 0,
    rewrites: 0,
    wallMs: 0,
    cost: 0,
    directToolCalls: [],
    inExecToolCalls: [],
    discoveryFailures: 0,
    finalMessage: "",
    requestOnePrefixTokens: 0,
    deviations: [],
  };
}

interface ProcessAdjudicationOptions {
  task: TaskSpec;
  workspace: string;
  fixturePath: string;
  usage: Awaited<ReturnType<typeof readSessionUsage>>;
  processTimedOut: boolean;
}

export async function adjudicateProcessOutcome({
  task,
  workspace,
  fixturePath,
  usage,
  processTimedOut,
}: ProcessAdjudicationOptions): Promise<Pick<RunResult, "verdict" | "reason" | "deviations">> {
  if (processTimedOut && usage.finalMessage.trim().length === 0) {
    return {
      verdict: "timeout",
      reason: `Pi timed out after ${task.timeoutMs ?? 240_000} ms with no assistant final message`,
      deviations: [],
    };
  }
  const adjudication = await evaluateTaskVerdict(task, workspace, fixturePath, usage);
  if (processTimedOut && adjudication.verdict === "pass") {
    return {
      ...adjudication,
      reason: `${adjudication.reason}; process did not exit; judged on final message`,
    };
  }
  return adjudication;
}

async function executeTask(
  model: ModelSpec,
  task: TaskSpec,
  fixturePath: string,
  taskDirectory: string,
): Promise<RunResult> {
  const workspace = join(taskDirectory, "workspace");
  await mkdir(taskDirectory, { recursive: true });
  await cp(fixturePath, workspace, { recursive: true, errorOnExist: true, force: false });
  const run = await runPi({
    model: model.model,
    thinking: model.thinking,
    cwd: workspace,
    outDir: taskDirectory,
    prompts: task.prompts,
    timeoutMs: task.timeoutMs ?? 240_000,
  });
  const usage = await readSessionUsage(run.sessionDirectory);
  const captureRecords = await readCaptureRecords(run.capturePath);
  const denominator = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
  const prefixTokens = requestOnePrefixTokens(captureRecords);

  let verdict: RunResult["verdict"];
  let reason: string;
  let deviations: string[] = [];
  if (!run.timedOut && run.exitCode !== 0) {
    const processOutput = `${run.stderr}\n${run.stdout}\n${usage.assistantText}`;
    verdict =
      /authentication|unauthorized|quota|rate limit|provider unavailable|model unavailable/i.test(
        processOutput,
      )
        ? "blocked"
        : "fail";
    reason = `Pi exited with status ${run.exitCode ?? "unknown"}`;
  } else {
    const adjudication = await adjudicateProcessOutcome({
      task,
      workspace,
      fixturePath,
      usage,
      processTimedOut: run.timedOut,
    });
    verdict = adjudication.verdict;
    reason = adjudication.reason;
    deviations = adjudication.deviations;
  }

  return {
    model: model.model,
    taskId: task.id,
    verdict,
    reason,
    processTimedOut: run.timedOut,
    turns: usage.turns,
    tokens: usage.tokens,
    cacheHitRatio: denominator > 0 ? usage.tokens.cacheRead / denominator : 0,
    rewrites: countStructuralRewrites(captureRecords),
    wallMs: run.wallMs,
    cost: usage.cost,
    directToolCalls: usage.directToolCalls,
    inExecToolCalls: usage.inExecToolCalls,
    discoveryFailures: usage.discoveryFailures,
    finalMessage: usage.finalMessage,
    requestOnePrefixTokens: prefixTokens,
    deviations,
  };
}

async function resultForTask(
  options: MatrixOptions,
  model: ModelSpec,
  task: TaskSpec,
): Promise<RunResult> {
  const taskDirectory = join(options.outDir, modelSlug(model.model), task.id);
  const resultPath = join(taskDirectory, "result.json");
  if (options.resume) {
    try {
      return await readValidatedJson(resultPath, RunResultSchema, "matrix result");
    } catch (error) {
      const resultFileIsMissing =
        error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!resultFileIsMissing) {
        const reason = error instanceof Error ? error.message : "invalid existing result";
        return emptyFailure(model.model, task.id, `Cannot resume row: ${reason}`);
      }
    }
  }

  await archiveIncompleteTaskDirectory(taskDirectory);
  try {
    const result = await executeTask(model, task, options.fixturePath, taskDirectory);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown harness failure";
    const result = emptyFailure(model.model, task.id, reason);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
}

export async function runMatrix(options: MatrixOptions): Promise<MatrixSummary> {
  const tasks = await readTasks(options.tasksPath);
  const models = orderModels(options.models);
  const summary: MatrixSummary = { models, results: [] };
  await mkdir(options.outDir, { recursive: true });
  await writeFile(join(options.outDir, "tasks.json"), await readFile(options.tasksPath, "utf8"), {
    mode: 0o600,
  });

  for (const model of models) {
    for (const task of tasks) {
      process.stdout.write(`Running ${model.model} ${task.id}\n`);
      const result = await resultForTask(options, model, task);
      summary.results.push(result);
      await persistSummary(options.outDir, summary);
    }
  }
  return summary;
}

export async function readjudicateMatrix(
  runDirectory: string,
  tasksPath: string,
  fixturePath: string,
): Promise<MatrixSummary> {
  const summary = await readValidatedJson(
    join(runDirectory, "summary.json"),
    MatrixSummarySchema,
    "matrix summary",
  );
  const tasks = await readTasks(tasksPath);
  for (const result of summary.results) {
    const task = tasks.find((candidate) => candidate.id === result.taskId);
    if (!task) throw new Error(`No task specification found for ${result.taskId}`);
    const taskDirectory = join(runDirectory, modelSlug(result.model), result.taskId);
    const workspace = join(taskDirectory, "workspace");
    const processTimedOut = result.processTimedOut ?? result.verdict === "timeout";
    result.processTimedOut = processTimedOut;
    try {
      const usage = await readSessionUsage(join(taskDirectory, "sessions"));
      const captureRecords = await readCaptureRecords(join(taskDirectory, "capture.jsonl"));
      const adjudication = await adjudicateProcessOutcome({
        task,
        workspace,
        fixturePath,
        usage,
        processTimedOut,
      });
      result.verdict = adjudication.verdict;
      result.reason = adjudication.reason;
      result.deviations = adjudication.deviations;
      result.finalMessage = usage.finalMessage;
      result.requestOnePrefixTokens = requestOnePrefixTokens(captureRecords);
      result.rewrites = countStructuralRewrites(captureRecords);
    } catch (error) {
      if (!processTimedOut) {
        result.verdict = "fail";
        result.reason =
          error instanceof Error
            ? `Cannot readjudicate stored artifacts: ${error.message}`
            : "Cannot readjudicate stored artifacts";
      }
    }
    await writeFile(join(taskDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  await persistSummary(runDirectory, summary);
  return summary;
}

async function main(): Promise<void> {
  const options = parseNamedOptions(process.argv.slice(2), new Set(["resume"]));
  const merge = options.get("merge");
  if (isString(merge)) {
    const runDirectories = merge.split(",").map((directory) => resolve(directory));
    await mergeMatrices(runDirectories, resolve(requiredStringOption(options, "out")));
    return;
  }
  const tasksPath = resolve(requiredStringOption(options, "tasks"));
  const fixturePath = resolve(requiredStringOption(options, "fixture"));
  const readjudicate = options.get("readjudicate");
  if (isString(readjudicate)) {
    await readjudicateMatrix(resolve(readjudicate), tasksPath, fixturePath);
    return;
  }
  const models = requiredStringOption(options, "models").split(",").map(parseModelSpec);
  await runMatrix({
    models,
    tasksPath,
    fixturePath,
    outDir: resolve(requiredStringOption(options, "out")),
    resume: options.get("resume") === true,
  });
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) await main();
