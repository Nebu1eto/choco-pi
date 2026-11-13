import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_FILE_CHARS } from "../src/appendix.ts";
import { readAgentsMdSettings } from "../src/settings.ts";
import { isDiscoveryShellCommand } from "../src/shell-targets.ts";
import {
  type AgentsMdSessionStats,
  registerAgentsMdAutoload,
  SESSION_STATS_EVENT,
} from "../src/subdir.ts";

interface TestContent {
  type: string;
  text?: string;
}

interface TestHandlerResult {
  content?: TestContent[];
}

interface TestContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level: "warning" | "info"): void;
  };
}

interface SessionStartFixture {
  type: "session_start";
  reason: "startup";
}

type TestEvent =
  | ReturnType<typeof readEvent>
  | ReturnType<typeof realHostCodeModeEvent>
  | SessionStartFixture;
type TestHandlerReturn = TestHandlerResult | void | Promise<TestHandlerResult | void>;
type TestHandler = (event: TestEvent, ctx: TestContext) => TestHandlerReturn;

interface InstructionsLoadedPayload {
  filePath: string;
  memoryType: string;
  loadReason: string;
}

type EmittedPayload = AgentsMdSessionStats | InstructionsLoadedPayload;

interface StubPi {
  on(event: string, handler: TestHandler): void;
  events: {
    emit(channel: string, data: EmittedPayload): void;
  };
}

interface StubPiHarness {
  pi: StubPi;
  handlers: Map<string, TestHandler>;
  emitted: { channel: string; data: EmittedPayload }[];
}

function createStubPi(): StubPiHarness {
  const handlers = new Map<string, TestHandler>();
  const emitted: { channel: string; data: EmittedPayload }[] = [];
  return {
    pi: {
      on(event, handler) {
        handlers.set(event, handler);
      },
      events: {
        emit(channel, data) {
          emitted.push({ channel, data });
        },
      },
    },
    handlers,
    emitted,
  };
}

function createRegisteredStubPi(trustedRoots: string[] = []): StubPiHarness {
  const harness = createStubPi();
  // SAFETY: The stub supplies the `on` registrations and `events.emit` used by this extension;
  // tests invoke each stored handler with host-shaped fixtures and the required context fields.
  registerAgentsMdAutoload(harness.pi as ExtensionAPI, {
    loadSettings: async () => ({ trustedRoots }),
  });
  return harness;
}

function readEvent(target: string) {
  return {
    type: "tool_result",
    toolCallId: "1",
    toolName: "read",
    input: { path: target },
    content: [{ type: "text", text: "file body" }],
    isError: false,
  };
}

function appendixText(result: TestHandlerResult | void): string | undefined {
  return result?.content?.find(
    (item) => item.type === "text" && item.text?.includes("<subdirectory_agents_context>"),
  )?.text;
}

function allAppendedText(result: TestHandlerResult | void): string {
  return (result?.content ?? [])
    .slice(1)
    .map((item) => item.text ?? "")
    .join("\n");
}

function realHostCodeModeEvent(target: string, cwd: string) {
  return {
    type: "tool_result",
    toolCallId: "1",
    toolName: "exec",
    input: {
      code: `const r = await tools.exec_command({cmd: ${JSON.stringify(`cat ${target}`)}, workdir: ${JSON.stringify(cwd)}}); text(r.output)`,
    },
    content: [{ type: "text", text: "Script completed" }],
    isError: false,
    details: {
      codeMode: true,
      cellId: "1",
      status: "result",
      traces: [
        {
          id: "cell:1:tool-1",
          name: "exec_command",
          input: { cmd: `cat ${target}`, workdir: cwd },
          status: "done",
          result: {
            content: [{ type: "text", text: `Command: cat ${target}\nOutput:\nfile body` }],
            details: { exit_code: 0 },
          },
        },
      ],
    },
  };
}

test("a file dropped by the total appendix cap remains eligible for a later call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choco-pi-agents-md-cap-"));
  try {
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/example-worktree\n");
    let directory = root;
    for (let level = 1; level <= 4; level += 1) {
      directory = path.join(directory, `level-${level}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(directory, "AGENTS.md"),
        `LEVEL-${level}\n${"x".repeat(MAX_FILE_CHARS)}`,
      );
    }
    const target = path.join(directory, "example.ts");
    fs.writeFileSync(target, "export {};\n");

    const pi = createRegisteredStubPi();
    const ctx = { cwd: root, hasUI: false, ui: { notify() {} } };
    pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const first = appendixText(await pi.handlers.get("tool_result")?.(readEvent(target), ctx));
    assert.ok(first);
    assert.doesNotMatch(first, /LEVEL-1/);

    const second = appendixText(await pi.handlers.get("tool_result")?.(readEvent(target), ctx));
    assert.ok(second, "expected the previously capped file to remain eligible");
    assert.match(second, /LEVEL-1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked session cwd excludes root guidance and uses cwd-relative labels", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "choco-pi-agents-md-symlink-"));
  try {
    const root = path.join(fixture, "root");
    const linkedRoot = path.join(fixture, "linked-root");
    const nested = path.join(root, "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/example-worktree\n");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT-GUIDANCE");
    fs.writeFileSync(path.join(nested, "AGENTS.md"), "NESTED-GUIDANCE");
    fs.symlinkSync(root, linkedRoot, "dir");

    const pi = createRegisteredStubPi();
    const ctx = { cwd: linkedRoot, hasUI: false, ui: { notify() {} } };
    pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const missingTarget = path.join(linkedRoot, "src", "not-created.ts");
    const appendix = appendixText(
      await pi.handlers.get("tool_result")?.(readEvent(missingTarget), ctx),
    );
    assert.ok(appendix);
    assert.doesNotMatch(appendix, /ROOT-GUIDANCE/);
    assert.match(appendix, /<agents_file path="src\/AGENTS\.md" source="project">/);
    assert.doesNotMatch(appendix, /linked-root/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("shell discovery detection checks command positions rather than arbitrary arguments", () => {
  for (const command of [
    "echo find me",
    "git log --oneline | head -5",
    "npm test -- --grep ls",
    "docker run --rm alpine cat /etc/hostname",
  ]) {
    assert.equal(isDiscoveryShellCommand(command), false, command);
  }
  for (const command of ["ls src", "cat foo.ts", "rg pattern dir"]) {
    assert.equal(isDiscoveryShellCommand(command), true, command);
  }
});

test("injects AGENTS.md for Pi code-mode exec_command traces", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choco-pi-agents-md-code-mode-"));
  try {
    // Match a git worktree, where .git is a file rather than a directory.
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/example-worktree\n");
    const packageDir = path.join(root, ".pi", "packages", "example");
    const target = path.join(packageDir, "src", "types.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "AGENTS.md"), "package-specific guidance");
    fs.writeFileSync(target, "export type Example = string;\n");

    const pi = createRegisteredStubPi();
    const ctx = { cwd: root, hasUI: false, ui: { notify() {} } };
    pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const appendix = appendixText(
      await pi.handlers.get("tool_result")?.(realHostCodeModeEvent(target, root), ctx),
    );

    assert.ok(appendix, "expected code-mode nested tool access to inject AGENTS.md context");
    assert.match(
      appendix,
      /<agents_file path="\.pi\/packages\/example\/AGENTS\.md" source="project">/,
    );
    assert.match(appendix, /package-specific guidance/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface ContainmentFixture {
  workspace: string;
  root: string;
  sibling: string;
  siblingTarget: string;
  projectTarget: string;
  linkedTarget: string;
}

async function createContainmentFixture(): Promise<ContainmentFixture> {
  const workspace = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "choco-pi-agents-md-containment-")),
  );
  const root = path.join(workspace, "root");
  const sibling = path.join(workspace, "sibling");
  await fs.promises.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.promises.mkdir(path.join(root, "src"));
  await fs.promises.mkdir(path.join(sibling, ".git"), { recursive: true });
  await fs.promises.mkdir(path.join(sibling, "lib"));
  await fs.promises.writeFile(path.join(root, "AGENTS.md"), "ROOT-GUIDANCE");
  await fs.promises.writeFile(path.join(root, "src", "AGENTS.md"), "PROJECT-NESTED-GUIDANCE");
  await fs.promises.writeFile(path.join(sibling, "AGENTS.md"), "SIBLING-GUIDANCE");
  const projectTarget = path.join(root, "src", "a.ts");
  const siblingTarget = path.join(sibling, "lib", "b.ts");
  await fs.promises.writeFile(projectTarget, "export {};\n");
  await fs.promises.writeFile(siblingTarget, "export {};\n");
  await fs.promises.symlink(sibling, path.join(root, "linked"), "dir");
  const linkedTarget = path.join(root, "linked", "lib", "b.ts");
  return { workspace, root, sibling, siblingTarget, projectTarget, linkedTarget };
}

async function removeFixture(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function startSession(harness: StubPiHarness, cwd: string): TestContext {
  const ctx = { cwd, hasUI: false, ui: { notify() {} } };
  harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  return ctx;
}

async function runRead(harness: StubPiHarness, target: string, ctx: TestContext) {
  return harness.handlers.get("tool_result")?.(readEvent(target), ctx);
}

test("AGENTS.md outside the session root is pointed to once and never inlined", async () => {
  const fixture = await createContainmentFixture();
  try {
    const harness = createRegisteredStubPi();
    const ctx = startSession(harness, fixture.root);
    const siblingAgents = path.join(fixture.sibling, "AGENTS.md");
    const pointer = `<foreign_agents_file path="${siblingAgents}" bytes="${"SIBLING-GUIDANCE".length}" note="outside the project root; read it as evidence if needed"/>`;

    const first = await runRead(harness, fixture.siblingTarget, ctx);
    const firstText = allAppendedText(first);
    assert.equal(appendixText(first), undefined);
    assert.doesNotMatch(firstText, /SIBLING-GUIDANCE/);
    assert.equal(firstText, pointer);

    const second = await runRead(harness, fixture.siblingTarget, ctx);
    assert.equal(second, undefined, "the pointer is rendered once per session");

    const project = appendixText(await runRead(harness, fixture.projectTarget, ctx));
    assert.ok(project);
    assert.match(project, /<agents_file path="src\/AGENTS\.md" source="project">/);
    assert.match(project, /PROJECT-NESTED-GUIDANCE/);
    assert.doesNotMatch(project, /ROOT-GUIDANCE|SIBLING-GUIDANCE|foreign_agents_file/);

    harness.handlers.get("session_shutdown")?.({ type: "session_start", reason: "startup" }, ctx);
    const stats = harness.emitted.flatMap((entry) =>
      entry.channel === SESSION_STATS_EVENT && "injectedChars" in entry.data ? [entry.data] : [],
    );
    assert.deepEqual(stats, [
      {
        cwd: fixture.root,
        injectedFiles: 1,
        injectedChars: pointer.length + project.length,
        foreignPointers: 1,
      },
    ]);
  } finally {
    await removeFixture(fixture.workspace);
  }
});

test("a symlink inside the session root that leaves it is classified by its real path", async () => {
  const fixture = await createContainmentFixture();
  try {
    const harness = createRegisteredStubPi();
    const ctx = startSession(harness, fixture.root);
    const result = await runRead(harness, fixture.linkedTarget, ctx);
    const text = allAppendedText(result);
    assert.equal(appendixText(result), undefined);
    assert.doesNotMatch(text, /SIBLING-GUIDANCE/);
    assert.match(
      text,
      new RegExp(`<foreign_agents_file path="${path.join(fixture.sibling, "AGENTS.md")}"`),
    );
  } finally {
    await removeFixture(fixture.workspace);
  }
});

test("a symlinked AGENTS.md inside the root that points to a sibling repo is never inlined", async () => {
  const fixture = await createContainmentFixture();
  try {
    const vendor = path.join(fixture.root, "vendor");
    await fs.promises.mkdir(vendor);
    await fs.promises.symlink(
      path.join(fixture.sibling, "AGENTS.md"),
      path.join(vendor, "AGENTS.md"),
    );
    const target = path.join(vendor, "c.ts");
    await fs.promises.writeFile(target, "export {};\n");

    const harness = createRegisteredStubPi();
    const ctx = startSession(harness, fixture.root);
    const result = await runRead(harness, target, ctx);
    const text = allAppendedText(result);
    const siblingAgents = path.join(fixture.sibling, "AGENTS.md");
    assert.equal(appendixText(result), undefined);
    assert.doesNotMatch(text, /SIBLING-GUIDANCE/);
    assert.equal(countMatches(text, /<foreign_agents_file /g), 1);
    assert.equal(
      text,
      `<foreign_agents_file path="${siblingAgents}" bytes="${"SIBLING-GUIDANCE".length}" note="outside the project root; read it as evidence if needed"/>`,
    );
    assert.equal(await runRead(harness, target, ctx), undefined);
  } finally {
    await removeFixture(fixture.workspace);
  }
});

test("a symlinked AGENTS.md pointing inside the root is inlined once by real path", async () => {
  const fixture = await createContainmentFixture();
  try {
    const docs = path.join(fixture.root, "docs");
    await fs.promises.mkdir(docs);
    await fs.promises.symlink(path.join("..", "src", "AGENTS.md"), path.join(docs, "AGENTS.md"));
    const docsTarget = path.join(docs, "x.ts");
    await fs.promises.writeFile(docsTarget, "export {};\n");

    const harness = createRegisteredStubPi();
    const ctx = startSession(harness, fixture.root);
    const findResult = await harness.handlers.get("tool_result")?.(
      {
        type: "tool_result",
        toolCallId: "1",
        toolName: "find",
        input: { path: fixture.root },
        content: [{ type: "text", text: "docs/x.ts\nsrc/a.ts" }],
        isError: false,
      },
      ctx,
    );
    const appendix = appendixText(findResult);
    assert.ok(appendix);
    assert.equal(countMatches(appendix, /PROJECT-NESTED-GUIDANCE/g), 1);
    assert.equal(countMatches(appendix, /<agents_file /g), 1);
    assert.match(appendix, /<agents_file path="docs\/AGENTS\.md" source="project">/);
    assert.doesNotMatch(allAppendedText(findResult), /foreign_agents_file/);

    assert.equal(await runRead(harness, fixture.projectTarget, ctx), undefined);
  } finally {
    await removeFixture(fixture.workspace);
  }
});

test("trustedRoots allows a sibling repository with trusted-root provenance", async () => {
  const fixture = await createContainmentFixture();
  try {
    const harness = createRegisteredStubPi([fixture.sibling]);
    const ctx = startSession(harness, fixture.root);
    const result = await runRead(harness, fixture.siblingTarget, ctx);
    const appendix = appendixText(result);
    assert.ok(appendix);
    assert.match(appendix, /<agents_file path="\.\.\/sibling\/AGENTS\.md" source="trusted-root">/);
    assert.match(appendix, /SIBLING-GUIDANCE/);
    assert.doesNotMatch(allAppendedText(result), /foreign_agents_file/);
  } finally {
    await removeFixture(fixture.workspace);
  }
});

test("agentsMd settings keep absolute and home-relative trusted roots only", async () => {
  const agentDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "choco-pi-agents-md-settings-"),
  );
  try {
    await fs.promises.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        other: 1,
        agentsMd: { trustedRoots: ["~/shared", "/abs/root", "relative"] },
      }),
    );
    assert.deepEqual(await readAgentsMdSettings(agentDir), {
      trustedRoots: [path.join(os.homedir(), "shared"), "/abs/root"],
    });
    await fs.promises.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ agentsMd: { trustedRoots: "/x" } }),
    );
    assert.deepEqual(await readAgentsMdSettings(agentDir), { trustedRoots: [] });
    await fs.promises.rm(path.join(agentDir, "settings.json"));
    assert.deepEqual(await readAgentsMdSettings(agentDir), { trustedRoots: [] });
  } finally {
    await removeFixture(agentDir);
  }
});
