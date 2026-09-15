import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Value } from "typebox/value";
import {
  AgentTraceSchema,
  assertFinal,
  decodeProbeEventLine,
  decodeTranscriptLine,
  ErrorCodeSchema,
  ErrorStatusSchema,
  ExecArgumentsSchema,
  finalAssistant,
  isLookupExecCode,
  type ProbeAgentEnd,
  type ProbeMessage,
  type ProbeToolEnd,
  type ProbeToolResult,
  type ProbeToolStart,
  resultText,
  toolCallsOf,
  ToolResultSchema,
} from "./code-mode-probe-events.ts";

const enabled = process.env["CHOCO_PI_CODE_MODE_FIRST_E2E"] === "1";
const MODEL = "openai-codex/gpt-5.6-sol";
const PROMPT = `This is an authorized, bounded read-only runtime acceptance probe, not an implementation task. Do not edit files, run setup, commit, create goals, change settings, or start any workflow. Do not read credentials. Choose available tools naturally; do not assume a named tool is a filesystem reader. First perform both independent lookups yourself: (1) read package.json and report name and packageManager; (2) read .pi/packages/choco-pi-codex/package.json and report name and version. Then use the Agent tool to launch exactly one explore child, model openai-codex/gpt-5.6-sol, named probe-code-child, with the same two independent read-only lookups. Include all these exclusions and the explicit Sol model restriction in its self-contained prompt. Do not spawn Astra or Fable. The child must not delegate. Retrieve the child's result once after completion; use the notification rather than polling. Report your answers and the child's answers. Keep final output short. No historical session audit: the owning orchestrator audits this probe's lineage.
`;
const EXPECTED = ["choco-pi-harness", "pnpm@11.11.0", "choco-pi-codex", "0.1.0"];
const execFileAsync = promisify(execFile);

type RootMetrics = {
  outerChoices: [string, number][];
  rootExecCalls: number;
  usefulRootExecCalls: number;
  failedRootExec: number;
};
type ChildMetrics = {
  childChoices: string[];
  usefulChildExecCalls: number;
  childExecResults: number;
  failedChildExec: number;
};
type FailureSummary = { name: string; message: string };

function signalGroup(pid: number, signal: NodeJS.Signals): string | undefined {
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (error) {
    if (Value.Check(ErrorCodeSchema, error)) return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

test(
  "real Sol root and explore child choose code mode first",
  { skip: !enabled, timeout: 240_000 },
  async (t) => {
    const root = process.cwd();
    const taskRoot = join(
      "/tmp/choco-pi",
      process.env["PI_SESSION_ID"] ?? "manual",
      "code-mode-first-",
    );
    await mkdir(join(taskRoot, ".."), { recursive: true });
    const runDir = await mkdtemp(taskRoot);
    const sessionDir = join(runDir, "sessions");
    const promptPath = join(runDir, "probe.txt");
    const evidencePath = join(runDir, "evidence.json");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(promptPath, PROMPT, "utf8");
    const startedAt = new Date().toISOString();
    const { stdout: beforeRevisionOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const beforeRevision = beforeRevisionOutput.trim();
    const args = [
      "--mode",
      "json",
      "--print",
      "--model",
      MODEL,
      "--thinking",
      "low",
      "--session-dir",
      sessionDir,
      `@${promptPath}`,
    ];
    const command = ["pi", ...args];
    const child = spawn("pi", args, {
      cwd: root,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    let buffered = "";
    let rootEnd: ProbeAgentEnd | undefined;
    const starts = new Map<string, ProbeToolStart>();
    const toolEnds: ProbeToolEnd[] = [];
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // Malformed output is not an event; it only feeds the bounded failure summary.
        const event = decodeProbeEventLine(line);
        if (event === undefined) continue;
        if (event.kind === "agentEnd") rootEnd = event.event;
        else if (event.kind === "toolStart") starts.set(event.event.toolCallId, event.event);
        else toolEnds.push(event.event);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let spawnFailure: Error | undefined;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", (error) => {
          spawnFailure = error;
          resolve({ code: null, signal: null });
        });
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    let cleanupError: string | undefined;
    let forcedTermination = false;
    /** Retain the first cleanup failure without ever skipping a later cleanup attempt. */
    const recordCleanupError = (message: string | undefined): void => {
      if (message !== undefined) cleanupError ??= message;
    };
    // The probe owns a detached process group: kill it even if the test is aborted or times out,
    // when the async body below may never resume.
    const onAbort = (): void => {
      if (child.exitCode === null && child.pid !== undefined) {
        forcedTermination = true;
        recordCleanupError(signalGroup(child.pid, "SIGKILL") ?? "probe aborted");
      }
    };
    t.signal.addEventListener("abort", onAbort, { once: true });
    let teardown: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      const deadline = Date.now() + 180_000;
      while (
        !rootEnd &&
        !spawnFailure &&
        child.exitCode === null &&
        !t.signal.aborted &&
        Date.now() < deadline
      )
        await delay(100);
      if (rootEnd && child.exitCode === null) {
        await Promise.race([closed, delay(2_000)]);
      }
    } finally {
      if (child.exitCode === null && child.pid !== undefined) {
        forcedTermination = true;
        recordCleanupError(signalGroup(child.pid, "SIGTERM"));
        await Promise.race([closed, delay(2_000)]);
      }
      if (child.exitCode === null && child.pid !== undefined) {
        recordCleanupError(signalGroup(child.pid, "SIGKILL"));
      }
      teardown = await Promise.race([closed, delay(5_000).then(() => undefined)]);
      if (!teardown) recordCleanupError("Pi process did not close after SIGKILL");
      // The group is gone: drop the abort listener so a later abort cannot signal a reused pid.
      else t.signal.removeEventListener("abort", onAbort);
    }

    let failure: unknown;
    let rootMetrics: RootMetrics | undefined;
    let childMetrics: ChildMetrics | undefined;
    try {
      if (spawnFailure) throw spawnFailure;
      assert.ok(teardown, cleanupError ?? "Pi teardown result missing");
      assert.ok(rootEnd, `root did not settle; stderr bytes: ${Buffer.byteLength(stderr)}`);
      const outerChoices = new Map<string, number>();
      for (const start of starts.values())
        outerChoices.set(start.toolName, (outerChoices.get(start.toolName) ?? 0) + 1);
      const successfulExec = new Map<string, ProbeToolEnd>();
      let failedRootExec = 0;
      for (const end of toolEnds) {
        if (end.toolName !== "exec") continue;
        if (end.isError) failedRootExec += 1;
        else successfulExec.set(end.toolCallId, end);
      }
      const usefulRootExec = [...successfulExec.keys()].filter((id) => {
        const callArguments = starts.get(id)?.args;
        return (
          Value.Check(ExecArgumentsSchema, callArguments) && isLookupExecCode(callArguments.code)
        );
      });
      rootMetrics = {
        outerChoices: [...outerChoices]
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, 20),
        rootExecCalls: successfulExec.size,
        usefulRootExecCalls: usefulRootExec.length,
        failedRootExec,
      };
      assert.equal(failedRootExec, 0, "root had failed exec wrapper calls");
      assert.ok(usefulRootExec.length > 0, "root had no successful exec containing both lookups");
      assertFinal(finalAssistant(rootEnd.messages), "root", EXPECTED);

      const agentResults: ProbeToolResult[] = [];
      for (const end of successfulExec.values()) {
        if (!Value.Check(ToolResultSchema, end.result)) continue;
        for (const trace of end.result.details?.traces ?? []) {
          if (
            Value.Check(AgentTraceSchema, trace) &&
            trace.name === "Agent" &&
            trace.status === "done"
          )
            agentResults.push(trace.result);
        }
      }
      for (const end of toolEnds) {
        if (end.toolName !== "Agent" || end.isError) continue;
        if (Value.Check(ToolResultSchema, end.result)) agentResults.push(end.result);
      }
      const agentResult = agentResults.find(
        (candidate) =>
          resultText(candidate).includes("Output file:") && candidate.details !== undefined,
      );
      assert.ok(agentResult, "no successful direct or nested Agent result exposed output metadata");
      const agentId = agentResult.details?.agentId;
      assert.ok(agentId !== undefined && agentId.length > 0, "details.agentId missing");
      const outputMatch = resultText(agentResult).match(/Output file:\s*(\/[^\s]+)/);
      const outputPath = outputMatch?.[1];
      assert.ok(outputPath, "Agent Output file missing");
      const childMessages: ProbeMessage[] = [];
      for (const line of (await readFile(outputPath, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        // A non-JSON transcript line carries no message contract; skip it.
        const message = decodeTranscriptLine(line);
        if (message !== undefined) childMessages.push(message);
      }
      const childToolCalls = toolCallsOf(childMessages);
      const childExecCalls = childToolCalls.filter(
        (call) =>
          call.name === "exec" &&
          Value.Check(ExecArgumentsSchema, call.arguments) &&
          isLookupExecCode(call.arguments.code),
      );
      const childExecResults = childMessages.filter(
        (message) => message.role === "toolResult" && message.toolName === "exec",
      );
      let failedChildExec = 0;
      const successfulChildIds = new Set<string>();
      for (const message of childExecResults) {
        const failed = message.isError !== false || Value.Check(ErrorStatusSchema, message.details);
        if (failed) failedChildExec += 1;
        else if (message.toolCallId) successfulChildIds.add(message.toolCallId);
      }
      const correlatedUsefulChildExec = childExecCalls.filter((call) =>
        successfulChildIds.has(call.id),
      );
      childMetrics = {
        childChoices: [...new Set(childToolCalls.map((call) => call.name))].sort().slice(0, 20),
        usefulChildExecCalls: correlatedUsefulChildExec.length,
        childExecResults: childExecResults.length,
        failedChildExec,
      };
      assert.equal(failedChildExec, 0, "child had failed exec wrapper calls");
      assert.ok(
        correlatedUsefulChildExec.length > 0,
        "child has no correlated successful lookup exec call/result",
      );
      assertFinal(finalAssistant(childMessages), "child", EXPECTED);
    } catch (error) {
      failure = error;
    }
    const { stdout: afterRevisionOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const afterRevision = afterRevisionOutput.trim();
    if (beforeRevision !== afterRevision) failure ??= new Error("revision changed during probe");
    const failureSummary: FailureSummary | undefined =
      failure === undefined
        ? undefined
        : failure instanceof Error
          ? { name: failure.name, message: failure.message.slice(0, 300) }
          : { name: "UnknownFailure", message: String(failure).slice(0, 300) };
    const metrics = { ...rootMetrics, ...childMetrics };
    const evidence = {
      startedAt,
      completedAt: new Date().toISOString(),
      revision: beforeRevision,
      revisionUnchanged: beforeRevision === afterRevision,
      model: MODEL,
      command,
      behavioralPass: failure === undefined,
      failure: failureSummary,
      metrics,
      teardown: { ...teardown, forcedTermination, cleanupError },
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({ behavioralPass: evidence.behavioralPass, model: MODEL, revision: beforeRevision, metrics, teardown: evidence.teardown, evidencePath })}\n`,
    );
    if (failure !== undefined) throw failure;
  },
);
