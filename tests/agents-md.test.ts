import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The package ships TypeScript source only (`pi.extensions: ["./index.ts"]`),
// so these load straight from `src/` under Node's type stripping instead of
// from a built `dist/`. Mirrors tests/subagent-config.test.ts.
const packageRoot = resolve(".pi/packages/choco-pi-agents-md/src");
const STALE_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload.";

async function loadSubdir() {
  return import(pathToFileURL(resolve(packageRoot, "subdir.ts")).href);
}

async function loadAppendixConstants() {
  return import(pathToFileURL(resolve(packageRoot, "appendix.ts")).href);
}

interface StubUi {
  notify: (message: string, type?: string) => void;
  notifications: { message: string; type?: string }[];
}

function createStubUi(): StubUi {
  const notifications: { message: string; type?: string }[] = [];
  return {
    notifications,
    notify(message, type) {
      notifications.push({ message, type });
    },
  };
}

/** Minimal ExtensionAPI stub: records `on()` handlers by event name. */
function createStubPi() {
  const handlers = new Map<
    string,
    (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue | Promise<RuntimeValue>
  >();
  return {
    on(event: string, handler: (event: RuntimeValue, ctx: RuntimeValue) => RuntimeValue) {
      handlers.set(event, handler);
    },
    handlers,
  };
}

function makeTmpTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "choco-pi-agents-md-"));
}

function writeAgents(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), content);
}

function readToolResultEvent(filePath: string) {
  return {
    type: "tool_result",
    toolCallId: "1",
    toolName: "read",
    input: { path: filePath },
    content: [{ type: "text", text: "file body" }],
    isError: false,
    details: undefined,
  };
}

async function setup(
  root: string,
  dependencies?: { readFile?: (filePath: string) => Promise<string> },
) {
  const { registerAgentsMdAutoload } = await loadSubdir();
  const pi = createStubPi();
  registerAgentsMdAutoload(pi, dependencies);
  const ui = createStubUi();
  const baseCtx = { cwd: root, hasUI: true, ui };
  // session_start and session_tree share the same handler.
  pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, baseCtx);
  return { pi, ui, baseCtx };
}

function appendixText(
  result: { content: { type: string; text?: string }[] } | undefined,
): string | undefined {
  if (!result) return undefined;
  const block = result.content.findLast(
    (item) => item.type === "text" && item.text?.includes("<subdirectory_agents_context>"),
  );
  return block?.text;
}

test("injects the AGENTS.md chain root-first, leaf-last, skipping missing levels", async () => {
  const root = makeTmpTree();
  try {
    writeAgents(root, "root guidance"); // session root's own AGENTS.md: must be excluded
    writeAgents(path.join(root, "a"), "A guidance");
    // root/a/b has no AGENTS.md: missing level, must be skipped silently
    writeAgents(path.join(root, "a", "b", "c"), "C guidance");
    const leaf = path.join(root, "a", "b", "c", "leaf.txt");
    fs.writeFileSync(leaf, "leaf content");

    const { pi, baseCtx } = await setup(root);
    // SAFETY: The fixture supplies every host member exercised by this test.
    const result = (await pi.handlers.get("tool_result")?.(readToolResultEvent(leaf), baseCtx)) as
      | { content: { type: string; text?: string }[] }
      | undefined;

    const text = appendixText(result);
    assert.ok(text, "expected an injected subdirectory_agents_context block");
    // Root-first / leaf-last ordering: "A guidance" (a/) must appear before "C guidance" (a/b/c/).
    const aIndex = text!.indexOf("A guidance");
    const cIndex = text!.indexOf("C guidance");
    assert.ok(aIndex >= 0 && cIndex >= 0, "expected both A and C guidance in the appendix");
    assert.ok(aIndex < cIndex, "expected root-most AGENTS.md (a/) before leaf-most (a/b/c/)");
    // The session root's own AGENTS.md must not be injected.
    assert.ok(!text!.includes("root guidance"), "session root AGENTS.md must be excluded");
    // No AGENTS.md file entry for the missing a/b level.
    assert.ok(!text!.includes('path="a/b/AGENTS.md"'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dedups: an already-injected AGENTS.md is not injected again for a later touch in the same chain", async () => {
  const root = makeTmpTree();
  try {
    writeAgents(root, "root guidance");
    writeAgents(path.join(root, "a"), "A guidance");
    writeAgents(path.join(root, "a", "d"), "D guidance");
    const leaf1 = path.join(root, "a", "leaf1.txt");
    const leaf2 = path.join(root, "a", "d", "leaf2.txt");
    fs.writeFileSync(leaf1, "one");
    fs.writeFileSync(leaf2, "two");

    const { pi, baseCtx } = await setup(root);

    // SAFETY: The fixture supplies every host member exercised by this test.
    const first = (await pi.handlers.get("tool_result")?.(readToolResultEvent(leaf1), baseCtx)) as
      | { content: { type: string; text?: string }[] }
      | undefined;
    const firstText = appendixText(first);
    assert.ok(firstText?.includes("A guidance"));

    // Same file again: nothing new, handler must return undefined (fully deduped).
    const repeat = await pi.handlers.get("tool_result")?.(readToolResultEvent(leaf1), baseCtx);
    assert.equal(repeat, undefined, "expected no injection on an exact repeat touch");

    // A different leaf whose chain overlaps (a/) but extends further (a/d/): only D guidance is new.
    // SAFETY: The fixture supplies every host member exercised by this test.
    const second = (await pi.handlers.get("tool_result")?.(readToolResultEvent(leaf2), baseCtx)) as
      | { content: { type: string; text?: string }[] }
      | undefined;
    const secondText = appendixText(second);
    assert.ok(secondText, "expected injection for the newly-reached D guidance");
    assert.ok(secondText!.includes("D guidance"));
    assert.ok(
      !secondText!.includes("A guidance"),
      "A guidance was already injected and must not repeat",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown invalidates a pending AGENTS.md read before extension replacement", async () => {
  const parent = makeTmpTree();
  try {
    const root = path.join(parent, "project");
    const nested = path.join(root, "a");
    writeAgents(root, "project guidance");
    writeAgents(nested, "nested guidance");
    const leaf = path.join(nested, "leaf.txt");
    fs.writeFileSync(leaf, "leaf");

    const nestedAgentsPath = fs.realpathSync(path.join(nested, "AGENTS.md"));
    let resolveDeferredRead: ((content: string) => void) | undefined;
    const deferredRead = new Promise<string>((resolveRead) => {
      resolveDeferredRead = resolveRead;
    });
    let deferred = false;
    const { pi, baseCtx } = await setup(root, {
      readFile: async (filePath) => {
        if (filePath === nestedAgentsPath && !deferred) {
          deferred = true;
          return deferredRead;
        }
        return fs.promises.readFile(filePath, "utf-8");
      },
    });

    let oldWrapperIsStale = false;
    let staleContextAccesses = 0;
    const oldCtx = {
      get cwd() {
        if (oldWrapperIsStale) {
          staleContextAccesses += 1;
          throw new Error(STALE_CONTEXT_MESSAGE);
        }
        return baseCtx.cwd;
      },
      get hasUI() {
        if (oldWrapperIsStale) {
          staleContextAccesses += 1;
          throw new Error(STALE_CONTEXT_MESSAGE);
        }
        return true;
      },
      get ui() {
        if (oldWrapperIsStale) {
          staleContextAccesses += 1;
          throw new Error(STALE_CONTEXT_MESSAGE);
        }
        return baseCtx.ui;
      },
    };
    let stalePiAccesses = 0;
    let emissions = 0;
    Object.defineProperty(pi, "events", {
      configurable: true,
      get() {
        if (oldWrapperIsStale) {
          stalePiAccesses += 1;
          throw new Error(STALE_CONTEXT_MESSAGE);
        }
        return { emit: () => emissions++ };
      },
    });

    const oldResultPromise = pi.handlers
      .get("tool_result")
      ?.call(undefined, readToolResultEvent(leaf), oldCtx);
    assert.ok(oldResultPromise instanceof Promise);
    assert.equal(deferred, true, "the old handler must be paused in the injected read seam");

    pi.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, baseCtx);
    oldWrapperIsStale = true;
    resolveDeferredRead?.("nested guidance");

    assert.equal(await oldResultPromise, undefined);
    assert.equal(staleContextAccesses, 0, "stale ctx must not be accessed after the read");
    assert.equal(stalePiAccesses, 0, "stale pi must not be accessed after the read");
    assert.equal(emissions, 0, "the stale handler must not emit lifecycle events");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

for (const sessionEvent of ["session_start", "session_tree"] as const) {
  test(`${sessionEvent} resets dedup without stale-read contamination`, async () => {
    const parent = makeTmpTree();
    try {
      const root = path.join(parent, "project");
      const nested = path.join(root, "a");
      writeAgents(root, "project guidance");
      writeAgents(nested, "nested guidance");
      const leaf = path.join(nested, "leaf.txt");
      fs.writeFileSync(leaf, "leaf");

      const nestedAgentsPath = fs.realpathSync(path.join(nested, "AGENTS.md"));
      let resolveDeferredRead: ((content: string) => void) | undefined;
      const deferredRead = new Promise<string>((resolveRead) => {
        resolveDeferredRead = resolveRead;
      });
      let deferred = false;
      let emissions = 0;
      const { pi, baseCtx } = await setup(root, {
        readFile: async (filePath) => {
          if (filePath === nestedAgentsPath && !deferred) {
            deferred = true;
            return deferredRead;
          }
          return fs.promises.readFile(filePath, "utf-8");
        },
      });
      Object.defineProperty(pi, "events", {
        configurable: true,
        value: { emit: () => emissions++ },
      });

      const staleResultPromise = pi.handlers
        .get("tool_result")
        ?.call(undefined, readToolResultEvent(leaf), baseCtx);
      assert.ok(staleResultPromise instanceof Promise);
      assert.equal(deferred, true, "the stale read must pause at the injected seam");

      const currentCtx = { cwd: parent, hasUI: true, ui: createStubUi() };
      pi.handlers.get(sessionEvent)?.({ type: sessionEvent, reason: "new" }, currentCtx);
      resolveDeferredRead?.("nested guidance");
      assert.equal(await staleResultPromise, undefined);
      assert.equal(emissions, 0, "the stale read must not emit lifecycle events");

      // SAFETY: The fixture supplies every host member exercised by this test.
      const currentResult = (await pi.handlers
        .get("tool_result")
        ?.call(undefined, readToolResultEvent(leaf), currentCtx)) as
        | { content: { type: string; text?: string }[] }
        | undefined;
      const currentText = appendixText(currentResult);
      assert.ok(currentText?.includes("project guidance"));
      assert.ok(
        currentText?.includes("nested guidance"),
        "the stale read must not contaminate current-session dedup state",
      );
      assert.equal(emissions, 2, "the current handler must emit for both injected files");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("caps total injected appendix size, dropping the root-most files first", async () => {
  const { MAX_FILE_CHARS, MAX_TOTAL_APPENDIX_CHARS } = await loadAppendixConstants();
  const root = makeTmpTree();
  try {
    writeAgents(root, "root guidance");
    // Four large AGENTS.md files whose combined size exceeds the total cap,
    // each individually under the per-file cap (so no per-file truncation
    // happens; only the total-appendix drop logic is exercised).
    const perFileSize = MAX_FILE_CHARS - 100;
    writeAgents(path.join(root, "l1"), `L1:${"x".repeat(perFileSize)}`);
    writeAgents(path.join(root, "l1", "l2"), `L2:${"y".repeat(perFileSize)}`);
    writeAgents(path.join(root, "l1", "l2", "l3"), `L3:${"z".repeat(perFileSize)}`);
    writeAgents(path.join(root, "l1", "l2", "l3", "l4"), `L4:${"w".repeat(perFileSize)}`);
    assert.ok(
      4 * (perFileSize + 3) > MAX_TOTAL_APPENDIX_CHARS,
      "test fixture must exceed the total cap for this assertion to be meaningful",
    );
    const leaf = path.join(root, "l1", "l2", "l3", "l4", "leaf.txt");
    fs.writeFileSync(leaf, "leaf");

    const { pi, baseCtx } = await setup(root);
    // SAFETY: The fixture supplies every host member exercised by this test.
    const result = (await pi.handlers.get("tool_result")?.(readToolResultEvent(leaf), baseCtx)) as
      | { content: { type: string; text?: string }[] }
      | undefined;
    const text = appendixText(result);
    assert.ok(text, "expected an injected appendix");
    assert.ok(
      text!.length <= MAX_TOTAL_APPENDIX_CHARS + 2000,
      "appendix should respect the total size cap (plus wrapper markup)",
    );
    // Root-most (l1) must be dropped before the leaf-most (l3) file when over budget.
    assert.ok(
      !text!.includes("L1:xxx"),
      "expected the root-most oversized file to be dropped first",
    );
    assert.ok(text!.includes("L4:"), "expected the leaf-most oversized file to survive the cap");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
