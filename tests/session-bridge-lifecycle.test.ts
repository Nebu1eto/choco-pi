import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  type LiveSessionState,
  parseLiveState,
  readJson,
} from "../.pi/packages/choco-pi-editor-context/src/live-session-client.ts";
import {
  installLiveSessionBridge,
  type LiveSessionBridgeDependencies,
} from "../.pi/extensions/session-bridge.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { createSessionSdkFixture } from "./helpers/session-sdk-fixture.ts";

type Deferred = { promise: Promise<void>; resolve(): void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class LifecycleDependencies implements LiveSessionBridgeDependencies {
  readonly root: string;
  readonly events: string[] = [];
  readonly watcherSignals = new Map<string, AbortSignal[]>();
  readonly watcherCallbacks = new Map<string, (() => void)[]>();
  readonly removals = new Map<string, Deferred[]>();
  nextPublishGate: Deferred | undefined;
  publishEntered: Deferred | undefined;

  constructor(root: string) {
    this.root = root;
  }

  mailboxPath(sessionId: string): string {
    return join(this.root, "mailboxes", sessionId);
  }

  statePath(sessionId: string): string {
    return join(this.root, "live", `${sessionId}.json`);
  }

  gateNextPublish() {
    const gate = deferred();
    const entered = deferred();
    this.nextPublishGate = gate;
    this.publishEntered = entered;
    return { entered: entered.promise, release: gate.resolve };
  }

  async publishLiveState(state: LiveSessionState): Promise<void> {
    const gate = this.nextPublishGate;
    const entered = this.publishEntered;
    this.nextPublishGate = undefined;
    this.publishEntered = undefined;
    if (gate) {
      entered?.resolve();
      await gate.promise;
    }
    await mkdir(join(this.root, "live"), { recursive: true });
    await writeFile(this.statePath(state.sessionId), JSON.stringify(state), "utf8");
    this.events.push(`publish:${state.sessionId}:${state.status}`);
  }

  async removeOwnedLiveState(sessionId: string, ownerId: string): Promise<void> {
    try {
      const state = parseLiveState(await readJson(this.statePath(sessionId)));
      if (state?.ownerId === ownerId) await unlink(this.statePath(sessionId));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.events.push(`remove:${sessionId}`);
    const waiters = this.removals.get(sessionId) ?? [];
    this.removals.delete(sessionId);
    for (const waiter of waiters) waiter.resolve();
  }

  waitForRemoval(sessionId: string): Promise<void> {
    const waiter = deferred();
    const waiters = this.removals.get(sessionId) ?? [];
    waiters.push(waiter);
    this.removals.set(sessionId, waiters);
    return waiter.promise;
  }

  watchMailbox(directory: string, signal: AbortSignal, onJsonFile: () => void): Promise<void> {
    const sessionId = basename(directory);
    const signals = this.watcherSignals.get(sessionId) ?? [];
    signals.push(signal);
    this.watcherSignals.set(sessionId, signals);
    const callbacks = this.watcherCallbacks.get(sessionId) ?? [];
    callbacks.push(onJsonFile);
    this.watcherCallbacks.set(sessionId, callbacks);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async state(sessionId: string): Promise<LiveSessionState> {
    const state = parseLiveState(await readJson(this.statePath(sessionId)));
    assert.ok(state);
    return state;
  }
}

function bridgeFactory(dependencies: LifecycleDependencies): ExtensionFactory {
  return (pi) => installLiveSessionBridge(pi, dependencies);
}

test("fresh SDK contexts update one owned session from busy to idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-session-lifecycle-"));
  const dependencies = new LifecycleDependencies(root);
  const fixture = await createSessionSdkFixture(root, [bridgeFactory(dependencies)]);
  const sessionId = fixture.sessionManager.getSessionId();
  try {
    assert.equal((await dependencies.state(sessionId)).status, "idle");
    await fixture.session.extensionRunner.emit({ type: "agent_start" });
    assert.equal((await dependencies.state(sessionId)).status, "busy");
    await fixture.session.extensionRunner.emit({ type: "agent_settled" });
    assert.equal((await dependencies.state(sessionId)).status, "idle");
    assert.equal(fixture.contexts.length, 3);
    assert.notEqual(fixture.contexts[0], fixture.contexts[1]);
    assert.notEqual(fixture.contexts[1], fixture.contexts[2]);
  } finally {
    const removed = dependencies.waitForRemoval(sessionId);
    fixture.session.dispose();
    await removed;
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing one actual session removes only its owner and aborts only its watcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-session-lifecycle-"));
  const dependencies = new LifecycleDependencies(root);
  const a = await createSessionSdkFixture(join(root, "a"), [bridgeFactory(dependencies)], {
    id: "A",
  });
  const b = await createSessionSdkFixture(join(root, "b"), [bridgeFactory(dependencies)], {
    id: "B",
  });
  try {
    const removedA = dependencies.waitForRemoval("A");
    a.session.dispose();
    await removedA;
    assert.equal(dependencies.watcherSignals.get("A")?.[0]?.aborted, true);
    assert.equal(dependencies.watcherSignals.get("B")?.[0]?.aborted, false);
    await assert.rejects(readFile(dependencies.statePath("A")), /ENOENT/);
    assert.equal((await dependencies.state("B")).sessionId, "B");

    a.session.dispose();
    await a.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal((await dependencies.state("B")).sessionId, "B");
  } finally {
    const removedB = dependencies.waitForRemoval("B");
    b.session.dispose();
    await removedB;
    await rm(root, { recursive: true, force: true });
  }
});

test("a gated old publication is removed before a replacement generation publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-session-lifecycle-"));
  const dependencies = new LifecycleDependencies(root);
  const fixture = await createSessionSdkFixture(root, [bridgeFactory(dependencies)], {
    id: "reload",
  });
  try {
    const gate = dependencies.gateNextPublish();
    const stale = fixture.session.extensionRunner.emit({ type: "agent_start" });
    await gate.entered;
    const replacement = fixture.session.extensionRunner.emit({
      type: "session_start",
      reason: "reload",
    });
    gate.release();
    await Promise.all([stale, replacement]);

    assert.deepEqual(dependencies.events.slice(-3), [
      "publish:reload:busy",
      "remove:reload",
      "publish:reload:idle",
    ]);
    assert.equal((await dependencies.state("reload")).status, "idle");
  } finally {
    const removed = dependencies.waitForRemoval("reload");
    fixture.session.dispose();
    await removed;
    await rm(root, { recursive: true, force: true });
  }
});

test("rapid A to B to C starts serialize an unpublished middle generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-session-lifecycle-"));
  const dependencies = new LifecycleDependencies(root);
  const fixture = await createSessionSdkFixture(root, [bridgeFactory(dependencies)], { id: "A" });
  try {
    fixture.sessionManager.newSession({ id: "B" });
    const gate = dependencies.gateNextPublish();
    const startB = fixture.session.extensionRunner.emit({ type: "session_start", reason: "new" });
    await gate.entered;
    fixture.sessionManager.newSession({ id: "C" });
    const startC = fixture.session.extensionRunner.emit({ type: "session_start", reason: "new" });
    gate.release();
    await Promise.all([startB, startC]);

    assert.deepEqual(dependencies.events.slice(-5), [
      "publish:A:idle",
      "remove:A",
      "publish:B:idle",
      "remove:B",
      "publish:C:idle",
    ]);
    assert.equal((await dependencies.state("C")).sessionId, "C");
    await assert.rejects(readFile(dependencies.statePath("B")), /ENOENT/);
  } finally {
    const removed = dependencies.waitForRemoval("C");
    fixture.session.dispose();
    await removed;
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalidated watcher callback cannot claim mail for its replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-session-lifecycle-"));
  const dependencies = new LifecycleDependencies(root);
  const fixture = await createSessionSdkFixture(root, [bridgeFactory(dependencies)], { id: "old" });
  try {
    const oldCallback = dependencies.watcherCallbacks.get("old")?.[0];
    assert.ok(oldCallback);
    fixture.sessionManager.newSession({ id: "replacement" });
    await fixture.session.extensionRunner.emit({ type: "session_start", reason: "new" });
    assert.equal(dependencies.watcherSignals.get("old")?.[0]?.aborted, true);

    const mailbox = dependencies.mailboxPath("old");
    const pendingPath = join(mailbox, "00000000000000000001-pending.json");
    await writeFile(
      pendingPath,
      JSON.stringify({
        version: 1,
        id: "pending",
        fromSessionId: "sender",
        targetSessionId: "old",
        mode: "steer",
        message: "must stay pending",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    oldCallback();
    await Promise.resolve();
    assert.equal((await readFile(pendingPath, "utf8")).includes("must stay pending"), true);
    assert.deepEqual(await readdir(mailbox), [basename(pendingPath)]);
  } finally {
    const removed = dependencies.waitForRemoval(fixture.sessionManager.getSessionId());
    fixture.session.dispose();
    await removed;
    await rm(root, { recursive: true, force: true });
  }
});
