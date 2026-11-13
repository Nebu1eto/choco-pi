#!/usr/bin/env node
// Explicit setup for the formal-verify skill: downloads the pinned tla2tools.jar,
// verifies its SHA-256, and reports the Java version. The checker never downloads
// anything itself.
//
//   node tlc-setup.ts [--dir <dir>]
//
// Prints one JSON document. Exit 0 when the jar is verified and Java is usable,
// 1 when the jar is present but Java is missing or too old, 2 on any other failure.

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  JAR_NAME,
  MIN_JAVA_MAJOR,
  TLA_TOOLS_SHA256,
  TLA_TOOLS_SIZE,
  TLA_TOOLS_URL,
  TLA_TOOLS_VERSION,
  defaultToolsDir,
  javaCommand,
  javaTooOld,
  probeJava,
  sha256File,
} from "./tlc-tools.ts";

type SetupReport = {
  jar: string;
  version: string;
  sha256: string | undefined;
  action: "present" | "downloaded" | "none";
  java: { command: string; version: string | undefined; ok: boolean; problem: string | undefined };
  errors: string[];
};

const DOWNLOAD_TIMEOUT_MS = 300_000;

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function download(target: string): Promise<void> {
  const partial = `${target}.part-${randomBytes(6).toString("hex")}`;
  try {
    const response = await fetch(TLA_TOOLS_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body)
      throw new Error(`download of ${TLA_TOOLS_URL} failed with HTTP ${response.status}`);
    let bytes = 0;
    const file = await open(partial, "wx");
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > TLA_TOOLS_SIZE)
          throw new Error(`download is larger than ${TLA_TOOLS_SIZE} bytes`);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    const digest = await sha256File(partial);
    if (digest !== TLA_TOOLS_SHA256)
      throw new Error(
        `downloaded jar has SHA-256 ${digest}, expected ${TLA_TOOLS_SHA256}; refusing it`,
      );
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, help: { type: "boolean" } },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write("usage: tlc-setup.ts [--dir <dir>]\n");
    return 0;
  }
  const dir = path.resolve(values.dir ?? defaultToolsDir(process.env));
  const jar = path.join(dir, JAR_NAME);
  const java = javaCommand(process.env);
  const report: SetupReport = {
    jar,
    version: TLA_TOOLS_VERSION,
    sha256: undefined,
    action: "none",
    java: { command: java, version: undefined, ok: false, problem: undefined },
    errors: [],
  };
  try {
    await mkdir(dir, { recursive: true });
    if (await exists(jar)) {
      const digest = await sha256File(jar);
      if (digest !== TLA_TOOLS_SHA256)
        throw new Error(
          `${jar} has SHA-256 ${digest}, not the pinned ${TLA_TOOLS_SHA256}; delete it and run setup again`,
        );
      report.action = "present";
    } else {
      await download(jar);
      report.action = "downloaded";
    }
    report.sha256 = TLA_TOOLS_SHA256;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  const probe = await probeJava(java, process.env, Date.now() + 30_000);
  if ("error" in probe) report.java.problem = probe.error;
  else {
    report.java.version = probe.version;
    report.java.ok = probe.major >= MIN_JAVA_MAJOR;
    if (!report.java.ok) report.java.problem = javaTooOld(probe.major);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) return 2;
  return report.java.ok ? 0 : 1;
}

process.exitCode = await main();
