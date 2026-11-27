import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { RecordValue } from "./assertions.ts";
import { isJsonObject, type JsonValue } from "../src/json.ts";
import type { Plan } from "./isolation.ts";
import type { ScenarioId } from "./scenarios/index.ts";
import {
  KILL_GRACE_MS,
  WAIT_BOUND_MS,
  closeSink,
  drainOutput,
  escalate,
  exitOf,
  sink,
  stopProcess,
  within,
  type Bounded,
  type Exit,
} from "./process.ts";
interface InterventionRequest {
  id: string;
  cmd: "look" | "act";
  session: { id: string; generation: number };
  budgetMs: number;
  fixtureMutation?: string;
  policy?: string;
  action?: string;
  x?: number;
  y?: number;
}
type WireRequest =
  | InterventionRequest
  | { id: string; cmd: "diagnostics" | "checkPermissions" }
  | { id: string; cmd: "claim" | "release"; session: { id: string; generation: number } };
export async function wire(socket: string, request: WireRequest): Promise<RecordValue> {
  return await new Promise((resolve, reject) => {
    const client = connect(socket);
    let buffer = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("WIRE_TIMEOUT"));
    }, 2000);
    client.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.once("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      client.end();
      try {
        const response: JsonValue = JSON.parse(buffer.slice(0, end));
        if (!isJsonObject(response)) throw new Error("INVALID_WIRE_RESPONSE");
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
  });
}
export interface LaunchResult {
  code: number;
  timedOut: boolean;
  intervention?: RecordValue;
  defects: string[];
}
export function parseEventLine(line: string): JsonValue | undefined {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
export async function launch(
  p: Plan,
  deadline: AbortSignal,
  scenario: ScenarioId,
  mutate?: () => Promise<RecordValue>,
): Promise<LaunchResult> {
  if (deadline.aborted) return { code: 1, timedOut: true, defects: [] };
  await mkdir(join(p.events, ".."), { recursive: true });
  if (deadline.aborted) return { code: 1, timedOut: true, defects: [] };
  const out = sink(p.events);
  const err = sink(p.stderr);
  const child = spawn(p.executable, p.args, {
    cwd: p.cwd,
    env: p.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = exitOf(child);
  child.stderr.on("data", (chunk: Buffer) => err.stream.write(chunk));
  let stream = "";
  let injected = false;
  let intervention: Promise<Bounded<RecordValue>> | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    out.stream.write(chunk);
    stream += chunk.toString("utf8");
    let newline = stream.indexOf("\n");
    while (newline >= 0) {
      const line = stream.slice(0, newline);
      stream = stream.slice(newline + 1);
      const item = parseEventLine(line);
      if (
        isJsonObject(item) &&
        !injected &&
        scenario === "S5" &&
        item.type === "tool_execution_end" &&
        item.toolName === "observe_ui"
      ) {
        injected = true;
        intervention = within(
          mutate
            ? mutate()
            : wire(p.socket, {
                id: randomUUID(),
                cmd: "look",
                session: { id: p.sessionId, generation: 0 },
                budgetMs: 2000,
                fixtureMutation: "bump_root_generation",
              }),
          WAIT_BOUND_MS,
        );
      }
      if (
        isJsonObject(item) &&
        !injected &&
        scenario === "S7" &&
        item.type === "tool_execution_end" &&
        item.toolName === "act_ui"
      ) {
        injected = true;
        intervention = within(
          wire(p.socket, {
            id: randomUUID(),
            cmd: "act",
            session: { id: randomUUID(), generation: 0 },
            budgetMs: 2000,
            policy: "background",
            action: "click",
            x: 1,
            y: 1,
          }),
          WAIT_BOUND_MS,
        );
      }
      newline = stream.indexOf("\n");
    }
  });
  let timedOut = false;
  let cancelKill: (() => void) | undefined;
  const onDeadline = (): void => {
    timedOut = true;
    cancelKill = escalate(child);
  };
  deadline.addEventListener("abort", onDeadline, { once: true });
  const defects: string[] = [];
  let code = 1;
  try {
    const ended = await exitOrDeadline(exit, deadline);
    if (!ended.ok) defects.push(`pi did not exit (${ended.error})`);
    else if (ended.value.error) defects.push(`pi spawn error (${ended.value.error})`);
    else if (Number.isInteger(ended.value.code)) code = Number(ended.value.code);
    let settled: RecordValue | undefined;
    if (intervention) {
      const answer = await intervention;
      if (answer.ok) settled = answer.value;
      else defects.push(`intervention (${answer.error})`);
    }
    return { code, timedOut, intervention: settled, defects };
  } finally {
    deadline.removeEventListener("abort", onDeadline);
    cancelKill?.();
    const stop = await stopProcess(child, "pi");
    if (stop) defects.push(stop);
    const drain = await drainOutput(child, "pi");
    if (drain) defects.push(drain);
    defects.push(...(await closeSink(out, "events")), ...(await closeSink(err, "stderr")));
  }
}
async function exitOrDeadline(exit: Promise<Exit>, deadline: AbortSignal): Promise<Bounded<Exit>> {
  if (!deadline.aborted) {
    const aborted = new Promise<void>((resolve) =>
      deadline.addEventListener("abort", () => resolve(), { once: true }),
    );
    const first = await Promise.race([exit.then(() => true), aborted.then(() => false)]);
    if (first) return { ok: true, value: await exit };
  }
  return await within(exit, KILL_GRACE_MS + WAIT_BOUND_MS);
}
