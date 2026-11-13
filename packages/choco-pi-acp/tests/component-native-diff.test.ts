import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  NATIVE_DIFF_ENV,
  NATIVE_DIFF_MAX_FILES,
  NATIVE_DIFF_MAX_TEXT_BYTES,
  NATIVE_DIFF_NOTIFY_PREFIX,
} from "../src/acp/native-diff.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import { PiRpcProcess } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from "./helpers-fakes.ts";

const SECRET = "TOP-SECRET-CONTENT-7f3a";

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

type FileEntry = {
  path: string;
  displayPath: string;
  oldText: string | null;
  newText: string;
  status?: string;
  oldPath?: string;
};

function payload(
  files: FileEntry[],
  skipped: Array<{ path: string; reason: string }> = [],
): string {
  return `${NATIVE_DIFF_NOTIFY_PREFIX}${JSON.stringify({
    title: "/diff: uncommitted changes on main (2 files, +1 -1)",
    // The extension always sends the change kind; the adapter withholds old text without it.
    files: files.map((file) => ({
      ...file,
      status: file.status ?? (file.oldText === null ? "added" : "modified"),
    })),
    skipped,
    omitted: 0,
  })}`;
}

type Fixture = { proc: FakePiRpcProcess; conn: FakeAgentSideConnection };

function setup(): Fixture {
  const proc = new FakePiRpcProcess();
  const conn = new FakeAgentSideConnection();
  new PiAcpSession({
    sessionId: `native-diff-${randomUUID()}`,
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
  });
  return { proc, conn };
}

function notify(proc: FakePiRpcProcess, message: string): string {
  const id = `ui-${randomUUID()}`;
  proc.emit({ type: "extension_ui_request", id, method: "notify", message, notifyType: "info" });
  return id;
}

type ToolCallUpdate = Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }>;

function toolCalls(conn: FakeAgentSideConnection): ToolCallUpdate[] {
  const calls: ToolCallUpdate[] = [];
  for (const notification of conn.updates) {
    if (notification.update.sessionUpdate === "tool_call") calls.push(notification.update);
  }
  return calls;
}

function summaryText(call: ToolCallUpdate): string {
  const first = call.content?.[0];
  return first?.type === "content" && first.content.type === "text" ? first.content.text : "";
}

test("a /diff notification becomes one completed, display-only tool call with native diffs", async () => {
  const { proc, conn } = setup();
  const id = notify(
    proc,
    payload(
      [
        // Ordinary code mentions words the credential-prompt guard looks for.
        {
          path: "/repo/a.txt",
          displayPath: "a.txt",
          oldText: "one\n",
          newText: "const token = login(password);\n",
        },
        { path: "/repo/new.txt", displayPath: "new.txt", oldText: null, newText: "fresh\n" },
      ],
      [{ path: "logo.png", reason: "binary file" }],
    ),
  );
  await drain();

  const calls = toolCalls(conn);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.status, "completed");
  assert.equal(call.kind, "read");
  assert.match(call.toolCallId, /^choco-pi-diff-/u);
  // Zed draws a diff block without its file name: a name line precedes each block.
  assert.deepEqual(call.content?.slice(1), [
    { type: "content", content: { type: "text", text: "File 1 of 2: ` a.txt ` — modified" } },
    {
      type: "diff",
      path: "/repo/a.txt",
      oldText: "one\n",
      newText: "const token = login(password);\n",
    },
    { type: "content", content: { type: "text", text: "File 2 of 2: ` new.txt ` — added" } },
    { type: "diff", path: "/repo/new.txt", oldText: null, newText: "fresh\n" },
  ]);
  assert.deepEqual(call.locations, [{ path: "/repo/a.txt" }, { path: "/repo/new.txt" }]);
  const text = summaryText(call);
  assert.match(text, /^1\. ` a\.txt ` — modified\n2\. ` new\.txt ` — added$/mu);
  assert.match(text, /^- ` logo\.png `: binary file$/mu);
  assert.match(text, /not sent to the model/u);
  assert.equal(
    conn.updates.filter((n) => n.update.sessionUpdate === "agent_message_chunk").length,
    0,
    "the raw payload never reaches the transcript as text",
  );
  assert.deepEqual(proc.extensionUiResponses, [{ id, cancelled: true }]);
});

test("the adapter re-enforces the caps and the sensitive-file rule on any payload", async () => {
  const { proc, conn } = setup();
  const many: FileEntry[] = Array.from({ length: NATIVE_DIFF_MAX_FILES + 3 }, (_, index) => ({
    path: `/repo/f${index}.txt`,
    displayPath: `f${index}.txt`,
    oldText: "a",
    newText: "b",
  }));
  const huge = "x".repeat(NATIVE_DIFF_MAX_TEXT_BYTES);
  notify(
    proc,
    payload([
      { path: "/repo/.env", displayPath: ".env", oldText: null, newText: SECRET },
      { path: "/repo/keys/id_rsa", displayPath: "keys/id_rsa", oldText: SECRET, newText: SECRET },
      { path: "/repo/big.txt", displayPath: "big.txt", oldText: huge, newText: "y" },
      ...many,
    ]),
  );
  await drain();

  const call = toolCalls(conn)[0]!;
  const diffs = (call.content ?? []).filter((item) => item.type === "diff");
  assert.equal(diffs.length, NATIVE_DIFF_MAX_FILES);
  const total = diffs.reduce(
    (sum, item) =>
      item.type === "diff"
        ? sum + Buffer.byteLength(item.oldText ?? "") + Buffer.byteLength(item.newText)
        : sum,
    0,
  );
  assert.ok(total <= NATIVE_DIFF_MAX_TEXT_BYTES);
  const text = summaryText(call);
  assert.match(text, /` \.env `: sensitive file\\; contents not sent/u);
  assert.match(text, /` keys\/id_rsa `: sensitive file\\; contents not sent/u);
  assert.match(text, /` big\.txt `: too large for the remaining text budget/u);
  assert.match(text, /` f30\.txt `: over the 30\\-file limit/u);
  assert.ok(!JSON.stringify(conn.updates).includes(SECRET), "no sensitive contents are sent");
});

/** A payload whose file entries are not checked here, so malformed ones can be sent. */
function rawPayload(
  files: readonly object[],
  title = "/diff: t",
  skipped: readonly object[] = [],
): string {
  return `${NATIVE_DIFF_NOTIFY_PREFIX}${JSON.stringify({ title, files, skipped, omitted: 0 })}`;
}

function textItems(call: ToolCallUpdate): string[] {
  const texts: string[] = [];
  for (const item of call.content ?? []) {
    if (item.type === "content" && item.content.type === "text") texts.push(item.content.text);
  }
  return texts;
}

/** C0 other than newline, DEL, C1, and bidirectional controls. */
function hasUnsafe(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x061c || code === 0x200e || code === 0x200f) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

test("file names are listed in diff order with status and counts, sanitised and inert as Markdown", async () => {
  const nasty = "a\u001b[31m`b``\u0007\r\n# x [a](http://b)\u009b2J\u202e.txt";
  const osc = "\u001b]52;c;QUJD\u0007osc.txt";
  const files = [
    {
      path: `/repo/${nasty}`,
      displayPath: nasty,
      oldText: null,
      newText: "n\n",
      status: "added",
      additions: 1,
      deletions: 0,
    },
    {
      path: `/repo/${osc}`,
      displayPath: osc,
      oldText: "o\n",
      newText: "p\n",
      status: "modified",
      additions: 2,
      deletions: 1,
    },
    {
      path: "/repo/# heading.md",
      displayPath: "# heading.md",
      oldText: "q\n",
      newText: "r\n",
      status: "modified",
    },
    {
      path: "/repo/[a](http://b)",
      displayPath: "[a](http://b)",
      oldText: "s\n",
      newText: "t\n",
      status: "modified",
    },
  ];
  const { proc, conn } = setup();
  notify(
    proc,
    rawPayload(files, "/diff: x # [t](http://z) `q`", [
      { path: "``skip`` [x](http://y)", reason: "binary *file* <b>" },
    ]),
  );
  await drain();

  const call = toolCalls(conn)[0]!;
  const lines = summaryText(call).split("\n");
  const fence = "```";
  const names = [
    `${fence} a\u241b[31m\`b\`\`\u2407\u240d\u240a# x [a](http://b)\uFFFD2J\uFFFD.txt ${fence} — added, +1 -0`,
    "` \u241b]52;c;QUJD\u2407osc.txt ` — modified, +2 -1",
    "` # heading.md ` — modified",
    "` [a](http://b) ` — modified",
  ];
  assert.equal(lines[0], "\\/diff\\: x \\# \\[t\\]\\(http\\:\\/\\/z\\) \\`q\\`");
  assert.deepEqual(
    lines.filter((line) => /^\d+\. /u.test(line)),
    names.map((name, index) => `${index + 1}. ${name}`),
  );
  assert.ok(
    lines.includes(`- ${fence} \`\`skip\`\` [x](http://y) ${fence}: binary \\*file\\* \\<b\\>`),
  );
  // The name line before each diff block says the same.
  assert.deepEqual(
    textItems(call).slice(1),
    names.map((name, index) => `File ${index + 1} of 4: ${name}`),
  );
  for (const text of textItems(call)) {
    assert.equal(hasUnsafe(text), false, JSON.stringify(text));
    for (const line of text.split("\n")) {
      assert.doesNotMatch(line, /^(?: {4}|\s{0,3}[#>|<])/u, line);
    }
  }
  const diffs = (call.content ?? []).filter((item) => item.type === "diff");
  assert.equal(diffs.length, 4);
});

test("status and line counts are optional but strictly typed", async () => {
  const base = { path: "/repo/a.txt", displayPath: "a.txt", oldText: "a", newText: "b" };
  for (const bad of [
    { status: "bogus" },
    { status: 3 },
    { additions: -1 },
    { additions: 1.5 },
    { additions: "3" },
    { deletions: {} },
  ]) {
    const { proc, conn } = setup();
    notify(proc, rawPayload([{ ...base, ...bad }]));
    await drain();
    assert.equal(toolCalls(conn).length, 0, JSON.stringify(bad));
    assert.match(JSON.stringify(conn.updates), /\/diff presentation from Pi was malformed/u);
  }
  const { proc, conn } = setup();
  notify(proc, rawPayload([{ ...base, status: "modified", additions: null, deletions: null }]));
  await drain();
  assert.match(summaryText(toolCalls(conn)[0]!), /^1\. ` a\.txt ` — modified$/mu);
});

type Outcome = { shown: string[]; skipped: string[]; leaked: boolean; malformed: boolean };

/** Send one payload of raw file entries and report what the adapter did with them. */
async function outcome(files: readonly object[]): Promise<Outcome> {
  const { proc, conn } = setup();
  notify(proc, rawPayload(files));
  await drain();
  const all = JSON.stringify(conn.updates);
  const call = toolCalls(conn)[0];
  const lines = call ? summaryText(call).split("\n") : [];
  return {
    shown: lines.filter((line) => /^\d+\. /u.test(line)),
    skipped: lines.filter((line) => line.startsWith("- ")),
    leaked: all.includes(SECRET),
    malformed: /\/diff presentation from Pi was malformed/u.test(all),
  };
}

const secretOld = { oldText: `TOKEN=${SECRET}\n`, newText: "TOKEN=x\n" };

test("a rename or copy is judged on both validated paths, never on the display label", async () => {
  for (const status of ["renamed", "copied"]) {
    const sensitiveSource = await outcome([
      {
        path: "/repo/public.txt",
        oldPath: "/repo/.env",
        displayPath: "public.txt",
        status,
        ...secretOld,
      },
    ]);
    assert.equal(sensitiveSource.leaked, false, status);
    assert.deepEqual(sensitiveSource.skipped, [
      "- ` .env -> public.txt `: sensitive file\\; contents not sent",
    ]);
    const secretDirectory = await outcome([
      {
        path: "/repo/b.txt",
        oldPath: "/repo/secrets/a.txt",
        displayPath: "b.txt",
        status,
        ...secretOld,
      },
    ]);
    assert.equal(secretDirectory.leaked, false, status);
  }
  // A label claiming an innocent name does not hide a sensitive path, and is not shown as its name.
  const lying = await outcome([
    { path: "/repo/keys/id_rsa", displayPath: "notes.txt", status: "modified", ...secretOld },
  ]);
  assert.equal(lying.leaked, false);
  assert.deepEqual(lying.skipped, ["- ` /repo/keys/id_rsa `: sensitive file\\; contents not sent"]);
  // An ordinary rename is shown with the adapter's own label.
  const plain = await outcome([
    {
      path: "/repo/src/new.ts",
      oldPath: "/repo/src/old.ts",
      displayPath: "src/new.ts",
      status: "renamed",
      oldText: "a\n",
      newText: "b\n",
    },
  ]);
  assert.deepEqual(plain.shown, ["1. ` src/old.ts ` → ` src/new.ts ` — renamed"]);
});

test("contents are withheld unless both sides are known", async () => {
  // An older extension: a rename without its previous path.
  const unknownSource = await outcome([
    {
      path: "/repo/public.txt",
      displayPath: ".env -> public.txt",
      status: "renamed",
      ...secretOld,
    },
  ]);
  assert.equal(unknownSource.leaked, false);
  assert.deepEqual(unknownSource.skipped, [
    "- ` /repo/public.txt `: previous path unknown\\; contents not sent",
  ]);
  // No change kind at all: old text may be another file's.
  const noKind = await outcome([{ path: "/repo/a.txt", displayPath: "a.txt", ...secretOld }]);
  assert.equal(noKind.leaked, false);
  assert.deepEqual(noKind.skipped, ["- ` a.txt `: change kind unknown\\; contents not sent"]);
  // No change kind and no old text: only the file itself is shown.
  const newOnly = await outcome([
    { path: "/repo/n.txt", displayPath: "n.txt", oldText: null, newText: "n\n" },
  ]);
  assert.deepEqual(newOnly.shown, ["1. ` n.txt `"]);
});

test("a previous path is optional but strictly validated", async () => {
  const base = { path: "/repo/b.txt", displayPath: "b.txt", oldText: "a", newText: "b" };
  for (const bad of [
    { status: "renamed", oldPath: "a.txt" },
    { status: "renamed", oldPath: 3 },
    { status: "modified", oldPath: "/repo/a.txt" },
    { oldPath: "/repo/a.txt" },
  ]) {
    const result = await outcome([{ ...base, ...bad }]);
    assert.equal(result.malformed, true, JSON.stringify(bad));
    assert.deepEqual(result.shown, []);
  }
});

test("an ordinary notification is still a text chunk", async () => {
  const { proc, conn } = setup();
  notify(proc, "Uncommitted changes on main: 1 file");
  await drain();
  assert.equal(toolCalls(conn).length, 0);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "agent_message_chunk");
});

test("the Pi child is started with the native diff marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-acp-native-diff-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let proc: PiRpcProcess | undefined;
  try {
    const piCommand = join(root, "fake-pi");
    const envPath = join(root, "env.txt");
    await writeFile(
      piCommand,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(envPath)}, String(process.env[${JSON.stringify(NATIVE_DIFF_ENV)}]));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} }) + "\\n");
});
`,
      { mode: 0o755 },
    );
    await chmod(piCommand, 0o755);
    proc = await PiRpcProcess.spawn({ cwd: root, piCommand });
    await proc.getState();
    assert.equal(await readFile(envPath, "utf8"), "1");
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
