// /diff outside the terminal UI, when the editor (Zed through the choco-pi ACP adapter) renders
// notifications as Markdown: the inline list and the messages carrying untrusted text.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { DefaultBaseChoice } from "../.pi/extensions/lib/changes/git/default-base.ts";
import type {
  DiffSnapshot,
  DiffStore,
  DiffStoreState,
  FileSummary,
} from "../.pi/extensions/lib/changes/git/model.ts";
import { registerDiffPane } from "../.pi/extensions/diff/ui/controller.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";

const EDITOR = { CHOCO_PI_ACP_NATIVE_DIFF: "1" };
const ESC = "\u001b";
const RLO = "\u202e";

function file(path: string, extra: Partial<FileSummary> = {}): FileSummary {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
    ...extra,
  };
}

/** A branch-base snapshot whose base, branch and file names are all hostile. */
function hostileState(): DiffStoreState {
  const files = [
    file("[a](http://evil).md"),
    file("# heading.ts", { status: "added", additions: 2 }),
    file("tick`x``y.ts"),
    file(`esc${ESC}[31mred.ts`),
    file(`rlo${RLO}txt.exe`, { status: "renamed", oldPath: "<b>old</b>.ts" }),
  ];
  const snapshot: DiffSnapshot = {
    revision: 1,
    source: { kind: "branch-base", base: "ma`in#[x](y)" },
    repoRoot: "/repo",
    head: "abc",
    branch: `fe${ESC}]52;c;QUJD\u0007at`,
    base: "abc",
    capturedAt: 0,
    files,
    totals: { files: files.length, additions: 6, deletions: 0 },
    omittedFiles: 0,
  };
  return { kind: "ready", snapshot, refreshing: false };
}

class StateStore implements DiffStore {
  state: DiffStoreState = { kind: "idle" };
  private readonly next: DiffStoreState;
  constructor(next: DiffStoreState) {
    this.next = next;
  }
  getState(): DiffStoreState {
    return this.state;
  }
  subscribe(): () => void {
    return () => {};
  }
  requestRefresh(): void {}
  async refreshNow(): Promise<void> {
    this.state = this.next;
  }
  async loadFile(): Promise<never> {
    throw new Error("not used");
  }
  setSource(): void {}
  setVisible(): void {}
  dispose(): void {}
}

async function run(
  args: string,
  options: {
    env: Record<string, string>;
    state?: DiffStoreState;
    defaultBranchBase?: (cwd: string) => Promise<DefaultBaseChoice>;
  },
): Promise<string[]> {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const fakePi = {
    on: () => {},
    events: { on: () => () => {}, emit: () => {} },
    registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      commands.set(name, command);
    },
    registerShortcut: () => {},
  };
  const notices: string[] = [];
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    mode: "rpc",
    hasUI: true,
    cwd: "/repo",
    ui: { notify: (message: string) => notices.push(message) },
  });
  registerDiffPane(reinterpretHostValue<ExtensionAPI>(fakePi), {
    createStore: () => new StateStore(options.state ?? hostileState()),
    clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} },
    prefsIo: { read: async () => undefined, write: async () => {} },
    agentDir: () => "/agent",
    probe: () => undefined,
    styler: () => plainPaneStyler,
    env: options.env,
    defaultBranchBase: options.defaultBranchBase ?? (async () => ({ kind: "found", base: "main" })),
  });
  const command = commands.get("diff");
  assert.ok(command);
  await command.handler(args, ctx);
  return notices;
}

/** C0 other than newline and tab, DEL, C1, and bidirectional controls. */
function hasUnsafe(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

const BLOCK_START = /^(?: {4}|\s{0,3}(?:[#>|<]|\d+[.)]\s|`{3}))/u;

test("in the editor, /diff source branch lists hostile names as code spans and escapes the rest", async () => {
  const [list, ...rest] = await run("source branch main", { env: EDITOR });
  assert.equal(rest.length, 0);
  assert.equal(
    list,
    [
      "Changes since `` ma`in#[x](y) `` on ` fe\u241b]52;c;QUJD\u2407at `: 5 files \\+6 \\-0",
      "",
      "- M ` [a](http://evil).md ` \\+1 \\-0",
      "- A ` # heading.ts ` \\+2 \\-0",
      "- M ``` tick`x``y.ts ``` \\+1 \\-0",
      "- M ` esc\u241b[31mred.ts ` \\+1 \\-0",
      "- R ` <b>old</b>.ts ` → ` rlo\uFFFDtxt.exe ` \\+1 \\-0",
    ].join("\n"),
  );
  assert.equal(hasUnsafe(list ?? ""), false);
  for (const line of (list ?? "").split("\n")) assert.doesNotMatch(line, BLOCK_START, line);
});

test("without the editor marker the inline list stays plain text with control characters made visible", async () => {
  const envs: Array<Record<string, string>> = [{}, { CHOCO_PI_ACP_NATIVE_DIFF: "0" }];
  for (const env of envs) {
    const [list] = await run("source branch main", { env });
    assert.equal(
      list,
      [
        "Changes since ma`in#[x](y) on fe\u241b]52;c;QUJD\u2407at: 5 files +6 -0",
        "M [a](http://evil).md  +1 -0",
        "A # heading.ts  +2 -0",
        "M tick`x``y.ts  +1 -0",
        "M esc\u241b[31mred.ts  +1 -0",
        "R <b>old</b>.ts → rlo\uFFFDtxt.exe  +1 -0",
      ].join("\n"),
    );
  }
});

test("in the editor, an empty branch source names its base as a code span", async () => {
  const state = hostileState();
  assert.ok(state.kind === "ready");
  const empty: DiffStoreState = {
    ...state,
    snapshot: { ...state.snapshot, files: [], totals: { files: 0, additions: 0, deletions: 0 } },
  };
  const [list] = await run("source branch main", { env: EDITOR, state: empty });
  assert.equal(list?.split("\n\n")[1], "No changes against `` ma`in#[x](y) ``");
});

test("in the editor, usage text and default-base failures cannot form Markdown", async () => {
  const [usage] = await run("width wide", { env: EDITOR });
  assert.equal(usage, "Usage\\: \\/diff width \\<columns\\>");
  const [plainUsage] = await run("width wide", { env: {} });
  assert.equal(plainUsage, "Usage: /diff width <columns>");

  const hostile = `fatal: bad ${ESC}[31m# ref\n[a](http://b) ` + "```" + RLO;
  const throwing = async (): Promise<DefaultBaseChoice> => {
    throw new Error(hostile);
  };
  const [failure] = await run("source branch", { env: EDITOR, defaultBranchBase: throwing });
  assert.equal(
    failure,
    [
      "Cannot find the default base branch:",
      "",
      "````text",
      "fatal: bad \u241b[31m# ref",
      "[a](http://b) ```\uFFFD",
      "````",
    ].join("\n"),
  );
  const [plainFailure] = await run("source branch", { env: {}, defaultBranchBase: throwing });
  assert.equal(
    plainFailure,
    "Cannot find the default base branch: fatal: bad \u241b[31m# ref\u240a[a](http://b) ```\uFFFD",
    "a plain terminal gets git's text with its control bytes made visible",
  );

  const none = async (): Promise<DefaultBaseChoice> => ({
    kind: "none",
    message: "No base: name one, /diff source branch <base>.",
  });
  const [noBase] = await run("source branch", { env: EDITOR, defaultBranchBase: none });
  assert.equal(noBase, "No base\\: name one\\, \\/diff source branch \\<base\\>\\.");
});
