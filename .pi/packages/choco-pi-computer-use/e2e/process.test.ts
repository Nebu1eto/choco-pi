import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeSink, drainOutput, exitOf, sink, stopProcess, within } from "./process.ts";

/** Read the first stdout line without destroying the stream (drainOutput must observe it). */
async function firstLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  assert.ok(stdout);
  return await new Promise((resolve, reject) => {
    let buffer = "";
    stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) resolve(buffer.slice(0, end));
    });
    stdout.once("end", () => reject(new Error("child closed before printing a line")));
  });
}

test("stopProcess escalates to SIGKILL and resolves within its bound when SIGTERM is ignored", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3);process.stdout.write('ready\\n')"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    assert.equal(await firstLine(child), "ready");
    const started = Date.now();
    const defect = await stopProcess(child, "dummy", 200, 3000);
    const elapsed = Date.now() - started;
    assert.equal(defect, undefined);
    assert.equal(child.signalCode, "SIGKILL");
    assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  } finally {
    child.kill("SIGKILL");
  }
});

test("stopProcess on an exited child returns immediately", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exitOf(child);
  assert.equal(await stopProcess(child, "done", 10, 10), undefined);
});

test("closeSink resolves after stderr EOF already finished a piped sink (tier-A hang regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cu-e2e-process-"));
  try {
    const piped = sink(join(dir, "piped.stderr"));
    const written = sink(join(dir, "written.stderr"));
    const child = spawn(process.execPath, ["-e", "process.stderr.write('warn\\n')"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.pipe(piped.stream);
    child.stderr.on("data", (chunk: Buffer) => written.stream.write(chunk));
    await exitOf(child);
    // `close` may already have fired alongside `exit`; drainOutput observes the ended state.
    assert.equal(await drainOutput(child, "child", 1000), undefined);
    // pipe() has already ended the sink; the old `once(sink, "finish")` never resolved here.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await closeSink(piped, "piped", 1000), []);
    assert.deepEqual(await closeSink(written, "written", 1000), []);
    assert.equal(await readFile(join(dir, "written.stderr"), "utf8"), "warn\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drainOutput reports a defect instead of hanging when a descendant holds the pipes", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'inherit',detached:true});c.unref();process.stdout.write(c.pid+'\\n')",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const grandchild = Number(await firstLine(child));
  try {
    await exitOf(child);
    const started = Date.now();
    const defect = await drainOutput(child, "pi", 300);
    assert.match(defect ?? "", /pi output did not close \(timeout after 300ms\)/);
    assert.ok(Date.now() - started < 2000);
    assert.equal(child.stdout?.destroyed, true);
  } finally {
    if (Number.isSafeInteger(grandchild) && grandchild > 0) process.kill(grandchild, "SIGKILL");
  }
});

test("within never rejects and times out", async () => {
  assert.deepEqual(await within(new Promise<never>(() => {}), 20), {
    ok: false,
    error: "timeout after 20ms",
  });
  assert.deepEqual(await within(Promise.reject(new Error("boom")), 20), {
    ok: false,
    error: "boom",
  });
  assert.deepEqual(await within(Promise.resolve(1), 20), { ok: true, value: 1 });
});
