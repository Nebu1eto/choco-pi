import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_FILE_CHARS } from "../src/appendix.ts";
import { isDiscoveryShellCommand } from "../src/shell-targets.ts";
import { registerAgentsMdAutoload } from "../src/subdir.ts";

function createStubPi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  return {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, handler);
    },
    handlers,
  };
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

function appendixText(result: unknown): string | undefined {
  return (result as { content?: { type: string; text?: string }[] } | undefined)?.content?.find(
    (item) => item.type === "text" && item.text?.includes("<subdirectory_agents_context>"),
  )?.text;
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

    const pi = createStubPi();
    registerAgentsMdAutoload(pi as never);
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

    const pi = createStubPi();
    registerAgentsMdAutoload(pi as never);
    const ctx = { cwd: linkedRoot, hasUI: false, ui: { notify() {} } };
    pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const missingTarget = path.join(linkedRoot, "src", "not-created.ts");
    const appendix = appendixText(
      await pi.handlers.get("tool_result")?.(readEvent(missingTarget), ctx),
    );
    assert.ok(appendix);
    assert.doesNotMatch(appendix, /ROOT-GUIDANCE/);
    assert.match(appendix, /<agents_file path="src\/AGENTS\.md">/);
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

    const pi = createStubPi();
    registerAgentsMdAutoload(pi as never);
    const ctx = { cwd: root, hasUI: false, ui: { notify() {} } };
    pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const result = (await pi.handlers.get("tool_result")?.(
      realHostCodeModeEvent(target, root),
      ctx,
    )) as { content: { type: string; text?: string }[] } | undefined;
    const appendix = result?.content.find(
      (item) => item.type === "text" && item.text?.includes("<subdirectory_agents_context>"),
    );

    assert.ok(appendix?.text, "expected code-mode nested tool access to inject AGENTS.md context");
    assert.match(appendix.text, /<agents_file path="\.pi\/packages\/example\/AGENTS\.md">/);
    assert.match(appendix.text, /package-specific guidance/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
