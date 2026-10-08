import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DAYBREAK_DEFAULT_KEY,
  flushAgentPreferenceWrites,
  readAgentPreferencesAsync,
} from "../.pi/extensions/lib/agent-preferences.ts";
import {
  agentPreferencesCompletions,
  parseDaybreakValue,
  resolveAgentPreferencesArgs,
} from "../.pi/extensions/lib/agent-preferences-dialog.ts";
import { DAYBREAK_ENTRY, getDaybreakBridge } from "../.pi/extensions/lib/daybreak-state.ts";
import {
  isJsonRecord,
  reinterpretHostValue,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";
import modelControls, { applyDaybreakAction } from "../.pi/extensions/model-controls.ts";
import { reseedDaybreakDefault } from "../.pi/extensions/runtime-agent-preferences.ts";

type Handler = (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue;
type FocusedControls = Map<
  string,
  { setFast(action: string): string; setDaybreak?(action: string): string }
>;

function codexModel(): Model<Api> {
  return {
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

async function withAgentDir<T>(
  settings: Record<string, boolean> | undefined,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), "daybreak-ui-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (settings) await writeFile(path.join(dir, "settings.json"), JSON.stringify(settings));
    return await run(dir);
  } finally {
    await flushAgentPreferenceWrites();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function daybreakSession(id: string, entries: RuntimeValue[] = []) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: RuntimeValue) => Promise<void>>();
  const appended: { type: string; data: RuntimeValue }[] = [];
  const notices: string[] = [];
  const ctx = {
    mode: "rpc",
    model: codexModel(),
    sessionManager: { getBranch: () => entries, getSessionId: () => id },
    ui: { notify: (message: string) => notices.push(message), setStatus: () => {} },
  };
  modelControls(
    reinterpretHostValue<ExtensionAPI>({
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: (
        name: string,
        options: { handler: (args: string, context: RuntimeValue) => Promise<void> },
      ) => commands.set(name, options.handler),
      appendEntry: (type: string, data: RuntimeValue) => appended.push({ type, data }),
    }),
  );
  return {
    appended,
    notices,
    start: () => handlers.get("session_start")?.({}, ctx),
    tree: () => handlers.get("session_tree")?.({}, ctx),
    stop: () => handlers.get("session_shutdown")?.({}, ctx),
    run: (args: string) => commands.get("daybreak")?.(args, ctx),
    request: (payload: RuntimeValue) => handlers.get("before_provider_request")?.({ payload }, ctx),
    state: () => getDaybreakBridge().get(id)?.getState(),
  };
}

test("/daybreak on|off|status persists the request and status does not advance revision", async () => {
  await withAgentDir(undefined, async () => {
    const session = daybreakSession("db-command");
    await session.start();
    try {
      assert.equal(session.state()?.requested, false);
      await session.run("status");
      assert.deepEqual(session.notices, ["Daybreak: off"]);
      assert.equal(session.state()?.revision, 0);
      await session.run("on");
      assert.equal(session.state()?.revision, 1);
      assert.match(session.notices.at(-1) ?? "", /requested; Daybreak lookup failed/);
      await session.run("status");
      await session.run("status");
      assert.equal(session.state()?.revision, 1, "status is read-only");
      const controller = getDaybreakBridge().get("db-command");
      assert.ok(controller);
      controller.report("model-not-supported", controller.getState().revision);
      await session.run("status");
      assert.match(session.notices.at(-1) ?? "", /current model does not support Daybreak/);
      await session.run("bogus");
      assert.match(session.notices.at(-1) ?? "", /Usage: \/daybreak/);
      await session.run("off");
      assert.deepEqual(
        session.appended.map((item) => item.data),
        [
          { enabled: true, source: "explicit", revision: 1 },
          { enabled: false, source: "explicit", revision: 2 },
        ],
      );
      assert.ok(session.appended.every((item) => item.type === DAYBREAK_ENTRY));
    } finally {
      session.stop();
    }
    assert.equal(session.state(), undefined, "shutdown disposes the controller");
  });
});

test("persisted entries restore on session start and tree", async () => {
  await withAgentDir({ [DAYBREAK_DEFAULT_KEY]: false }, async () => {
    const entries: RuntimeValue[] = [
      {
        type: "custom",
        customType: DAYBREAK_ENTRY,
        data: { enabled: true, source: "explicit", revision: 4 },
      },
    ];
    const session = daybreakSession("db-restore", entries);
    await session.start();
    try {
      assert.equal(session.state()?.requested, true);
      assert.equal(session.state()?.revision, 4);
      assert.equal(session.state()?.outcome, "lookup-failed", "outcome is not restored");
      entries.push({
        type: "custom",
        customType: DAYBREAK_ENTRY,
        data: { enabled: false, source: "explicit", revision: 5 },
      });
      await session.tree();
      assert.equal(session.state()?.requested, false);
      assert.equal(session.state()?.generation, 1);
    } finally {
      session.stop();
    }
  });
});

test("the global preference seeds only default-source state", async () => {
  await withAgentDir({ [DAYBREAK_DEFAULT_KEY]: true }, async () => {
    const seeded = daybreakSession("db-seeded");
    await seeded.start();
    const explicit = daybreakSession("db-explicit", [
      {
        type: "custom",
        customType: DAYBREAK_ENTRY,
        data: { enabled: false, source: "explicit", revision: 1 },
      },
    ]);
    await explicit.start();
    try {
      assert.equal(seeded.state()?.requested, true);
      assert.equal(seeded.state()?.source, "default");
      assert.equal(seeded.state()?.revision, 1);
      assert.deepEqual(seeded.appended, [], "a default seed is not persisted");
      assert.equal(explicit.state()?.requested, false, "explicit outranks the preference");

      reseedDaybreakDefault("db-seeded", false);
      reseedDaybreakDefault("db-explicit", true);
      assert.equal(seeded.state()?.requested, false);
      assert.equal(seeded.state()?.revision, 2);
      assert.equal(explicit.state()?.requested, false);
    } finally {
      seeded.stop();
      explicit.stop();
    }
  });
});

test("an existing default controller follows the preference; explicit and inherited stay", async () => {
  await withAgentDir({ [DAYBREAK_DEFAULT_KEY]: true }, async () => {
    const bridge = getDaybreakBridge();
    const owners = ["db-pre-default", "db-pre-inherited", "db-pre-explicit"] as const;
    const sources = ["default", "inherited", "explicit"] as const;
    owners.forEach((sessionId, index) =>
      bridge.register({
        sessionId,
        owner: {},
        generation: 0,
        initial: { requested: false, source: sources[index] },
      }),
    );
    const sessions = owners.map((sessionId) => daybreakSession(sessionId));
    try {
      for (const session of sessions) await session.start();
      assert.deepEqual(
        sessions.map((session) => session.state()?.requested),
        [true, false, false],
      );
    } finally {
      for (const session of sessions) session.stop();
      for (const sessionId of owners) bridge.get(sessionId)?.dispose();
    }
  });
});

test("provider requests strip access_programs and never add it", async () => {
  await withAgentDir(undefined, async () => {
    const session = daybreakSession("db-request");
    await session.start();
    try {
      await session.run("on");
      const controller = getDaybreakBridge().get("db-request");
      controller?.report("blue", controller.getState().revision);
      const stripped = session.request({ model: "m", access_programs: ["daybreak_blue"] });
      assert.ok(isJsonRecord(stripped) && !("access_programs" in stripped));
      // Nothing to strip: the hook never adds the field, whatever else it decides.
      const untouched = session.request({ model: "m" });
      assert.ok(
        untouched === undefined || (isJsonRecord(untouched) && !("access_programs" in untouched)),
      );
    } finally {
      session.stop();
    }
  });
});

test("focused routing exposes setDaybreak beside setFast", async () => {
  await withAgentDir(undefined, async () => {
    const session = daybreakSession("db-focused");
    await session.start();
    try {
      const host: typeof globalThis & {
        [key: symbol]: FocusedControls | undefined;
      } = globalThis;
      const focused =
        host[Symbol.for("choco-pi.model-controls.focused-sessions")]?.get("db-focused");
      assert.ok(focused?.setDaybreak);
      assert.match(focused.setDaybreak("on"), /requested/);
      assert.equal(session.state()?.requested, true);
      assert.equal(
        focused.setDaybreak("status"),
        "Daybreak: requested; Daybreak lookup failed or not yet confirmed",
      );
    } finally {
      session.stop();
    }
  });
});

test("applyDaybreakAction toggles, rejects bad input, and reports uninitialized state", () => {
  assert.equal(applyDaybreakAction(undefined, "status"), "Daybreak: not initialized");
  assert.throws(() => applyDaybreakAction(undefined, "on"), /not initialized/);
  assert.throws(() => applyDaybreakAction(undefined, "maybe"), /Usage/);
});

test("preferences: daybreak defaults false, parses, and writes through /preferences", async () => {
  await withAgentDir(undefined, async (dir) => {
    assert.equal((await readAgentPreferencesAsync(dir)).daybreak, false);
    assert.equal(parseDaybreakValue(" ON "), true);
    assert.equal(parseDaybreakValue("off"), false);
    assert.equal(parseDaybreakValue("yes"), undefined);
    assert.deepEqual(
      agentPreferencesCompletions("daybreak o").map((item) => item.value),
      ["daybreak off", "daybreak on"],
    );
    const notices: string[] = [];
    const ctx = reinterpretHostValue<ExtensionCommandContext>({
      ui: { notify: (message: string) => notices.push(message) },
    });
    assert.deepEqual(resolveAgentPreferencesArgs("daybreak", ctx), {
      open: true,
      section: "agent",
      focusId: DAYBREAK_DEFAULT_KEY,
    });
    assert.deepEqual(resolveAgentPreferencesArgs("daybreak maybe", ctx), { open: false });
    assert.match(notices.at(-1) ?? "", /not one of off, on/);
    assert.deepEqual(resolveAgentPreferencesArgs("daybreak on", ctx), { open: false });
    await flushAgentPreferenceWrites();
    const settings: unknown = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
    assert.deepEqual(settings, { [DAYBREAK_DEFAULT_KEY]: true });
    assert.equal((await readAgentPreferencesAsync(dir)).daybreak, true);
  });
});

test("applyDaybreakAction status projects a non-canonical model as auth-not-eligible", () => {
  const bridge = getDaybreakBridge();
  const controller = bridge.register({
    sessionId: "status-projection",
    owner: {},
    generation: 1,
    initial: { requested: true, source: "explicit" },
    persist: () => undefined,
  });
  try {
    controller.report("blue", controller.getState().revision);
    const codex = codexModel();
    const opus: Model<Api> = {
      ...codexModel(),
      id: "claude-opus-5-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    };
    assert.match(applyDaybreakAction(controller, "status", codex), /on \(blue\)/);
    assert.match(applyDaybreakAction(controller, "status", opus), /not eligible/);
    assert.match(applyDaybreakAction(controller, "status"), /on \(blue\)/);
  } finally {
    controller.dispose();
  }
});
