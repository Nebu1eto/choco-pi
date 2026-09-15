import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  installRegisteredToolCapture,
  registeredToolRunner,
  resetRegisteredToolCapture,
} from "../src/tools/code-mode/registered-tool-bridge.ts";

type HostBoundaryValue = {} | null | undefined;

function reinterpretHostValue<Target>(value: HostBoundaryValue): Target {
  // SAFETY: Test fixtures deliberately provide only the host members reached by each test.
  return value as Target;
}

interface SessionManagerFixture {
  id: string;
}

function captureRunner(context: ExtensionContext): ExtensionRunner {
  const runner = reinterpretHostValue<ExtensionRunner>({
    extensions: [],
    createContext: () => context,
  });
  ExtensionRunner.prototype.getAllRegisteredTools.call(runner);
  return runner;
}

function sessionContext(sessionManager: SessionManagerFixture): ExtensionContext {
  return reinterpretHostValue<ExtensionContext>({ sessionManager, isIdle: () => true });
}

test("a live subagent runner does not hijack the calling session's registry", () => {
  resetRegisteredToolCapture();
  installRegisteredToolCapture();

  // The root session registers first, then two subagents build their own
  // runners. A child session skips whole extensions, so mirroring the newest
  // live runner would drop every orchestration tool from a root exec cell.
  const rootContext = sessionContext({ id: "root" });
  const rootRunner = captureRunner(rootContext);
  const firstChild = captureRunner(sessionContext({ id: "child-1" }));
  const secondChild = captureRunner(sessionContext({ id: "child-2" }));

  assert.equal(registeredToolRunner(rootContext), rootRunner);
  assert.equal(registeredToolRunner(), secondChild);
  assert.equal(registeredToolRunner(sessionContext({ id: "child-1" })), secondChild);
  assert.ok(firstChild);

  resetRegisteredToolCapture();
});

test("a ctx without a session manager falls back to the newest live runner", () => {
  resetRegisteredToolCapture();
  installRegisteredToolCapture();

  const rootRunner = captureRunner(sessionContext({ id: "root" }));
  const childRunner = captureRunner(sessionContext({ id: "child" }));
  const bareContext = reinterpretHostValue<ExtensionContext>({ isIdle: () => true });

  assert.equal(registeredToolRunner(bareContext), childRunner);
  assert.ok(rootRunner);

  resetRegisteredToolCapture();
});

test("a stale runner is pruned even when a newer live runner precedes it", () => {
  resetRegisteredToolCapture();
  installRegisteredToolCapture();

  const rootContext = sessionContext({ id: "root" });
  const rootRunner = captureRunner(rootContext);
  let childStale = false;
  const childContext = reinterpretHostValue<ExtensionContext>({
    sessionManager: { id: "child" },
    isIdle() {
      if (childStale)
        throw new Error("This extension ctx is stale after session replacement or reload.");
      return true;
    },
  });
  const childRunner = captureRunner(childContext);

  assert.equal(registeredToolRunner(), childRunner);
  assert.equal(registeredToolRunner(rootContext), rootRunner);
  childStale = true;
  assert.equal(registeredToolRunner(), rootRunner);
  assert.equal(registeredToolRunner(rootContext), rootRunner);

  resetRegisteredToolCapture();
});
