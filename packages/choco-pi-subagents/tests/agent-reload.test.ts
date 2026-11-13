import assert from "node:assert/strict";
import test from "node:test";
import { createAgentReloader } from "../src/agent-reload.ts";
import type { AgentConfig } from "../src/types.ts";

interface PendingLoad {
  cwd: string;
  resolve: (agents: Map<string, AgentConfig>) => void;
  reject: (error: Error) => void;
}

function agentNamed(name: string): AgentConfig {
  return {
    name,
    description: name,
    builtinToolNames: [],
    extensions: true,
    skills: true,
    systemPrompt: "",
    promptMode: "replace",
  };
}

function registryOf(...names: string[]): Map<string, AgentConfig> {
  return new Map(names.map((name) => [name, agentNamed(name)]));
}

/** A reloader whose loads settle only when the test says so. */
function harness() {
  const loads: PendingLoad[] = [];
  const registered: string[][] = [];
  let cwd = "/first";
  const reloader = createAgentReloader({
    load: (loadCwd) =>
      new Promise((resolve, reject) => {
        loads.push({ cwd: loadCwd, resolve, reject });
      }),
    register: (agents) => registered.push([...agents.keys()]),
    cwd: () => cwd,
  });
  return {
    loads,
    registered,
    reloader,
    setCwd: (next: string) => {
      cwd = next;
    },
  };
}

test("a reload overtaken by a newer one never registers, and both callers see the newer registry", async () => {
  const h = harness();
  const settled: string[] = [];
  const first = h.reloader.reload().then(() => settled.push("first"));
  h.setCwd("/second");
  const second = h.reloader.reload().then(() => settled.push("second"));
  assert.equal(h.loads.length, 2, "each call starts its own load so a just-written file is seen");
  assert.deepEqual(
    h.loads.map((load) => load.cwd),
    ["/first", "/second"],
    "cwd is snapshotted per reload before awaiting",
  );

  // The newer load finishes first and registers.
  h.loads[1]?.resolve(registryOf("second"));
  await second;
  assert.deepEqual(h.registered, [["second"]]);

  // The older load finishes last: its stale result is discarded.
  h.loads[0]?.resolve(registryOf("first"));
  await first;
  assert.deepEqual(h.registered, [["second"]], "the overtaken load must not register");
  assert.deepEqual(settled.sort(), ["first", "second"]);
});

test("an overtaken caller settles only once the newer reload has registered", async () => {
  const h = harness();
  let firstSettled = false;
  const first = h.reloader.reload().then(() => {
    firstSettled = true;
  });
  const second = h.reloader.reload();

  h.loads[0]?.resolve(registryOf("stale"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false, "coalesced onto the in-flight newer reload");
  assert.deepEqual(h.registered, []);

  h.loads[1]?.resolve(registryOf("fresh"));
  await Promise.all([first, second]);
  assert.equal(firstSettled, true);
  assert.deepEqual(h.registered, [["fresh"]]);
});

test("invalidate discards in-flight reloads without leaving their callers pending", async () => {
  const h = harness();
  const pending = h.reloader.reload();
  h.reloader.invalidate();
  h.loads[0]?.resolve(registryOf("late"));
  await pending;
  assert.deepEqual(h.registered, [], "a reload from a retired owner must not register");
});

test("reregister replays the last registered load without reading again", async () => {
  const h = harness();
  const reload = h.reloader.reload();
  h.loads[0]?.resolve(registryOf("kept"));
  await reload;
  h.reloader.reregister();
  assert.equal(h.loads.length, 1);
  assert.deepEqual(h.registered, [["kept"], ["kept"]]);
});

test("a strict load failure rejects its caller and leaves the registry untouched", async () => {
  const h = harness();
  const reload = h.reloader.reload(true);
  h.loads[0]?.reject(new Error("bad.md: unparseable"));
  await assert.rejects(reload, /bad\.md: unparseable/);
  assert.deepEqual(h.registered, []);
});
