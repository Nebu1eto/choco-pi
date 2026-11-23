import type { ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

export const WAIT_BOUND_MS = 5000;
export const KILL_GRACE_MS = 2000;

export type Bounded<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(work: Promise<T>): Promise<Bounded<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function within<T>(work: Promise<T>, ms: number): Promise<Bounded<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `timeout after ${ms}ms` }), ms);
  });
  try {
    return await Promise.race([settle(work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export function exitOf(child: ChildProcess): Promise<Exit> {
  if (exited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code, signal }),
    );
    child.once("error", (error: Error) =>
      resolve({ code: null, signal: null, error: error.message }),
    );
  });
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (exited(child) || child.pid === undefined) return;
  try {
    child.kill(name);
  } catch {}
}

export function escalate(child: ChildProcess, graceMs = KILL_GRACE_MS): () => void {
  signal(child, "SIGTERM");
  const timer = setTimeout(() => signal(child, "SIGKILL"), graceMs);
  const clear = (): void => clearTimeout(timer);
  child.once("exit", clear);
  return clear;
}

export async function stopProcess(
  child: ChildProcess,
  label: string,
  graceMs = KILL_GRACE_MS,
  boundMs = WAIT_BOUND_MS,
): Promise<string | undefined> {
  if (exited(child) || child.pid === undefined) return undefined;
  const exit = exitOf(child);
  const cancel = escalate(child, graceMs);
  const result = await within(exit, boundMs);
  cancel();
  return result.ok ? undefined : `${label} did not exit after SIGTERM/SIGKILL (${result.error})`;
}

export async function drainOutput(
  child: ChildProcess,
  label: string,
  boundMs = WAIT_BOUND_MS,
): Promise<string | undefined> {
  const streams = [child.stdout, child.stderr].filter(
    (stream): stream is Readable => stream !== null,
  );
  const result = await within(
    Promise.all(streams.map((stream) => finished(stream, { writable: false }))),
    boundMs,
  );
  if (result.ok) return undefined;
  for (const stream of streams) stream.destroy();
  return `${label} output did not close (${result.error})`;
}

export interface Sink {
  stream: WriteStream;
  errors: string[];
}

export function sink(path: string): Sink {
  const errors: string[] = [];
  const stream = createWriteStream(path);
  stream.on("error", (error: Error) => errors.push(error.message));
  return { stream, errors };
}

export async function closeSink(
  target: Sink,
  label: string,
  boundMs = WAIT_BOUND_MS,
): Promise<string[]> {
  const { stream } = target;
  if (!stream.writableEnded && !stream.destroyed) stream.end();
  const result = await within(finished(stream, { readable: false }), boundMs);
  const defects = target.errors.map((error) => `${label} write error (${error})`);
  if (!result.ok) {
    stream.destroy();
    if (!target.errors.includes(result.error))
      defects.push(`${label} did not flush (${result.error})`);
  }
  return defects;
}
