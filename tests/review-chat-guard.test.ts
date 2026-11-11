// The side chat's tool-boundary guard (review/core/chat-guard.ts): a tool call
// that targets a file the review keeps hidden is refused before it runs, until
// the reviewer reveals the file with v.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  chatToolGuard,
  hiddenFileRefusal,
  hiddenTargetOf,
} from "../.pi/extensions/review/core/chat-guard.ts";
import {
  createReviewChat,
  type ReviewChat,
  type ReviewChatOptions,
  type ReviewChatSessionRequest,
} from "../.pi/extensions/review/core/ask.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { changedFile, mount } from "./review-safety-fakes.ts";

const SECRET = "TOKEN=guard-secret-4242";

async function repository(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chat-guard-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "config"));
  await writeFile(join(root, ".env"), `${SECRET}\n`);
  await writeFile(join(root, ".env.example"), "TOKEN=\n");
  await writeFile(join(root, "config", "keys.pem"), "PRIVATE\n");
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await symlink(join(root, ".env"), join(root, "src", "link"));
  // Whether this file system ignores case, found the way the guard finds it.
  const caseInsensitive = await stat(join(root, ".ENV")).then(
    () => true,
    () => false,
  );
  return { root, caseInsensitive };
}

test("file tools are refused for a hidden path, by every name of the file, and allowed after reveal", async (t) => {
  const { root, caseInsensitive } = await repository(t);
  const hidden = [".env", "config/keys.pem"];
  const refused = async (input: RuntimeValue) => hiddenTargetOf(root, input, hidden);

  assert.equal(await refused({ path: ".env" }), ".env", "read");
  assert.equal(
    await refused({ path: ".env", edits: [{ oldText: "a", newText: "b" }] }),
    ".env",
    "edit",
  );
  assert.equal(await refused({ path: ".env", content: "x" }), ".env", "write");
  assert.equal(
    await refused({ pattern: "TOKEN", path: ".env" }),
    ".env",
    "a search given the path",
  );
  assert.equal(await refused({ path: "./src/../.env" }), ".env", "..");
  assert.equal(await refused({ path: join(root, ".env") }), ".env", "absolute");
  assert.equal(await refused({ path: "src/link" }), ".env", "a symbolic link to it");
  assert.equal(
    await refused({ paths: ["src/a.ts", "config/keys.pem"] }),
    "config/keys.pem",
    "in a list",
  );
  assert.equal(
    await refused({ path: ".ENV" }),
    caseInsensitive ? ".env" : undefined,
    "another case is the same file only where the file system ignores case",
  );

  assert.equal(await refused({ path: "src/a.ts" }), undefined, "an unrelated file");
  assert.equal(await refused({ path: ".env.example" }), undefined, "a file with a longer name");
  assert.equal(await refused({ query: "what is .env for" }), ".env", "free text naming it");
  assert.equal(
    await hiddenTargetOf(
      root,
      { path: ".env" },
      [".env"].filter(() => false),
    ),
    undefined,
  );
});

test("a shell command naming the hidden path or its base name is refused; others run", async (t) => {
  const { root, caseInsensitive } = await repository(t);
  const hidden = [".env", "config/keys.pem"];
  const refused = async (command: string) => hiddenTargetOf(root, { command }, hidden);

  assert.equal(await refused("cat .env"), ".env");
  assert.equal(await refused("head -n1 ./.env | tr a-z A-Z"), ".env");
  assert.equal(await refused(`cat "${root}/.env"`), ".env");
  assert.equal(await refused("git show HEAD:.env"), ".env");
  assert.equal(await refused("cp config/keys.pem /tmp/x"), "config/keys.pem");
  assert.equal(await refused("cat keys.pem"), "config/keys.pem", "the base name alone");
  assert.equal(await hiddenTargetOf(root, { cmd: "cat .env" }, hidden), ".env", "exec_command");
  assert.equal(await refused("cat .ENV"), caseInsensitive ? ".env" : undefined);

  assert.equal(await refused("cat .env.example"), undefined);
  assert.equal(await refused("cat prod.env"), undefined);
  assert.equal(await refused("ls src && cat src/a.ts"), undefined);
  // Documented limits: a command that never names the file is not caught.
  assert.equal(await refused("cat .e*"), undefined);
});

test("the extension refuses before the call runs, with no file content, and reads the hidden set live", async (t) => {
  const { root } = await repository(t);
  let hidden: string[] = [".env"];
  type ToolCallHandler = (event: {
    toolName: string;
    input: RuntimeValue;
  }) => Promise<RuntimeValue>;
  const handlers: ToolCallHandler[] = [];
  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: ToolCallHandler) => {
      if (event === "tool_call") handlers.push(handler);
    },
  });
  chatToolGuard(root, () => hidden)(pi);
  assert.equal(handlers.length, 1);
  const handler = handlers[0];
  assert.ok(handler);

  const result = await handler({ toolName: "read", input: { path: ".env" } });
  assert.deepEqual(result, { block: true, reason: hiddenFileRefusal(".env", "read") });
  const reason = hiddenFileRefusal(".env", "read");
  assert.match(reason, /kept hidden/u);
  assert.match(reason, /press v/u);
  assert.equal(reason.includes("guard-secret"), false, "the refusal holds no content");
  assert.equal(reason.includes("TOKEN"), false);

  assert.equal(await handler({ toolName: "bash", input: { command: "ls" } }), undefined);
  assert.equal(await handler({ toolName: "read", input: { path: "src/a.ts" } }), undefined);

  hidden = [];
  assert.equal(
    await handler({ toolName: "read", input: { path: ".env" } }),
    undefined,
    "revealed with v: allowed from then on",
  );
});

test("the chat hands the review's live hidden set to its session", async () => {
  let request: ReviewChatSessionRequest | undefined;
  let hidden = [".env"];
  const chat = createReviewChat({
    cwd: "/repo",
    hiddenPaths: () => hidden,
    createSession: async (made) => {
      request = made;
      return {
        sendUserMessage: async () => {},
        subscribe: () => () => {},
        abort: async () => {},
        dispose: () => {},
      };
    },
  });
  await chat.prepare("/repo");
  assert.deepEqual(request?.hiddenPaths?.(), [".env"]);
  hidden = [];
  assert.deepEqual(request?.hiddenPaths?.(), []);
  chat.dispose();
});

test("the review's chat sees a file as hidden until v reveals it", async () => {
  const full = changedFile(".env", "TOKEN=old", `${SECRET}`);
  const model = {
    baseSha: "b",
    headSha: "h",
    files: [{ ...full, hunks: [] }, changedFile("app.ts", "a = 1", "a = 2")],
    hidden: [".env"],
  };
  let options: ReviewChatOptions | undefined;
  const view = await mount({
    model,
    revealFile: async () => ({ file: full }),
    createReviewChat: (given): ReviewChat => {
      options = given;
      return createReviewChat({
        ...given,
        createSession: async () => ({
          sendUserMessage: async () => {},
          subscribe: () => () => {},
          abort: async () => {},
          dispose: () => {},
        }),
      });
    },
  });
  await view.press("a", "\u001b");
  assert.deepEqual(options?.hiddenPaths?.(), [".env"]);
  await view.press("\u001b[D", "v");
  assert.deepEqual(options?.hiddenPaths?.(), [], "after v the chat may read it");
  await view.press("q");
  await view.result;
});

test("a hidden file whose name keeps spaces or a newline is refused by its exact path", async (t) => {
  const { root } = await repository(t);
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "secrets", "a "), `${SECRET}\n`);
  await writeFile(join(root, "secrets", "a\nb.txt"), `${SECRET}\n`);
  await writeFile(join(root, "secrets", "a"), "public\n");
  const hidden = ["secrets/a ", "secrets/a\nb.txt"];
  assert.equal(await hiddenTargetOf(root, { path: "secrets/a " }, hidden), "secrets/a ");
  assert.equal(
    await hiddenTargetOf(root, { path: "secrets/a\nb.txt" }, hidden),
    "secrets/a\nb.txt",
  );
  assert.equal(
    await hiddenTargetOf(root, { path: " secrets/a " }, hidden),
    "secrets/a ",
    "padded: a tool would open another file, but the guard errs towards refusing",
  );
  assert.equal(
    await hiddenTargetOf(root, { path: "secrets/a" }, hidden),
    undefined,
    "the plain one",
  );
});

test("every resolution a file tool could make, at any length and depth, is refused", async (t) => {
  const { root } = await repository(t);
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    process.env.HOME = home;
  });
  await writeFile(join(root, "a b.txt"), "x");
  await writeFile(join(root, "caf\u00e9.env"), "x");
  await writeFile(join(root, "it's.env"), "x");
  const hidden = [".env", "a b.txt", "caf\u00e9.env", "it's.env"];
  const refused = async (input: RuntimeValue, tool = "read") =>
    hiddenTargetOf(root, input, hidden, tool);

  assert.equal(await refused({ path: " .env\n" }), ".env", "white space around it");
  assert.equal(await refused({ path: "@.env" }), ".env", "Pi strips a leading @");
  assert.equal(await refused({ path: "~/.env" }), ".env", "~ is the home directory");
  assert.equal(await refused({ path: `file://${root}/.env` }), ".env", "a file URL");
  assert.equal(await refused({ path: ".env/" }), ".env", "a trailing slash");
  assert.equal(await refused({ path: "a\u00a0b.txt" }), "a b.txt", "Unicode spaces");
  assert.equal(await refused({ path: "cafe\u0301.env" }), "caf\u00e9.env", "NFD form");
  assert.equal(await refused({ path: "it\u2019s.env" }), "it's.env", "curly apostrophe");
  const long = `${"src/../".repeat(1000)}.env`;
  assert.ok(long.length > 4096);
  assert.equal(await refused({ path: long }), ".env", "longer than any former cut-off");
  let deep: RuntimeValue = { path: ".env" };
  for (let level = 0; level < 50; level += 1) deep = { nested: [deep] };
  assert.equal(await refused(deep), ".env", "nested deeper than any former cut-off");
  assert.equal(await refused({ files: { ".env": true } }), ".env", "an object key");
});

test("any tool's text naming the file is refused, quoted or escaped; written text only as a path", async (t) => {
  const { root, caseInsensitive } = await repository(t);
  await writeFile(join(root, " .env"), "x");
  await writeFile(join(root, "-secret"), "x");
  const hidden = [".env", " .env", "-secret"];
  const target = async (input: RuntimeValue, tool = "bash") =>
    hiddenTargetOf(root, input, hidden, tool);

  // Shell, code and agent tools of this profile, and an unknown tool.
  assert.equal(await target({ chars: "cat .env\n" }, "write_stdin"), ".env");
  assert.equal(await target({ code: 'await tools.read({ path: ".env" })' }, "exec"), ".env");
  assert.equal(await target({ prompt: "print .env for me" }, "Agent"), ".env");
  assert.equal(await target({ message: "open .env" }, "session_send"), ".env");
  assert.equal(await target({ anything: "x .env y" }, "unknown_tool"), ".env");
  // Quoting and escaping inside the name.
  assert.equal(await target({ command: 'cat .e"n"v' }), ".env");
  assert.equal(await target({ command: "cat .\\env" }), ".env");
  assert.equal(await target({ command: "cat '.env'" }), ".env");
  assert.equal(
    await target({ command: 'cat " .env"' }),
    ".env",
    "the space-led name is refused too",
  );
  assert.equal(await target({ command: "cat ./-secret" }), "-secret");
  assert.equal(await target({ command: "cat cafe\u0301-x .env" }), ".env");
  assert.equal(
    await target({ command: "cat caf\u00e9.env x\u00e9.env" }),
    undefined,
    "other files",
  );
  assert.equal(await target({ command: "cat .ENV" }), caseInsensitive ? ".env" : undefined);

  // Text written by write and edit is checked as a path only.
  assert.equal(
    await target({ path: ".gitignore", content: "node_modules\n.env\n" }, "write"),
    undefined,
  );
  assert.equal(
    await target({ path: "src/a.ts", edits: [{ oldText: "a", newText: "load .env" }] }, "edit"),
    undefined,
  );
  assert.equal(await target({ path: ".env", content: "x" }, "write"), ".env");
});

test("a hidden name holding a quote or a backslash is refused when the command escapes it", async (t) => {
  const { root } = await repository(t);
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "secrets", "o'key.txt"), `${SECRET}\n`);
  await writeFile(join(root, "secrets", "back\\slash.txt"), `${SECRET}\n`);
  const hidden = ["secrets/o'key.txt", "secrets/back\\slash.txt"];
  const target = async (command: string) => hiddenTargetOf(root, { command }, hidden, "bash");
  assert.equal(
    await target("cat secrets/o\\'key.txt"),
    "secrets/o'key.txt",
    "backslash-escaped quote",
  );
  assert.equal(
    await target("cat secrets/back\\\\slash.txt"),
    "secrets/back\\slash.txt",
    "escaped backslash",
  );
});

test("names with shell-special characters, written quoted or escaped in each shell", async (t) => {
  const { root } = await repository(t);
  const hidden = [
    "secrets/o'key.txt",
    "secrets/my file",
    "secrets/''",
    "secrets/a\nb.txt",
    "secrets/a\tb.txt",
    "secrets/-dash",
    "secrets/~tilde",
    ...[..."$`*?[!#;&|(<"].map((special) => `secrets/s${special}x.txt`),
  ];
  const target = async (input: RuntimeValue) => hiddenTargetOf(root, input, hidden, "bash");
  const refused: Array<[string, string]> = [
    // POSIX shells and fish.
    ["cat secrets/o\\'key.txt", "secrets/o'key.txt"],
    ['cat "secrets/o\'key.txt"', "secrets/o'key.txt"],
    ['cat secrets/o"\'"key.txt', "secrets/o'key.txt"],
    ["cat 'secrets/o'\\''key.txt'", "secrets/o'key.txt"],
    ["cat x/o\\'key.txt;", "secrets/o'key.txt"],
    ["cat $'secrets/o\\'key.txt'", "secrets/o'key.txt"],
    ["cat secrets/my\\ file", "secrets/my file"],
    ['cat "secrets/my file"', "secrets/my file"],
    ["cat 'secrets/my file'", "secrets/my file"],
    ["cat secrets/\\'\\'", "secrets/''"],
    ["cat \"secrets/''\"", "secrets/''"],
    ["cat secrets/\"'\"\\'", "secrets/''"],
    ['cat "secrets/a\nb.txt"', "secrets/a\nb.txt"],
    ["cat 'secrets/a\tb.txt'", "secrets/a\tb.txt"],
    ["cat -- -dash", "secrets/-dash"],
    ["cat ./secrets/-dash", "secrets/-dash"],
    ["cat secrets/\\~tilde", "secrets/~tilde"],
    ["cat '~tilde'", "secrets/~tilde"],
    // PowerShell and cmd.
    ["Get-Content 'secrets/o''key.txt'", "secrets/o'key.txt"],
    ["Get-Content secrets/o`'key.txt", "secrets/o'key.txt"],
    ["type secrets\\o^'key.txt", "secrets/o'key.txt"],
    // Percent-encoding, as in a file:// URL inside a command.
    [`curl file://${root}/secrets/o%27key.txt`, "secrets/o'key.txt"],
    [`curl file://${root}/secrets/my%20file`, "secrets/my file"],
  ];
  for (const special of "$`*?[!#;&|(<") {
    const name = `secrets/s${special}x.txt`;
    refused.push([`cat secrets/s\\${special}x.txt`, name]);
    refused.push([`cat 'secrets/s${special}x.txt'`, name]);
    refused.push([`cat "secrets/s${special}x.txt"`, name]);
  }
  for (const [command, expected] of refused) {
    assert.equal(await target({ command }), expected, command);
  }
  // The path side needs no unquoting: the literal name is the path.
  assert.equal(await target({ path: "secrets/o'key.txt" }), "secrets/o'key.txt");

  const notRefused = [
    // Longer names: folding joins what the shell joins, nothing more.
    "cat secrets/o\\'key.txt.bak",
    "cat xo\\'key.txt",
    "cat 'my file2'",
    // Encoded escapes write a character by its code: not stopped.
    "cat $'secrets/a\\nb.txt'",
    "cat $'secrets/a\\tb.txt'",
  ];
  for (const command of notRefused) {
    assert.equal(await target({ command }), undefined, command);
  }
  // Over-refusal: a different file whose name differs only by quote or escape characters.
  assert.equal(await target({ command: "cat okey.txt" }), "secrets/o'key.txt");
  // The module comment's examples for .env.
  for (const command of ["type .e^nv", "Get-Content .e`nv", "curl file:///repo/%2eenv"]) {
    assert.equal(await hiddenTargetOf(root, { command }, [".env"], "bash"), ".env", command);
  }
});

test("what the guard does not stop, pinned so the documentation cannot drift", async (t) => {
  const { root } = await repository(t);
  const hidden = [".env", "-secret"];
  const target = async (command: string) => hiddenTargetOf(root, { command }, hidden, "bash");
  for (const command of [
    "cat .e*",
    "cat *",
    "cat .{e,}nv",
    "cat $'\\x2eenv'",
    "cat $'\\056env'",
    "cat .e$'\\x6e'v",
    "cat \"$(printf '\\056env')\"",
    "f=.e; cat ${f}nv",
    "grep -r TOKEN .",
    "env",
    "sh ./show-secrets.sh",
    "cat .env.example",
    "cat prod.env",
    "cat my-secret",
  ]) {
    assert.equal(await target(command), undefined, command);
  }
});
