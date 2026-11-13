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
  deadlineMs: number;
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
  /** Harness-side failures (unbounded waits that timed out, sink errors); never model faults. */
  defects: string[];
}
/**
 * Run one Pi scenario. `deadline` aborts it: Pi gets SIGTERM, then SIGKILL after
 * KILL_GRACE_MS. Every wait after Pi's exit is bounded by WAIT_BOUND_MS and a timeout is
 * reported in `defects` instead of blocking the run.
 */
export async function launch(
  p: Plan,
  deadline: AbortSignal,
  scenario: ScenarioId,
  /** Tier B S5: the fixture-owned mutation that replaces the fake daemon's wire mutation. */
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
  // Explicit writes, not pipe(): pipe() ends `err` at stderr EOF, so its `finish` can fire
  // before this function waits for it and the wait never resolves.
  child.stderr.on("data", (chunk: Buffer) => err.stream.write(chunk));
  let stream = "";
  let injected = false;
  // Wrapped in `within` at creation so an early wire failure is captured, never an
  // unhandled rejection while Pi is still running.
  let intervention: Promise<Bounded<RecordValue>> | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    out.stream.write(chunk);
    stream += chunk.toString("utf8");
    let newline = stream.indexOf("\n");
    while (newline >= 0) {
      const line = stream.slice(0, newline);
      stream = stream.slice(newline + 1);
      try {
        const item: JsonValue = JSON.parse(line);
        // S4 has no harness stimulus: the fake daemon holds the typeText past the transport
        // timeout, and the TS transport itself sends the cancel. Pi is never signalled.
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
                  deadlineMs: Date.now() + 2000,
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
              deadlineMs: Date.now() + 2000,
              policy: "background",
              action: "click",
              x: 1,
              y: 1,
            }),
            WAIT_BOUND_MS,
          );
        }
      } catch {
        /* malformed JSON is rejected during assertion */
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
    // Pi normally exits on its own; after the deadline it gets SIGTERM then SIGKILL, so this
    // bound only trips if even SIGKILL fails to reap it.
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
    // A descendant that inherited Pi's pipes could hold them open; drain is bounded.
    const drain = await drainOutput(child, "pi");
    if (drain) defects.push(drain);
    defects.push(...(await closeSink(out, "events")), ...(await closeSink(err, "stderr")));
  }
}
/** Wait for exit; once the deadline fires allow the SIGKILL grace plus WAIT_BOUND_MS. */
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
