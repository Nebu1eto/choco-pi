import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import { NUDGE_HOLD_MS } from "../src/notification-gate.ts";
import type { NotificationDetails } from "../src/types.ts";
import { compile } from "@earendil-works/pi-schema";
import { KeptReplySchema } from "../src/delegation-render.ts";

// An old completion notification must never show a later run's verdict:
// `resume` reuses the agent record and replaces its result.

function asExtensionAPI(value: RuntimeValue): ExtensionAPI {
  // SAFETY: The host fixture implements the registration and delivery methods the extension uses here.
  return value as ExtensionAPI;
}

function partialFixture<T extends object>(value: Partial<T>): T {
  // SAFETY: Fixtures supply only the host members exercised by the extension here.
  return value as T;
}

type RuntimeValue = {} | null | undefined;
type LifecycleHandler = (...args: RuntimeValue[]) => RuntimeValue | Promise<RuntimeValue>;
interface Notice {
  customType: string;
  content: string;
  display: boolean;
  details: NotificationDetails;
}

const FENCE = "\u0060\u0060\u0060";
/** Same opening text for every run, longer than the 500-character notification preview. */
const PREFIX =
  "## Findings\n\n" +
  "1. HIGH notes.txt:1-2: the file must keep two lines; the edit drops the second one and nothing restores it.\n".repeat(
    6,
  ) +
  "\n";
const FINDING = {
  id: "F1",
  class: "finding",
  severity: "high",
  path: "notes.txt",
  startLine: 1,
  endLine: 2,
  invariant: "notes.txt keeps two lines",
  evidence: "reproduction",
  reproduction: "wc -l notes.txt",
};

function reply(prefix: string, verdict: "FINDINGS" | "NO_FINDINGS"): string {
  const block = {
    schema: 1,
    verdict,
    bundleDigest: "sha256:f5bundle",
    findings: verdict === "FINDINGS" ? [FINDING] : [],
  };
  return prefix + FENCE + "choco-pi-review\n" + JSON.stringify(block, null, 2) + "\n" + FENCE;
}

const theme = partialFixture<Theme>({
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getBgAnsi: () => "",
});

/** The real manager the extension built, captured at its spawn boundary. */
interface ManagerHolder {
  current?: AgentManager;
}

interface Pending {
  kind: "run" | "resume";
  settle: (text: string) => void;
}

async function host(t: TestContext) {
  const handlers = new Map<string, LifecycleHandler>();
  const notices: Notice[] = [];
  let renderer: MessageRenderer<NotificationDetails> | undefined;
  const pi = asExtensionAPI({
    events: partialFixture<ExtensionAPI["events"]>({
      emit: () => undefined,
      on: () => () => undefined,
    }),
    on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
    registerCommand: () => undefined,
    registerMessageRenderer: <T>(customType: string, render: MessageRenderer<T>) => {
      if (customType !== "subagent-notification") return;
      // SAFETY: the subagent-notification renderer is registered with NotificationDetails.
      renderer = render as MessageRenderer<NotificationDetails>;
    },
    registerTool: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: RuntimeValue) => {
      // SAFETY: the extension sends subagent-notification messages with NotificationDetails.
      notices.push(message as Notice);
    },
  });
  await subagentsExtension(pi);
  const key = Symbol.for("pi-subagents:manager");
  // SAFETY: Root activation owns this documented manager slot in this isolated test process.
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: Pick<AgentManager, "spawn"> | undefined;
  };
  const rootManager = registry[key];
  assert.ok(rootManager);
  const pending: Pending[] = [];
  const session = partialFixture<AgentSession>({ dispose: () => undefined });
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      return new Promise((resolve) => {
        pending.push({
          kind: "run",
          settle: (text) =>
            resolve({
              responseText: text,
              session,
              aborted: options.signal?.aborted === true,
              steered: false,
            }),
        });
      });
    },
    resumeAgent(_session, _prompt, options) {
      return new Promise((resolve) => {
        pending.push({
          kind: "resume",
          settle: (text) => resolve({ text, aborted: options?.signal?.aborted === true }),
        });
      });
    },
  };
  const holder: ManagerHolder = {};
  const spawn = AgentManager.prototype.spawn;
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      holder.current = this;
      assert.equal(Reflect.set(this, "runner", runner), true);
      this.setMaxConcurrent(4);
      return spawn.apply(this, args);
    },
  );
  const ctx = partialFixture<ExtensionContext>({
    cwd: process.cwd(),
    sessionManager: partialFixture<ExtensionContext["sessionManager"]>({
      getSessionId: () => "verdict-notification-runs",
      getEntries: () => [],
    }),
  });
  const start = handlers.get("session_start");
  assert.ok(start);
  await start({}, ctx);
  const manager = () => {
    assert.ok(holder.current);
    return holder.current;
  };
  async function next(kind: Pending["kind"], before: number): Promise<Pending> {
    const deadline = Date.now() + 2_000;
    while (pending.length === before && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const entry = pending[before];
    assert.ok(entry, "the child run did not start");
    assert.equal(entry.kind, kind);
    return entry;
  }
  const gate = () => new Promise<void>((resolve) => setTimeout(resolve, NUDGE_HOLD_MS + 80));
  return {
    notices,
    spawnBackground(description: string): string {
      return rootManager.spawn(pi, ctx, "general", "review", {
        description,
        isBackground: true,
        isolated: true,
      });
    },
    pending,
    next,
    gate,
    async resume(id: string, text: string, stop = false) {
      const before = pending.length;
      await manager().resume(id, "again", undefined, { isBackground: true });
      const entry = await next("resume", before);
      if (stop) manager().abort(id);
      entry.settle(text);
      await gate();
    },
    stop(id: string) {
      manager().abort(id);
    },
    render(notice: Notice, expanded = false, width = 170): string {
      assert.ok(renderer);
      const component = renderer(
        {
          role: "custom",
          customType: notice.customType,
          content: notice.content,
          display: true,
          details: notice.details,
          timestamp: 0,
        },
        {
          expanded,
          outputPad: 0,
          keyText: (key: string) => key,
          keyHint: (key: string, text: string) => `${key} ${text}`,
        },
        theme,
      );
      assert.ok(component);
      return component
        .render(width)
        .map((line) => stripVTControlCharacters(line).trimEnd())
        .join("\n");
    },
    async close() {
      for (const entry of pending) entry.settle("closing");
      await holder.current?.waitForAll();
      const shutdown = handlers.get("session_shutdown");
      assert.ok(shutdown);
      await shutdown();
    },
  };
}

async function completeOnce(
  h: Awaited<ReturnType<typeof host>>,
  description: string,
  text: string,
) {
  const before = h.pending.length;
  const id = h.spawnBackground(description);
  const entry = await h.next("run", before);
  entry.settle(text);
  await h.gate();
  return id;
}

function noticeFor(notices: Notice[], index: number): Notice {
  const notice = notices[index];
  assert.ok(notice, `notification ${index} was not sent`);
  assert.equal(notice.customType, "subagent-notification");
  return notice;
}

test("a FINDINGS notification still shows FINDINGS after a resumed run with the same opening ends NO_FINDINGS", async (t) => {
  const h = await host(t);
  try {
    const id = await completeOnce(h, "review run", reply(PREFIX, "FINDINGS"));
    const first = noticeFor(h.notices, 0);
    assert.match(h.render(first), /Review FINDINGS: 1 finding \(1 high\)/);
    await h.resume(id, reply(PREFIX, "NO_FINDINGS"));
    const second = noticeFor(h.notices, 1);
    assert.match(h.render(second), /Review NO_FINDINGS/);
    const again = h.render(first);
    assert.doesNotMatch(again, /NO_FINDINGS/);
    assert.match(again, /Review FINDINGS: 1 finding \(1 high\)/);
  } finally {
    await h.close();
  }
});

test("after a resumed run with a different opening, the first notification keeps its own summary", async (t) => {
  const h = await host(t);
  try {
    const id = await completeOnce(h, "review run", reply(PREFIX, "FINDINGS"));
    const first = noticeFor(h.notices, 0);
    await h.resume(id, reply("Second look.\n\n" + PREFIX, "NO_FINDINGS"));
    const again = h.render(first);
    assert.match(again, /Review FINDINGS: 1 finding \(1 high\)/);
    assert.doesNotMatch(again, /NO_FINDINGS/);
  } finally {
    await h.close();
  }
});

test("a stopped run resumed and stopped again keeps each notification's own verdict", async (t) => {
  const h = await host(t);
  try {
    const before = h.pending.length;
    const id = h.spawnBackground("stopped review");
    const entry = await h.next("run", before);
    h.stop(id);
    entry.settle(reply(PREFIX, "FINDINGS"));
    await h.gate();
    const first = noticeFor(h.notices, 0);
    assert.equal(first.details.status, "stopped");
    const firstView = h.render(first);
    await h.resume(id, reply(PREFIX, "NO_FINDINGS"), true);
    const second = noticeFor(h.notices, 1);
    assert.equal(second.details.status, "stopped");
    assert.equal(h.render(first), firstView);
    assert.doesNotMatch(h.render(first), /NO_FINDINGS/);
  } finally {
    await h.close();
  }
});

test("in a grouped notification each agent is summarised from its own run after one is resumed", async (t) => {
  const h = await host(t);
  try {
    const before = h.pending.length;
    const a = h.spawnBackground("group a");
    const b = h.spawnBackground("group b");
    const runA = await h.next("run", before);
    const runB = await h.next("run", before + 1);
    runA.settle(reply(PREFIX, "FINDINGS"));
    runB.settle(reply(PREFIX, "FINDINGS"));
    await h.gate();
    const grouped = noticeFor(h.notices, 0);
    assert.equal(grouped.details.others?.length, 1);
    assert.equal(h.render(grouped).split("Review FINDINGS: 1 finding (1 high)").length, 3);
    await h.resume(b, reply(PREFIX, "NO_FINDINGS"));
    assert.ok(a);
    const again = h.render(grouped);
    assert.equal(again.split("Review FINDINGS: 1 finding (1 high)").length, 3, again);
    assert.doesNotMatch(again, /NO_FINDINGS/);
  } finally {
    await h.close();
  }
});

test("after a restart the stored notification renders from its own details, with no live record", async (t) => {
  const first = await host(t);
  let stored: Notice;
  try {
    await completeOnce(first, "review run", reply(PREFIX, "FINDINGS"));
    stored = noticeFor(first.notices, 0);
  } finally {
    await first.close();
  }
  // Two hosts in one test mock the same prototype method; restore the first before the second.
  t.mock.restoreAll();
  const restarted = await host(t);
  try {
    const view = restarted.render(stored);
    assert.match(view, /Review FINDINGS: 1 finding \(1 high\)/);
    // A notification stored before this change has only the preview: drawn as before, no summary.
    const legacy: Notice = { ...stored, details: { ...stored.details } };
    assert.equal(Reflect.deleteProperty(legacy.details, "verdictReply"), true);
    assert.doesNotMatch(restarted.render(legacy), /Review FINDINGS:/);
  } finally {
    await restarted.close();
  }
});

test("model input is unchanged and a reply without a block stores nothing extra", async (t) => {
  const h = await host(t);
  try {
    const id = await completeOnce(h, "review run", reply(PREFIX, "FINDINGS"));
    await completeOnce(h, "plain run", PREFIX.repeat(2));
    const verdict = noticeFor(h.notices, 0);
    const plain = noticeFor(h.notices, 1);
    assert.ok(id);
    assert.equal(verdict.content.includes("verdictReply"), false);
    assert.equal(
      verdict.content.includes('"verdict": "FINDINGS"'),
      false,
      "the model sees only the 500-character preview",
    );
    assert.equal(compile(KeptReplySchema).check(verdict.details), true);
    assert.equal(Object.hasOwn(plain.details, "verdictReply"), false);
  } finally {
    await h.close();
  }
});
