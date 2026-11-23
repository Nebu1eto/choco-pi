import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue } from "@choco-pi/shared/runtime-values";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { createNestedTools } from "../src/adapter/code-mode.ts";
import { activeRegisteredSessionToolNames } from "../src/adapter/code-mode/session-tool-permissions.ts";
import { registerStandaloneCodeMode, type StandaloneCodeMode } from "../src/standalone.ts";

const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-standalone-host-selection-"));
process.env["PI_CODING_AGENT_DIR"] = agentDir;
test.after(() => rm(agentDir, { recursive: true, force: true }));

const REGISTERED_TOOLS = ["read", "bash", "edit", "write", "web_search", "exec", "wait"];

interface Notification {
  message: string;
  level: string | undefined;
}

interface Harness {
  handle: StandaloneCodeMode;
  active(): string[];
  setHostActive(names: string[]): void;
  fire(event: string, ctx: ExtensionContext): Promise<void>;
  nestedToolNames(ctx: ExtensionContext): string[];
}

function contextWithNotifications(notifications: Notification[]): ExtensionContext {
  const model = getBuiltinModels("anthropic")[0];
  if (!model) throw new Error("no builtin anthropic model");
  return reinterpretHostValue<ExtensionContext>({
    model,
    hasUI: true,
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
  });
}

async function harness(initialActive: string[]): Promise<Harness> {
  let handle: StandaloneCodeMode | undefined;
  const runtime = createExtensionRuntime();
  let active = [...initialActive];
  const extension = await loadExtensionFromFactory(
    async (pi: ExtensionAPI) => {
      handle = await registerStandaloneCodeMode(pi);
    },
    process.cwd(),
    createEventBus(),
    runtime,
    "code-mode-standalone-host-selection",
  );
  runtime.getActiveTools = () => [...active];
  runtime.setActiveTools = (names: string[]) => {
    active = [...names];
  };
  runtime.getAllTools = () =>
    reinterpretHostValue<ReturnType<ExtensionAPI["getAllTools"]>>(
      REGISTERED_TOOLS.map((name) => ({ name })),
    );
  const source = {
    getActiveTools: () => [...active],
    getAllTools: () => REGISTERED_TOOLS.map((name) => ({ name })),
  };
  if (!handle) throw new Error("standalone Code Mode did not register");
  const registered = handle;
  return {
    handle: registered,
    active: () => [...active],
    setHostActive: (names) => {
      active = [...names];
    },
    fire: async (event, ctx) => {
      for (const handler of extension.handlers.get(event) ?? []) await handler({}, ctx);
    },
    nestedToolNames: (ctx) =>
      createNestedTools(
        registered.host,
        activeRegisteredSessionToolNames(source, registered.host.state.previousToolNames),
        ctx,
      ).map((tool) => tool.name),
  };
}

async function shutdown(handle: StandaloneCodeMode): Promise<void> {
  await handle.registration.shutdown();
  await handle.host.sessions.shutdown();
}

test("standalone Code Mode revokes nested tools after the host narrows its selection", async () => {
  const host = await harness(["read", "bash", "write"]);
  host.handle.registration.prepare = () => Promise.resolve();
  const ctx = contextWithNotifications([]);
  await host.fire("model_select", ctx);
  assert.deepEqual(host.active(), ["exec", "wait"]);
  const before = host.nestedToolNames(ctx);
  assert.ok(before.includes("exec_command"));
  assert.ok(before.includes("apply_patch"));

  host.setHostActive(["read"]);
  await host.fire("model_select", ctx);
  assert.deepEqual(host.handle.host.state.previousToolNames, ["read"]);
  const after = host.nestedToolNames(ctx);
  assert.equal(after.includes("exec_command"), false, "exec_command is revoked");
  assert.equal(after.includes("write_stdin"), false, "write_stdin is revoked");
  assert.equal(after.includes("apply_patch"), false, "apply_patch is revoked");
  await shutdown(host.handle);
});

test("standalone Code Mode keeps its permission snapshot across unchanged model switches", async () => {
  const host = await harness(["read", "bash", "write", "web_search"]);
  host.handle.registration.prepare = () => Promise.resolve();
  const ctx = contextWithNotifications([]);
  await host.fire("model_select", ctx);
  await host.fire("model_select", ctx);
  assert.deepEqual(host.active(), ["exec", "wait", "web_search"]);
  assert.deepEqual(host.handle.host.state.previousToolNames, [
    "read",
    "bash",
    "write",
    "web_search",
  ]);
  const nested = host.nestedToolNames(ctx);
  assert.ok(nested.includes("exec_command"));
  assert.ok(nested.includes("apply_patch"));
  await shutdown(host.handle);
});

test("standalone Code Mode extends its snapshot when the host only adds tools", async () => {
  const host = await harness(["read", "bash", "write"]);
  host.handle.registration.prepare = () => Promise.resolve();
  const ctx = contextWithNotifications([]);
  await host.fire("model_select", ctx);
  host.setHostActive(["exec", "wait", "web_search"]);
  await host.fire("model_select", ctx);
  assert.deepEqual(host.handle.host.state.previousToolNames, [
    "read",
    "bash",
    "write",
    "web_search",
  ]);
  assert.ok(host.nestedToolNames(ctx).includes("exec_command"));
  await shutdown(host.handle);
});

test("a superseded host preparation failure never notifies through the stale context", async () => {
  const host = await harness(["read", "bash", "write"]);
  let rejectFirst: ((error: Error) => void) | undefined;
  let calls = 0;
  host.handle.registration.prepare = () => {
    calls += 1;
    if (calls === 1)
      return new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
    return Promise.resolve();
  };
  const staleNotifications: Notification[] = [];
  const currentNotifications: Notification[] = [];
  await host.fire("model_select", contextWithNotifications(staleNotifications));
  await host.fire("model_select", contextWithNotifications(currentNotifications));
  assert.equal(calls, 2);
  if (!rejectFirst) throw new Error("first preparation did not start");
  rejectFirst(new Error("host setup exploded"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(staleNotifications, []);
  assert.deepEqual(currentNotifications, []);
  await shutdown(host.handle);
});

test("a current host preparation failure still notifies", async () => {
  const host = await harness(["read", "bash", "write"]);
  host.handle.registration.prepare = () => Promise.reject(new Error("host setup exploded"));
  const notifications: Notification[] = [];
  await host.fire("model_select", contextWithNotifications(notifications));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, [
    { message: "Code Mode host setup failed: host setup exploded", level: "error" },
  ]);
  await shutdown(host.handle);
});
