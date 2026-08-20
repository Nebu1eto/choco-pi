import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = path.resolve(".pi/scripts/checkout-mutation-lease.ts");

type LeaseResult = { code: number; payload: Record<string, unknown> };

async function createCheckout(context: TestContext): Promise<string> {
  const checkout = await mkdtemp(path.join(tmpdir(), "choco-pi-lease-"));
  context.after(() => rm(checkout, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
  return checkout;
}

async function createLiveDir(context: TestContext): Promise<string> {
  const liveDir = await mkdtemp(path.join(tmpdir(), "choco-pi-live-"));
  context.after(() => rm(liveDir, { recursive: true, force: true }));
  return liveDir;
}

async function writeLiveSession(
  liveDir: string,
  session: { sessionId: string; pid: number; updatedAt?: string },
): Promise<void> {
  await mkdir(liveDir, { recursive: true });
  await writeFile(
    path.join(liveDir, `${session.sessionId}.json`),
    JSON.stringify({
      version: 1,
      sessionId: session.sessionId,
      pid: session.pid,
      updatedAt: session.updatedAt ?? new Date().toISOString(),
    }),
  );
}

async function runLease(
  action: string,
  options: { checkout: string; liveDir: string; leaseDir: string; owner?: string },
): Promise<LeaseResult> {
  const args = [script, action, "--cwd", options.checkout];
  if (options.owner) args.push("--owner", options.owner);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHOCO_PI_LEASE_DIR: options.leaseDir,
    CHOCO_PI_SESSION_BRIDGE_LIVE_DIR: options.liveDir,
  };
  delete env.PI_SESSION_ID;
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { env, encoding: "utf8" });
    return { code: 0, payload: JSON.parse(stdout) };
  } catch (error: unknown) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, payload: JSON.parse(failure.stderr ?? "{}") };
  }
}

function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(finished.pid, "expected a spawned pid");
  return finished.pid;
}

/** A live process that is not an ancestor of the lease script, so it cannot be mistaken for the caller. */
function unrelatedLivePid(context: TestContext): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
    stdio: "ignore",
  });
  context.after(() => {
    child.kill();
  });
  assert.ok(child.pid, "expected a spawned pid");
  return child.pid;
}

test("owner resolves through the session bridge so acquire and release pair across processes", async (context) => {
  const checkout = await createCheckout(context);
  const liveDir = await createLiveDir(context);
  const leaseDir = await mkdtemp(path.join(tmpdir(), "choco-pi-leasedir-"));
  context.after(() => rm(leaseDir, { recursive: true, force: true }));
  await writeLiveSession(liveDir, { sessionId: "session-under-test", pid: process.pid });

  const acquired = await runLease("acquire", { checkout, liveDir, leaseDir });
  assert.equal(acquired.payload.status, "acquired");
  assert.equal(acquired.payload.owner, "session:session-under-test");
  assert.equal(acquired.payload.ownerSource, "session-bridge");

  const released = await runLease("release", { checkout, liveDir, leaseDir });
  assert.equal(released.code, 0);
  assert.equal(released.payload.status, "released");
  assert.equal(released.payload.owner, "session:session-under-test");
});

test("acquire refuses a lease held by a live session", async (context) => {
  const checkout = await createCheckout(context);
  const liveDir = await createLiveDir(context);
  const leaseDir = await mkdtemp(path.join(tmpdir(), "choco-pi-leasedir-"));
  context.after(() => rm(leaseDir, { recursive: true, force: true }));
  await writeLiveSession(liveDir, { sessionId: "session-under-test", pid: process.pid });
  await writeLiveSession(liveDir, { sessionId: "other-session", pid: unrelatedLivePid(context) });

  await runLease("acquire", { checkout, liveDir, leaseDir, owner: "session:other-session" });
  const blocked = await runLease("acquire", { checkout, liveDir, leaseDir });

  assert.equal(blocked.code, 2);
  assert.equal(blocked.payload.owner, "session:other-session");
  assert.equal(blocked.payload.ownerLiveness, "live");
  assert.equal(blocked.payload.caller, "session:session-under-test");
});

test("acquire reclaims a lease whose holder process is gone", async (context) => {
  const checkout = await createCheckout(context);
  const liveDir = await createLiveDir(context);
  const leaseDir = await mkdtemp(path.join(tmpdir(), "choco-pi-leasedir-"));
  context.after(() => rm(leaseDir, { recursive: true, force: true }));
  await writeLiveSession(liveDir, { sessionId: "session-under-test", pid: process.pid });
  const abandonedOwner = `pid:${deadPid()}`;

  await runLease("acquire", { checkout, liveDir, leaseDir, owner: abandonedOwner });
  const reclaimed = await runLease("acquire", { checkout, liveDir, leaseDir });

  assert.equal(reclaimed.code, 0);
  assert.equal(reclaimed.payload.status, "acquired");
  assert.equal(reclaimed.payload.owner, "session:session-under-test");
  assert.equal(reclaimed.payload.reclaimedFrom, abandonedOwner);
});

test("acquire keeps a lease whose holder cannot be observed", async (context) => {
  const checkout = await createCheckout(context);
  const liveDir = await createLiveDir(context);
  const leaseDir = await mkdtemp(path.join(tmpdir(), "choco-pi-leasedir-"));
  context.after(() => rm(leaseDir, { recursive: true, force: true }));
  await writeLiveSession(liveDir, { sessionId: "session-under-test", pid: process.pid });

  await runLease("acquire", { checkout, liveDir, leaseDir, owner: "human-operator" });
  const blocked = await runLease("acquire", { checkout, liveDir, leaseDir });

  assert.equal(blocked.code, 2);
  assert.equal(blocked.payload.owner, "human-operator");
  assert.equal(blocked.payload.ownerLiveness, "unknown");
});

test("a session whose heartbeat stopped no longer holds the lease", async (context) => {
  const checkout = await createCheckout(context);
  const liveDir = await createLiveDir(context);
  const leaseDir = await mkdtemp(path.join(tmpdir(), "choco-pi-leasedir-"));
  context.after(() => rm(leaseDir, { recursive: true, force: true }));
  await writeLiveSession(liveDir, { sessionId: "session-under-test", pid: process.pid });
  await writeLiveSession(liveDir, {
    sessionId: "stalled-session",
    pid: unrelatedLivePid(context),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
  });

  await runLease("acquire", { checkout, liveDir, leaseDir, owner: "session:stalled-session" });
  const reclaimed = await runLease("acquire", { checkout, liveDir, leaseDir });

  assert.equal(reclaimed.payload.status, "acquired");
  assert.equal(reclaimed.payload.reclaimedFrom, "session:stalled-session");
});
