/**
 * Fleet view per-agent "Compacting…" marker.
 *
 * The host window is driven through the session's own `compaction_start` /
 * `compaction_end` events; the background-preparation window through a real
 * child compaction bridge attached to a real SDK session with a fake
 * coordinator built against the frozen `CoordinatorApi`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";

import type {
  CandidateState,
  CoordinatorApi,
} from "../../choco-pi-compaction/src/background/contract.ts";
import { getCoordinator } from "../../choco-pi-compaction/src/background/registry.ts";
import type { AgentManager } from "../src/agent-manager.ts";
import { resumeAgent } from "../src/agent-runner.ts";
import {
  type ChildCompactionProvider,
  createChildCompactionBridge,
} from "../src/child-compaction-bridge.ts";
import { isSessionCompacting, trackSessionCompaction } from "../src/compaction-activity.ts";
import type { AgentRecord } from "../src/types.ts";
import type { AgentActivity, Theme } from "../src/ui/agent-widget.ts";
import { FleetPanel, type FleetPanelUICtx } from "../src/ui/fleet-panel.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

initTheme("dark", false);

const MARKER = "Compacting…";
const styledTheme: Theme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the exact structural slice exercised by its subject.
  return fixture as T;
}

function agent(id: string, session: AgentSession): AgentRecord {
  return partialFixture<AgentRecord>({
    id,
    type: "implementer",
    handle: id,
    description: `${id} task`,
    status: "running",
    toolUses: 0,
    startedAt: Date.now() - 3_000,
    lifetimeUsage: { input: 1_000, output: 200, cacheWrite: 0 },
    compactionCount: 0,
    session,
  });
}

// Theme tags count toward visible width, so default rows get room for them.
function mount(records: AgentRecord[], width = 240) {
  const manager = partialFixture<AgentManager>({
    listAgents: () => records.toReversed(),
    getScheduledActiveCount: () => records.filter((r) => r.status === "running").length,
    getActiveCount: () => records.filter((r) => r.status === "running").length,
    getMaxConcurrent: () => 8,
  });
  const panel = new FleetPanel(
    manager,
    new Map<string, AgentActivity>(),
    {},
    {
      widgetMode: () => "all",
    },
  );
  const tui = partialFixture<TUI>({
    terminal: partialFixture<TUI["terminal"]>({ columns: width }),
    hasOverlay: () => false,
    requestRender() {},
  });
  let component: { render(width: number): string[] } | undefined;
  panel.setUICtx(
    partialFixture<FleetPanelUICtx>({
      setStatus() {},
      setWidget(_key, factory) {
        component = factory?.(tui, styledTheme);
      },
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      notify() {},
    }),
  );
  panel.update();
  return {
    panel,
    lines: (renderWidth = width) => {
      panel.update();
      return component?.render(renderWidth) ?? [];
    },
    row: (id: string, renderWidth = width) => {
      panel.update();
      const lines = component?.render(renderWidth) ?? [];
      const line = lines.find((candidate) => candidate.includes(`${id} task`));
      assert.ok(line, `row for ${id} is rendered: ${JSON.stringify(lines)}`);
      return line;
    },
  };
}

/** A session slice that only emits the events the compaction window reads. */
function eventSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session = partialFixture<AgentSession>({
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    session,
    listenerCount: () => listeners.size,
    start: () => emit({ type: "compaction_start", reason: "threshold" }),
    end: (aborted: boolean) =>
      emit({
        type: "compaction_end",
        reason: "threshold",
        result: aborted
          ? undefined
          : {
              summary: "s",
              firstKeptEntryId: "e1",
              tokensBefore: 100,
              estimatedTokensAfter: 10,
              details: undefined,
            },
        aborted,
        willRetry: false,
      }),
  };
}

test("host compaction window shows the marker at the row's right end and clears on end", () => {
  const child = eventSession();
  trackSessionCompaction(child.session);
  trackSessionCompaction(child.session);
  const record = agent("host", child.session);
  const view = mount([record]);
  try {
    assert.equal(view.row("host").includes(MARKER), false);

    child.start();
    const row = view.row("host");
    assert.match(row, /<warning>Compacting…<\/warning> <dim>\d+s · ↓ 1\.2k<\/dim>$/);

    child.end(false);
    assert.equal(view.row("host").includes(MARKER), false);

    child.start();
    assert.ok(view.row("host").includes(MARKER));
    child.end(true);
    assert.equal(view.row("host").includes(MARKER), false, "aborted end clears");
  } finally {
    view.panel.dispose();
  }
});

for (const status of ["completed", "stopped", "error"] as const) {
  test(`terminal status ${status} clears an open compaction window`, () => {
    const child = eventSession();
    trackSessionCompaction(child.session);
    const record = agent(`term-${status}`, child.session);
    const view = mount([record]);
    try {
      child.start();
      assert.ok(view.row(record.id).includes(MARKER));
      record.status = status;
      record.completedAt = Date.now();
      view.panel.markFinished(record.id);
      assert.equal(view.row(record.id).includes(MARKER), false);
    } finally {
      view.panel.dispose();
    }
  });
}

test("narrow rows keep the marker while the description is clipped", () => {
  const child = eventSession();
  trackSessionCompaction(child.session);
  const record = agent("narrow", child.session);
  const view = mount([record], 40);
  try {
    child.start();
    const line = view.lines(40).find((candidate) => candidate.includes(MARKER));
    assert.ok(line, "marker survives a 40-column row");
    assert.equal(line.includes("narrow task"), false, "description is clipped first");
  } finally {
    view.panel.dispose();
  }
});

class FakeCoordinator implements CoordinatorApi {
  state: CandidateState = "idle";
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  constructor(ownerKey: string, ownerGeneration: number) {
    this.ownerKey = ownerKey;
    this.ownerGeneration = ownerGeneration;
  }
  async requestPreparation() {
    return { accepted: false as const, reason: "busy" as const };
  }
  cancel() {}
  status() {
    return { ownerKey: this.ownerKey, ownerGeneration: this.ownerGeneration, state: this.state };
  }
  async arbitrateHostCompaction() {
    return { action: "proceed" as const };
  }
  async arbitrateManualCompact() {
    return { action: "proceed" as const };
  }
  registerConsumer() {
    return () => {};
  }
  registerParticipant() {
    return () => {};
  }
  dispose() {}
}

async function bridgedSession() {
  let coordinator: FakeCoordinator | undefined;
  const provider: ChildCompactionProvider = {
    version: 1,
    isEnabled: () => true,
    createChildCoordinator: (context) => {
      coordinator = new FakeCoordinator(context.ownerKey, context.ownerGeneration);
      return { coordinator };
    },
  };
  const bridge = createChildCompactionBridge(
    { parentSessionId: undefined, mainSessionFork: false, readOnly: false, isolated: false },
    provider,
  );
  assert.ok(bridge);
  const cwd = process.cwd();
  const settings = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [bridge.extension.factory],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
    noTools: "all",
  });
  bridge.bindSession(session);
  await session.bindExtensions({});
  const ownerKey = `subagent-child:${session.sessionManager.getSessionId()}`;
  for (let attempt = 0; attempt < 50 && getCoordinator(ownerKey) === undefined; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(coordinator, "bridge attached a coordinator");
  return { session, bridge, coordinator };
}

test("background preparation shows the marker until the candidate leaves preparation", async () => {
  const { session, bridge, coordinator } = await bridgedSession();
  trackSessionCompaction(session);
  const record = agent("background", session);
  const view = mount([record]);
  try {
    assert.equal(view.row("background").includes(MARKER), false);
    for (const state of ["queued", "preparing", "adopting"] as const) {
      coordinator.state = state;
      assert.ok(view.row("background").includes(MARKER), `${state} shows the marker`);
    }
    for (const state of ["ready", "installed", "canceled", "failed", "idle"] as const) {
      coordinator.state = state;
      assert.equal(view.row("background").includes(MARKER), false, `${state} hides the marker`);
    }

    coordinator.state = "preparing";
    assert.ok(view.row("background").includes(MARKER));
    bridge.dispose();
    assert.equal(view.row("background").includes(MARKER), false, "detached bridge clears");
  } finally {
    view.panel.dispose();
    bridge.dispose();
    session.dispose();
  }
});

test("stopping tracking closes an open window and removes the listener", () => {
  const child = eventSession();
  const stop = trackSessionCompaction(child.session);
  const nested = trackSessionCompaction(child.session);
  assert.equal(child.listenerCount(), 1, "a nested run does not subscribe twice");
  child.start();
  assert.equal(isSessionCompacting(child.session), true);
  nested();
  assert.equal(isSessionCompacting(child.session), true, "only the owning run ends the window");
  stop();
  stop();
  assert.equal(isSessionCompacting(child.session), false, "settlement closes the window");
  assert.equal(child.listenerCount(), 0, "no listener outlives the run");
  child.start();
  assert.equal(isSessionCompacting(child.session), false, "events after settlement are ignored");
});

/** Record whether each compaction event saw an open window. */
function observeWindow(session: AgentSession): Array<[string, boolean]> {
  const observed: Array<[string, boolean]> = [];
  session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      observed.push([event.type, isSessionCompacting(session)]);
    }
  });
  return observed;
}

test("the runner tracks a real session's compaction only during the run", async () => {
  const { session } = await createSdkFixture();
  try {
    let inRun: Array<[string, boolean]> = [];
    // Subscribed inside the run so it observes after the run's tracker; a
    // failing compaction (no model) still emits start and end.
    session.prompt = async () => {
      inRun = observeWindow(session);
      await assert.rejects(session.compact());
    };
    await resumeAgent(session, "run");
    assert.deepEqual(inRun, [
      ["compaction_start", true],
      ["compaction_end", false],
    ]);

    inRun.length = 0;
    await assert.rejects(session.compact());
    // A leaked tracker would open the window and make the end read true.
    assert.deepEqual(inRun, [
      ["compaction_start", false],
      ["compaction_end", false],
    ]);
  } finally {
    session.dispose();
  }
});

test("a run that throws still releases its compaction tracking", async () => {
  const { session } = await createSdkFixture();
  try {
    const observed = observeWindow(session);
    session.prompt = async () => {
      throw new Error("prompt failed");
    };
    await assert.rejects(resumeAgent(session, "run"), /prompt failed/);
    await assert.rejects(session.compact());
    assert.deepEqual(observed, [
      ["compaction_start", false],
      ["compaction_end", false],
    ]);
  } finally {
    session.dispose();
  }
});
