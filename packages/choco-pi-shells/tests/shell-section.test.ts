import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import type {
  ShellSectionProvider,
  ShellSectionRegistration,
  ShellViewerHost,
} from "../../choco-pi-subagents/src/ui/shell-section-contract.ts";
import type { ShellChangeEvent, ShellResult, StopShellInput } from "../src/shell-manager.ts";
import {
  createShellSectionProvider,
  findShellSectionHost,
  type ShellSectionManager,
} from "../src/ui/shell-section.ts";
import type { ShellStreamChunk } from "../src/ui/shells-overlay.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function shell(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    shellId: "shell-1",
    ownerId: "root",
    command: "printf hello",
    cwd: "/tmp",
    state: "running",
    pid: 1234,
    startedAt: 100,
    ...overrides,
  };
}

function emptyStream(): ShellStreamChunk {
  return { data: "", startOffset: 0, nextOffset: 0, endOffset: 0, dropped: false };
}

class ManagerFixture implements ShellSectionManager {
  readonly listeners = new Set<(event: ShellChangeEvent) => void>();
  readonly stopCalls: StopShellInput[] = [];
  shells: ShellResult[] = [];
  stopResult: (input: StopShellInput) => Promise<ShellResult> = async (input) =>
    shell({ shellId: input.shellId, state: "stopped" });

  list() {
    return { shells: [...this.shells] };
  }

  read(input: Parameters<ShellSectionManager["read"]>[0]) {
    const found = this.shells.find((entry) => entry.shellId === input.shellId);
    if (!found) throw new Error(`Shell not found: ${input.shellId}`);
    return { shell: found, stdout: emptyStream(), stderr: emptyStream() };
  }

  stop(input: StopShellInput): Promise<ShellResult> {
    this.stopCalls.push(input);
    return this.stopResult(input);
  }

  onChange(listener: (event: ShellChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ShellChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class ViewerHostFixture implements ShellViewerHost {
  options: Parameters<ShellViewerHost["custom"]>[1];
  component: ReturnType<Parameters<ShellViewerHost["custom"]>[0]> | undefined;
  renders = 0;
  // SAFETY: The viewer constructor only reads requestRender before this test closes it.
  readonly tui = Object.assign(Object.create(null), {
    requestRender: () => this.renders++,
  }) as TUI;
  // SAFETY: The viewer constructor stores the theme, but this test closes it before rendering.
  readonly theme = {} as Theme;

  custom<T>(
    factory: (
      tui: TUI,
      theme: Parameters<Parameters<ShellViewerHost["custom"]>[0]>[1],
      keybindings: Parameters<Parameters<ShellViewerHost["custom"]>[0]>[2],
      done: (result: T) => void,
    ) => ReturnType<Parameters<ShellViewerHost["custom"]>[0]>,
    options?: Parameters<ShellViewerHost["custom"]>[1],
  ): Promise<T> {
    this.options = options;
    return new Promise<T>((resolve) => {
      this.component = factory(this.tui, this.theme, undefined, resolve);
    });
  }
}

test("seeds running shells and tracks changes until disposal", () => {
  const manager = new ManagerFixture();
  manager.shells = [shell(), shell({ shellId: "done", state: "exited", endedAt: 90 })];
  const provider = createShellSectionProvider({ manager, rootSessionId: "root" });
  let changes = 0;
  provider.onChange(() => changes++);

  assert.deepEqual(
    provider.rows(100).map((row) => row.shellId),
    ["shell-1"],
  );
  manager.emit({ type: "start", shell: shell({ shellId: "second" }) });
  manager.emit({ type: "end", shell: shell({ shellId: "shell-1", state: "exited" }) });

  assert.deepEqual(
    provider.rows(100).map((row) => row.shellId),
    ["shell-1", "second"],
  );
  assert.equal(changes, 2);
  provider.dispose();
  assert.equal(manager.listeners.size, 0);
  assert.deepEqual(provider.rows(100), []);
});

test("settled shells expire on read after the default four seconds", () => {
  const manager = new ManagerFixture();
  let now = 1_000;
  const provider = createShellSectionProvider({ manager, rootSessionId: "root", now: () => now });
  manager.emit({ type: "end", shell: shell({ state: "failed", error: "boom" }) });

  assert.equal(provider.rows(4_999).length, 1);
  assert.equal(provider.rows(5_000).length, 0);
  now = 9_000;
  assert.equal(provider.rows(now).length, 0);
  provider.dispose();
});

test("sanitizes and bounds shell-controlled row fields", () => {
  const manager = new ManagerFixture();
  const provider = createShellSectionProvider({ manager, rootSessionId: "root" });
  manager.emit({
    type: "end",
    shell: shell({
      name: `name\x1b[31m-red\x1b[0m\nnext\x07${"n".repeat(100)}`,
      ownerId: `nested\x1b[2J\nowner\x07${"o".repeat(100)}`,
      command: `printf\x1b[31m red\x1b[0m\nnext\x07 ${"c".repeat(100)}`,
      cwd: `/tmp/\x1b[2J\n${"d".repeat(100)}`,
      error: `bad\x1b[31m\n\x07${"e".repeat(100)}`,
      state: "failed",
    }),
  });

  const [row] = provider.rows(Date.now());
  assert.ok(row);
  assert.match(row.label, /^name-rednext/);
  assert.equal(row.label.length, 52);
  assert.match(row.ownerTag ?? "", /^\[owner:nestedowner/);
  assert.equal(row.command.length, 52);
  assert.match(row.command, /^printf rednext/);
  assert.equal(row.cwd.length, 80);
  assert.equal(row.error?.length, 40);
  for (const value of [row.label, row.ownerTag ?? "", row.command, row.cwd, row.error ?? ""]) {
    assert.equal(value.includes("\x1b"), false);
    assert.equal(value.includes("\x07"), false);
    assert.equal(value.includes("\n"), false);
  }
  provider.dispose();
});

test("stop uses root administrator authority and preserves rejection", async () => {
  const manager = new ManagerFixture();
  const provider = createShellSectionProvider({ manager, rootSessionId: "root" });
  await provider.stop("target");
  assert.deepEqual(manager.stopCalls, [{ requesterId: "root", isAdmin: true, shellId: "target" }]);

  const failure = new Error("stop failed");
  manager.stopResult = async () => {
    throw failure;
  };
  await assert.rejects(provider.stop("target"), (error) => error === failure);
  provider.dispose();
});

test("detects only a structurally valid shell section host", () => {
  interface TestRegistry {
    [key: symbol]:
      | { registerShellSection?: (provider: ShellSectionProvider) => ShellSectionRegistration }
      | undefined;
  }
  // SAFETY: This test temporarily owns and restores the documented process-global seam.
  const registry = globalThis as typeof globalThis & TestRegistry;
  const original = registry[MANAGER_KEY];
  try {
    delete registry[MANAGER_KEY];
    assert.equal(findShellSectionHost(), undefined);
    registry[MANAGER_KEY] = {};
    assert.equal(findShellSectionHost(), undefined);

    const registration: ShellSectionRegistration = { unregister() {} };
    const host = { registerShellSection: (_provider: ShellSectionProvider) => registration };
    registry[MANAGER_KEY] = host;
    assert.equal(findShellSectionHost()?.registerShellSection, host.registerShellSection);
  } finally {
    if (original) registry[MANAGER_KEY] = original;
    else delete registry[MANAGER_KEY];
  }
});

test("opens the production viewer overlay and exposes its closer", async () => {
  const manager = new ManagerFixture();
  manager.shells = [shell()];
  const provider = createShellSectionProvider({ manager, rootSessionId: "root" });
  const ui = new ViewerHostFixture();
  const closers: Array<() => void> = [];

  const opened = provider.openViewer("shell-1", ui, (closer) => {
    closers.push(closer);
  });
  assert.deepEqual(ui.options, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
  });
  assert.ok(ui.component);
  assert.equal(closers.length, 1);
  closers[0]?.();
  await opened;
  ui.component?.dispose?.();
  provider.dispose();
});

test("rejects opening a missing shell with sanitized text", async () => {
  const manager = new ManagerFixture();
  const provider = createShellSectionProvider({ manager, rootSessionId: "root" });
  await assert.rejects(
    provider.openViewer("missing\x1b[31m\n", new ViewerHostFixture(), () => {}),
    new Error("Shell not found: missing"),
  );
  provider.dispose();
});
