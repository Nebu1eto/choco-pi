import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  DefaultResourceLoader,
  type EventBus,
  type Extension,
  type ExtensionRuntime,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import shellsExtension from "../src/index.ts";
import { ShellManager } from "../src/shell-manager.ts";
import {
  isStopShellsRequest,
  readStopState,
  STOP_CONTROL_PROTOCOL,
  STOP_CONTROL_REGISTRY_KEY,
  STOP_CONTROL_REPORT_CHANNEL,
  STOP_CONTROL_STOP_SHELLS_CHANNEL,
} from "../src/stop-control.ts";

const managerKey = Symbol.for("choco-pi-shells:manager");
const ROOT = "root-session";
const STOP_REFUSED =
  "shell_start refused: the user stopped this session's work (/stop). Ask the user to run /resume-work.";

interface StopStateFixture {
  epoch: number;
  closed: boolean;
}

const states = new Map<string, StopStateFixture>();

function installRegistry(): void {
  states.clear();
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      protocol: STOP_CONTROL_PROTOCOL,
      state: (id: string): StopStateFixture => states.get(id) ?? { epoch: 0, closed: false },
    },
  });
}

function removeRegistry(): void {
  Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
}

interface Report {
  requestId?: string;
  participant?: string;
  phase?: string;
  counts?: { shells?: number };
  detail?: string;
}

interface SentMessage {
  options?: { triggerTurn?: boolean; deliverAs?: string };
}

async function waitFor(accept: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!accept()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface LifecycleEvent {
  type: string;
  reason?: string;
}

async function activate() {
  const bus: EventBus = createEventBus();
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: bus,
    extensionFactories: [{ name: "shell-stop", factory: shellsExtension }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension: Extension | undefined = loaded.extensions.find(
    (entry) => entry.path === "<inline:shell-stop>",
  );
  assert.ok(extension);
  const runtime: ExtensionRuntime = loaded.runtime;
  const messages: SentMessage[] = [];
  runtime.sendMessage = (_message, options) => {
    messages.push({ options });
  };
  runtime.appendEntry = () => {};
  const reports: Report[] = [];
  bus.on(STOP_CONTROL_REPORT_CHANNEL, (data) => {
    reports.push(JSON.parse(JSON.stringify(data)));
  });
  const ctx = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => ROOT, getEntries: () => [] },
  };
  // Tools read only the members the fake context defines; the host context has no lighter test double.
  const toolContext: ExtensionToolContext = Object.assign(Object.create(null), ctx);
  const fire = async (name: string, event: LifecycleEvent): Promise<void> => {
    const handlers = extension.handlers.get(name) ?? [];
    for (const handler of handlers) await handler(event, ctx);
  };
  const startShell = async (command: string): Promise<string> => {
    const registered = extension.tools.get("shell_start");
    assert.ok(registered);
    const result = await registered.definition.execute(
      "call-1",
      { command },
      new AbortController().signal,
      () => {},
      toolContext,
    );
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };
  return { bus, fire, startShell, messages, reports };
}

function manager(): ShellManager {
  const entry = Object.getOwnPropertyDescriptor(globalThis, managerKey)?.value;
  assert.ok(entry instanceof ShellManager);
  return entry;
}

test("contract guards: foreign payloads and malformed registries are ignored", () => {
  removeRegistry();
  assert.deepEqual(readStopState(ROOT), { epoch: 0, closed: false });
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    configurable: true,
    value: { protocol: STOP_CONTROL_PROTOCOL, state: () => ({ epoch: -1, closed: "yes" }) },
  });
  assert.deepEqual(readStopState(ROOT), { epoch: 0, closed: false });
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    configurable: true,
    value: {
      protocol: STOP_CONTROL_PROTOCOL,
      state: () => {
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(readStopState(ROOT), { epoch: 0, closed: false });
  removeRegistry();
  assert.equal(isStopShellsRequest({ requestId: "r", rootSessionId: ROOT, epoch: 1 }), false);
  assert.equal(
    isStopShellsRequest({
      requestId: "r",
      rootSessionId: ROOT,
      epoch: 1,
      ownerSessionIds: [ROOT],
      extra: true,
    }),
    false,
  );
});

test("stop-shells stops a TERM-resistant group for the listed owners only and keeps output", async () => {
  installRegistry();
  const root = await activate();
  try {
    await root.fire("session_start", { type: "session_start" });
    const started = JSON.parse(
      await root.startShell("trap '' TERM; echo ready; while :; do sleep 0.2; done"),
    );
    const survivor = manager().start({
      ownerId: "unrelated-owner",
      command: "while :; do sleep 0.2; done",
      cwd: process.cwd(),
    });
    await waitFor(() =>
      manager()
        .read({ requesterId: ROOT, isAdmin: false, shellId: started.shellId })
        .stdout.data.includes("ready"),
    );

    // Foreign root id is ignored.
    root.bus.emit(STOP_CONTROL_STOP_SHELLS_CHANNEL, {
      requestId: "ignored",
      rootSessionId: "other-root",
      epoch: 1,
      ownerSessionIds: [ROOT],
    });
    assert.equal(root.reports.length, 0);

    root.bus.emit(STOP_CONTROL_STOP_SHELLS_CHANNEL, {
      requestId: "req-1",
      rootSessionId: ROOT,
      epoch: 1,
      ownerSessionIds: [ROOT, ROOT],
    });
    // Acknowledged synchronously, before the stop settles.
    assert.equal(root.reports.length, 1);
    assert.equal(root.reports[0]?.phase, "acknowledged");
    assert.equal(root.reports[0]?.participant, "shells");
    assert.deepEqual(root.reports[0]?.counts, { shells: 1 });

    await waitFor(() => root.reports.length === 2);
    assert.equal(root.reports[1]?.phase, "settled");
    assert.equal(root.reports[1]?.requestId, "req-1");
    const after = manager().read({ requesterId: ROOT, isAdmin: false, shellId: started.shellId });
    assert.equal(after.shell.state, "stopped");
    assert.match(after.stdout.data, /ready/);
    assert.equal(
      manager().read({ requesterId: "unrelated-owner", isAdmin: false, shellId: survivor.shellId })
        .shell.state,
      "running",
    );
  } finally {
    await root.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    removeRegistry();
  }
});

test("shell_start is refused while closed and works after reopen", async () => {
  installRegistry();
  const root = await activate();
  try {
    await root.fire("session_start", { type: "session_start" });
    states.set(ROOT, { epoch: 1, closed: true });
    assert.equal(JSON.parse(await root.startShell("sleep 5")).error, STOP_REFUSED);
    assert.deepEqual(manager().list({ requesterId: ROOT, isAdmin: false }).shells, []);
    states.set(ROOT, { epoch: 2, closed: false });
    const started = JSON.parse(await root.startShell("sleep 5"));
    assert.equal(started.state, "running");
  } finally {
    await root.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    removeRegistry();
  }
});

test("completions from an older epoch never trigger a turn; the current epoch does", async () => {
  installRegistry();
  const root = await activate();
  try {
    await root.fire("session_start", { type: "session_start" });
    await root.startShell("sleep 0.4; exit 0");
    states.set(ROOT, { epoch: 1, closed: false });
    await waitFor(() => root.messages.length === 1);
    assert.equal(root.messages[0]?.options?.triggerTurn, false);
    assert.equal(root.messages[0]?.options?.deliverAs, "steer");

    await root.startShell("sleep 0.4; exit 0");
    await waitFor(() => root.messages.length === 2);
    assert.equal(root.messages[1]?.options?.triggerTurn, true);
  } finally {
    await root.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    removeRegistry();
  }
});
