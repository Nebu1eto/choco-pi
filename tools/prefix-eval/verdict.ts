import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionUsage, TaskSpec, VerdictSpec } from "./types.ts";

export interface VerdictCheckResult {
  passed: boolean;
  reason: string;
}

export interface TaskVerdictResult {
  verdict: "pass" | "fail" | "blocked";
  reason: string;
  deviations: string[];
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function pathInsideFixture(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const pathFromRoot = relative(resolve(root), target);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Verdict path escapes the fixture: ${relativePath}`);
  }
  return target;
}

function runCommand(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 30_000);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolveResult({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function passingTests(output: string): number {
  const cleanOutput = stripVTControlCharacters(output);
  const match = cleanOutput.match(/\bpass\s+(\d+)/);
  return match?.[1] ? Number(match[1]) : 0;
}

function toolWasCalled(usage: SessionUsage, name: string): boolean {
  return usage.directToolCalls.includes(name) || usage.inExecToolCalls.includes(name);
}

export async function evaluateVerdict(
  spec: VerdictSpec,
  workspace: string,
  originalFixture: string,
  usage: SessionUsage,
): Promise<VerdictCheckResult> {
  if (spec.kind === "finalMessageMatches") {
    const caseInsensitivePattern = spec.regex.toLowerCase();
    const passed = Value.Check(
      Type.String({ pattern: caseInsensitivePattern }),
      usage.finalMessage.toLowerCase(),
    );
    return { passed, reason: `final message must match /${spec.regex}/i` };
  }
  if (spec.kind === "toolCalled") {
    const passed = toolWasCalled(usage, spec.name);
    return { passed, reason: `tool ${spec.name} must be called` };
  }
  if (spec.kind === "command") {
    const result = await runCommand(spec.cmd, workspace);
    return {
      passed: !result.timedOut && result.exitCode === spec.expectExitCode,
      reason: `command ${spec.cmd} exited ${result.exitCode ?? "without a status"}; expected ${spec.expectExitCode}`,
    };
  }
  if (spec.kind === "testPattern") {
    const escapedPattern = spec.pattern.replaceAll("'", "'\\''");
    const command = `node --test --test-name-pattern='${escapedPattern}' tests/*.test.ts`;
    const result = await runCommand(command, workspace);
    const passedCount = passingTests(`${result.stdout}\n${result.stderr}`);
    return {
      passed: !result.timedOut && result.exitCode === 0 && passedCount >= spec.minPassing,
      reason: `test pattern ${spec.pattern} exited ${result.exitCode ?? "without a status"} with ${passedCount} passing tests; required ${spec.minPassing}`,
    };
  }

  try {
    const actual = await readFile(pathInsideFixture(workspace, spec.path), "utf8");
    if (spec.kind === "fileContains") {
      return {
        passed: actual.includes(spec.substring),
        reason: `${spec.path} must contain ${JSON.stringify(spec.substring)}`,
      };
    }
    const original = await readFile(pathInsideFixture(originalFixture, spec.path), "utf8");
    return { passed: actual === original, reason: `${spec.path} must remain unchanged` };
  } catch (error) {
    return {
      passed: false,
      reason: error instanceof Error ? error.message : `could not inspect ${spec.path}`,
    };
  }
}

export async function evaluateTaskVerdict(
  task: TaskSpec,
  workspace: string,
  originalFixture: string,
  usage: SessionUsage,
): Promise<TaskVerdictResult> {
  const deviations: string[] = [];
  if (task.id === "delegate-readonly" && !toolWasCalled(usage, "Agent")) {
    deviations.push("Agent was not called");
  }
  if (
    task.id === "mcp-readonly" &&
    /unauthenticated|not authenticated|authentication required|not configured|unavailable/i.test(
      usage.assistantText,
    )
  ) {
    return {
      verdict: "blocked",
      reason: "Linear MCP is unavailable or unauthenticated",
      deviations,
    };
  }
  if (
    task.id === "mcp-readonly" &&
    (usage.toolErrors.includes("mcp") ||
      /(?:mcp|linear).*(?:failed|error)|(?:unable|failed|could not|cannot) to (?:list|fetch|access|connect)/i.test(
        usage.assistantText,
      ))
  ) {
    return {
      verdict: "fail",
      reason: "Linear MCP operation reported an error",
      deviations,
    };
  }

  const checks = await Promise.all(
    task.verdicts.map((spec) => evaluateVerdict(spec, workspace, originalFixture, usage)),
  );
  if (task.expectedTurns !== undefined) {
    checks.push({
      passed: usage.turns === task.expectedTurns,
      reason: `expected ${task.expectedTurns} turns; observed ${usage.turns}`,
    });
  }
  const failures = checks.filter((check) => !check.passed);
  return failures.length === 0
    ? { verdict: "pass", reason: "all verdict checks passed", deviations }
    : { verdict: "fail", reason: failures.map((failure) => failure.reason).join("; "), deviations };
}
