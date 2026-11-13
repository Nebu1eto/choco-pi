import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Plan } from "./isolation.ts";
import { launch } from "./launch.ts";
import { KILL_GRACE_MS, WAIT_BOUND_MS } from "./process.ts";

/** A Plan whose "Pi" is a dummy Node script; no Pi process is spawned. */
function dummy(dir: string, script: string): Plan {
  return {
    executable: process.execPath,
    args: ["-e", script],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cwd: dir,
    events: join(dir, "S1.events.jsonl"),
    stderr: join(dir, "S1.stderr"),
    sessionId: "dummy",
    requests: join(dir, "S1.requests.jsonl"),
    daemonLog: join(dir, "S1.daemon.log"),
    socket: join(dir, "bridge.sock"),
    helperApp: join(dir, "pi-computer-use.app"),
    fixtureDir: join(dir, "S1.fixture"),
  };
}

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cu-e2e-launch-"));
}

test("launch returns after Pi exits even though stderr EOF preceded the exit (tier-A hang)", async () => {
  const dir = await scratch();
  try {
    // Mirrors the hung S1 run: an early stderr warning, a large JSON event burst, clean exit.
    const script = [
      "process.stderr.write('Warning: No project session found\\n');",
      "setTimeout(()=>{",
      "  const pad='x'.repeat(600);",
      "  let s='';",
      "  for(let i=0;i<150;i++) s+=JSON.stringify({type:'message_update',i,pad})+'\\n';",
      "  s+=JSON.stringify({type:'agent_end'})+'\\n'+JSON.stringify({type:'agent_settled'})+'\\n';",
      "  process.stdout.write(s);",
      "},200);",
    ].join("");
    const started = Date.now();
    const result = await launch(dummy(dir, script), new AbortController().signal, "S1");
    assert.deepEqual(result.defects, []);
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started < WAIT_BOUND_MS, "must not wait on an already-finished sink");
    const events = (await readFile(join(dir, "S1.events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(events.length, 152);
    assert.equal(JSON.parse(events.at(-1) ?? "").type, "agent_settled");
    assert.match(await readFile(join(dir, "S1.stderr"), "utf8"), /^Warning: /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the deadline SIGKILLs a Pi that ignores SIGTERM and launch returns within its bound", async () => {
  const dir = await scratch();
  try {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 300);
    const started = Date.now();
    const result = await launch(
      dummy(dir, "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)"),
      deadline.signal,
      "S1",
    );
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.equal(result.code, 1);
    assert.deepEqual(result.defects, []);
    assert.ok(elapsed < 300 + KILL_GRACE_MS + 1000, `took ${elapsed}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a descendant holding Pi's pipes becomes a harness defect, not a hang", async () => {
  const dir = await scratch();
  const pidFile = join(dir, "grandchild.pid");
  try {
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit',detached:true});c.unref();void require('node:fs/promises').writeFile(${JSON.stringify(pidFile)},String(c.pid))`;
    const started = Date.now();
    const result = await launch(dummy(dir, script), new AbortController().signal, "S1");
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0);
    assert.equal(result.defects.length, 1);
    assert.match(result.defects[0] ?? "", /^pi output did not close \(timeout after \d+ms\)$/);
    assert.ok(elapsed < WAIT_BOUND_MS + 2000, `took ${elapsed}ms`);
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
