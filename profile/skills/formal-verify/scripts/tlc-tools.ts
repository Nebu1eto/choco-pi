// The pinned TLA+ tools release, where it is stored, and the async process,
// hashing and Java helpers shared by tlc-setup.ts and tlc.ts.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** Newest stable (non-prerelease) tlaplus release with a tla2tools.jar asset. */
export const TLA_TOOLS_VERSION = "v1.7.4";
export const TLA_TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLA_TOOLS_VERSION}/tla2tools.jar`;
/**
 * SHA-256 of that asset. Computed from a download on 2026-11-10 and matched against the
 * checksum pstack pins for the same URL (skills/statechart/scripts/run.ts, TLC_TOOL).
 */
export const TLA_TOOLS_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const TLA_TOOLS_SIZE = 2_274_532;
export const JAR_NAME = "tla2tools.jar";
/** tla2tools v1.7.4 is built for Java 8 class files; the tlaplus project supports it on Java 11+. */
export const MIN_JAVA_MAJOR = 11;

/** Absolute path of tlc-setup.ts, so messages give a command that runs from any directory. */
export const SETUP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "tlc-setup.ts");

/** What to install when Java is missing or too old. */
export const JAVA_INSTALL_HINT = `TLC needs Java ${MIN_JAVA_MAJOR} or newer: install a JDK or JRE (for example \`brew install openjdk\`, \`apt install default-jre-headless\`, or Eclipse Temurin from https://adoptium.net), then put java on PATH or set CHOCO_PI_JAVA to its path`;

export function javaTooOld(major: number): string {
  return `Java ${major} is too old. ${JAVA_INSTALL_HINT}`;
}

export function defaultToolsDir(env: NodeJS.ProcessEnv): string {
  const cache = env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cache, "choco-pi", "formal");
}

export function javaCommand(env: NodeJS.ProcessEnv): string {
  return env.CHOCO_PI_JAVA || "java";
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the output passed maxBytes and the process was killed. */
  overflow: boolean;
  /** Set when the process could not be started. */
  spawnError: string | undefined;
  elapsedMs: number;
};

export type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Absolute time (Date.now()) after which the process is killed. */
  deadline: number;
  maxBytes: number;
};

const active = new Set<() => Promise<void>>();

/** Kills every running child and waits for each to exit. */
export async function killActive(): Promise<void> {
  await Promise.all([...active].map((kill) => kill()));
}

/**
 * Runs a command without a shell. On the deadline or on output overflow the
 * process is killed with SIGKILL, and the promise settles only after it exits.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const remaining = options.deadline - startedAt;
  const base = {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    overflow: false,
    spawnError: undefined,
    elapsedMs: 0,
  };
  if (remaining <= 0) return Promise.resolve({ ...base, timedOut: true });
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let exited: Promise<void> | undefined;
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    const kill = () => {
      exited ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      })();
      return exited;
    };
    active.add(kill);
    const timer = setTimeout(() => {
      timedOut = true;
      void kill();
    }, remaining);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        overflow = true;
        void kill();
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const finish = (result: Partial<ProcessResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(kill);
      resolve({
        ...base,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        overflow,
        elapsedMs: Date.now() - startedAt,
        ...result,
      });
    };
    child.once("error", (error) => {
      // Only a failure to start ends the run here; later errors are followed by "close".
      if (child.pid === undefined) finish({ spawnError: error.message });
    });
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

export type JavaInfo = { version: string; major: number };

/** Runs `java -version` and reads the version TLC will run on. */
export async function probeJava(
  java: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<JavaInfo | { error: string }> {
  const result = await runProcess(java, ["-version"], {
    cwd: process.cwd(),
    env,
    deadline: Math.min(deadline, Date.now() + 30_000),
    maxBytes: 1 << 16,
  });
  if (result.spawnError)
    return { error: `cannot run Java (${java}: ${result.spawnError}). ${JAVA_INSTALL_HINT}` };
  if (result.timedOut) return { error: `${java} -version did not finish in time` };
  const text = `${result.stderr}\n${result.stdout}`;
  const match = /version "([^"]+)"/.exec(text);
  const version = match?.[1];
  if (result.exitCode !== 0 || !version)
    return {
      error: `${java} -version exited ${result.exitCode} without a version: ${text.trim().slice(0, 300)}`,
    };
  const parts = version.split(/[.+-]/);
  const major = Number(parts[0] === "1" ? parts[1] : parts[0]);
  if (!Number.isInteger(major)) return { error: `cannot read the Java version "${version}"` };
  const line =
    text
      .split("\n")
      .find((l) => l.includes(`"${version}"`))
      ?.trim() ?? version;
  return { version: line, major };
}
