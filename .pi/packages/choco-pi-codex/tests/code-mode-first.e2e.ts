import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const enabled = process.env["CHOCO_PI_CODE_MODE_FIRST_E2E"] === "1";
const MODEL = "openai-codex/gpt-5.6-sol";
const PROMPT = `This is an authorized, bounded read-only runtime acceptance probe, not an implementation task. Do not edit files, run setup, commit, create goals, change settings, or start any workflow. Do not read credentials. Choose available tools naturally; do not assume a named tool is a filesystem reader. First perform both independent lookups yourself: (1) read package.json and report name and packageManager; (2) read .pi/packages/choco-pi-codex/package.json and report name and version. Then use the Agent tool to launch exactly one explore child, model openai-codex/gpt-5.6-sol, named probe-code-child, with the same two independent read-only lookups. Include all these exclusions and the explicit Sol model restriction in its self-contained prompt. Do not spawn Astra or Fable. The child must not delegate. Retrieve the child's result once after completion; use the notification rather than polling. Report your answers and the child's answers. Keep final output short. No historical session audit: the owning orchestrator audits this probe's lineage.
`;
const EXPECTED = ["choco-pi-harness", "pnpm@11.11.0", "choco-pi-codex", "0.1.0"];
const execFileAsync = promisify(execFile);

/**
 * Wire contracts for the Pi JSON event stream and session transcript.
 *
 * Every schema is intentionally partial: only the fields this probe asserts on are named, and
 * unrelated payload fields (reasoning, signatures, usage, provider metadata) stay unmodelled and
 * are never read or printed. Nested payloads whose shape this probe does not own stay raw JSON and
 * are re-parsed through a narrow schema at the point of use instead of being widened into an open
 * dictionary.
 */
const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ToolCallBlockSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Optional(Type.Unknown()),
});
const ExecArgumentsSchema = Type.Object({ code: Type.String() });
const ErrorStatusSchema = Type.Object({ status: Type.Literal("error") });
const ErrorCodeSchema = Type.Object({ code: Type.Literal("ESRCH") });
const ToolResultDetailsSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  traces: Type.Optional(Type.Array(Type.Unknown())),
});
const ToolResultSchema = Type.Object({
  content: Type.Optional(Type.Array(Type.Unknown())),
  details: Type.Optional(ToolResultDetailsSchema),
});
const AgentTraceSchema = Type.Object({
  name: Type.String(),
  status: Type.String(),
  result: ToolResultSchema,
});
const NullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const MessageSchema = Type.Object({
  role: Type.String(),
  content: Type.Optional(Type.Array(Type.Unknown())),
  stopReason: NullableString,
  errorMessage: NullableString,
  toolName: NullableString,
  toolCallId: NullableString,
  isError: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  details: Type.Optional(Type.Unknown()),
});
const AgentEndEventSchema = Type.Object({
  type: Type.Literal("agent_end"),
  messages: Type.Array(MessageSchema),
});
const ToolStartEventSchema = Type.Object({
  type: Type.Literal("tool_execution_start"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  args: Type.Optional(Type.Unknown()),
});
const ToolEndEventSchema = Type.Object({
  type: Type.Literal("tool_execution_end"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  isError: Type.Boolean(),
  result: Type.Optional(Type.Unknown()),
});
const TranscriptEntrySchema = Type.Object({ message: MessageSchema });

type ProbeMessage = Static<typeof MessageSchema>;
type ProbeToolCall = Static<typeof ToolCallBlockSchema>;
type ProbeToolResult = Static<typeof ToolResultSchema>;
type ProbeAgentEnd = Static<typeof AgentEndEventSchema>;
type ProbeToolStart = Static<typeof ToolStartEventSchema>;
type ProbeToolEnd = Static<typeof ToolEndEventSchema>;

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

/** Decode the text blocks of a content array, ignoring every other block kind. */
function textFromContentBlocks(blocks: readonly unknown[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (Value.Check(TextBlockSchema, block)) parts.push(block.text);
  }
  return parts.join("\n");
}

function messageText(message: ProbeMessage): string {
  return textFromContentBlocks(message.content);
}

function resultText(result: ProbeToolResult): string {
  return textFromContentBlocks(result.content);
}

/** Decode the tool calls an assistant message issued. */
function toolCallsOf(messages: readonly ProbeMessage[]): ProbeToolCall[] {
  const calls: ProbeToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (Value.Check(ToolCallBlockSchema, block)) calls.push(block);
    }
  }
  return calls;
}

function isLookupExecCode(code: string): boolean {
  return code.includes("package.json") && code.includes(".pi/packages/choco-pi-codex/package.json");
}

function finalAssistant(messages: readonly ProbeMessage[]): ProbeMessage | undefined {
  return messages.findLast((message) => message.role === "assistant");
}

function assertFinal(message: ProbeMessage | undefined, subject: string): void {
  assert.ok(message, `${subject} final assistant message missing`);
  assert.equal(message.stopReason, "stop", `${subject} did not stop normally`);
  assert.equal(message.errorMessage, undefined, `${subject} returned an error`);
  const text = messageText(message);
  for (const expected of EXPECTED) assert.ok(text.includes(expected), `${subject}: ${expected}`);
}

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
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          // Malformed output is not an event; it only feeds the bounded failure summary.
          continue;
        }
        if (Value.Check(AgentEndEventSchema, raw)) rootEnd = raw;
        else if (Value.Check(ToolStartEventSchema, raw)) starts.set(raw.toolCallId, raw);
        else if (Value.Check(ToolEndEventSchema, raw)) toolEnds.push(raw);
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
    // The probe owns a detached process group: kill it even if the test is aborted or times out,
    // when the async body below may never resume.
    t.signal.addEventListener(
      "abort",
      () => {
        if (child.exitCode === null && child.pid !== undefined) {
          forcedTermination = true;
          cleanupError ??= signalGroup(child.pid, "SIGKILL") ?? "probe aborted";
        }
      },
      { once: true },
    );
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
        cleanupError ??= signalGroup(child.pid, "SIGTERM");
        await Promise.race([closed, delay(2_000)]);
      }
      if (child.exitCode === null && child.pid !== undefined) {
        cleanupError ??= signalGroup(child.pid, "SIGKILL");
      }
      teardown = await Promise.race([closed, delay(5_000).then(() => undefined)]);
      if (!teardown) cleanupError ??= "Pi process did not close after SIGKILL";
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
      assertFinal(finalAssistant(rootEnd.messages), "root");

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
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          // A non-JSON transcript line carries no message contract; skip it.
          continue;
        }
        if (Value.Check(TranscriptEntrySchema, raw)) childMessages.push(raw.message);
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
      assertFinal(finalAssistant(childMessages), "child");
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
