// Work the review interface starts without awaiting it (refreshes, findings
// reads, chat commands and questions, key actions) never rejects unhandled,
// even when the host cannot show a notice. While the review is open every
// message is on its message line; errors also go to Pi's notifications, and a
// host that cannot take them (stale or broken) changes nothing else.
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import type {
  ReviewChat,
  ReviewChatContext,
  ReviewChatMessage,
} from "../.pi/extensions/review/core/ask.ts";
import type { DiffAssessment } from "../.pi/extensions/review/core/heuristics.ts";
import type {
  DiffFile,
  DiffModel,
  ResolvedReviewConfig,
  ReviewRecord,
} from "../.pi/extensions/review/core/types.ts";
import {
  openReviewView,
  type OpenReviewViewOptions,
  type ReviewViewHost,
} from "../.pi/extensions/review/ui/review-view.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { unavailableZentuiLoader } from "./zentui-build.ts";

initTheme("dark", false);
const NOW = "2026-03-03T02:00:00.000Z";
const STALE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.";

const FILE: DiffFile = {
  path: "src/a.ts",
  kind: "modified",
  additions: 1,
  deletions: 0,
  hunks: [
    {
      id: "h-1",
      header: "@@ -1,1 +1,2 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "keep" },
        { kind: "add", newLine: 2, text: "added" },
      ],
    },
  ],
};
const MODEL: DiffModel = { baseSha: "base", headSha: "head", files: [FILE] };
const ASSESSMENTS: DiffAssessment = {
  files: [{ path: FILE.path, riskScore: 0, reasons: [], collapsed: false }],
  hunks: [{ hunkId: "h-1", collapsed: false }],
  reviewOrder: [FILE.path],
};
const CONFIG: ResolvedReviewConfig = {
  editor: { command: ["true"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
};
const RECORD: ReviewRecord = {
  version: 1,
  repoKey: "repo-key",
  target: { kind: "branch", base: "main" },
  baseSha: "base",
  headSha: "head",
  cursor: { reviewedHunkIds: [], lastHeadSha: "head" },
  comments: [],
  createdAt: NOW,
  updatedAt: NOW,
};
const PLAIN_THEME = reinterpretHostValue<Theme>({
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});

function watchRejections(t: { after(fn: () => void): void }) {
  const seen: string[] = [];
  const listener = (reason: RuntimeValue) => {
    seen.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", listener);
  t.after(() => {
    process.off("unhandledRejection", listener);
  });
  return async (label: string) => {
    for (let round = 0; round < 5; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(seen.length, 0, `${label}: unhandled rejection ${seen[0] ?? ""}`);
  };
}

class FailingChat implements ReviewChat {
  readonly messages: ReviewChatMessage[] = [];
  readonly pending = false;
  readonly status = {};
  askError: Error | undefined;
  modelError: Error | undefined;
  private readonly listeners = new Set<() => void>();
  async ask(_question: string, _context: ReviewChatContext): Promise<void> {
    if (this.askError) throw this.askError;
  }
  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const listener of this.listeners) listener();
  }
  async setModel(query: string): Promise<string> {
    if (this.modelError) throw this.modelError;
    return query;
  }
  async setThinkingLevel(level: string): Promise<string> {
    return level;
  }
  async reload(): Promise<void> {}
  async prepare(): Promise<void> {}
  commands() {
    return [];
  }
  toolDefinition(): RuntimeValue {
    return undefined;
  }
  async runCommand(): Promise<void> {}
  dispose(): void {}
}

/** The host can be told to throw from notify, with a stale-context error or another one. */
type HostFailure = { notify?: Error; input?: Error };

async function mount(options: Partial<OpenReviewViewOptions> = {}) {
  const notices: string[] = [];
  const editorTexts: string[] = [];
  const completions: RuntimeValue[] = [];
  const failure: HostFailure = {};
  let component: Component | undefined;
  let finish: ((value: RuntimeValue) => void) | undefined;
  let ready: (() => void) | undefined;
  const mounted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const host: ReviewViewHost = {
    custom: async (factory) => {
      const result = new Promise<RuntimeValue>((resolve) => {
        finish = resolve;
      });
      const tui = reinterpretHostValue<Parameters<typeof factory>[0]>({
        terminal: { rows: 30 },
        requestRender: () => {},
        stop: () => {},
        start: () => {},
      });
      component = await factory(
        tui,
        PLAIN_THEME,
        reinterpretHostValue<Parameters<typeof factory>[2]>({}),
        (value) => {
          completions.push(value);
          finish?.(value);
        },
      );
      ready?.();
      return reinterpretHostValue(await result);
    },
    input: async () => {
      if (failure.input) throw failure.input;
      return undefined;
    },
    notify: (message) => {
      if (failure.notify) throw failure.notify;
      notices.push(message);
    },
    select: async () => undefined,
    setEditorText: (text) => {
      editorTexts.push(text);
    },
  };
  const completion = openReviewView({
    host,
    store: { load: async () => undefined, save: async () => {}, list: async () => [] },
    styler: { fg: (_color, text) => text, inverse: (text) => text },
    model: MODEL,
    assessments: ASSESSMENTS,
    record: RECORD,
    config: CONFIG,
    reviewRoot: "/repo",
    now: () => NOW,
    zentuiLoader: unavailableZentuiLoader,
    ...options,
  });
  await mounted;
  assert.ok(component);
  const view = component;
  return {
    notices,
    editorTexts,
    completions,
    failure,
    key: (data: string) => view.handleInput?.(data),
    closed: completion,
    screen: () => view.render(140).map(stripTerminalSequences).join("\n"),
    close: async () => {
      view.handleInput?.("\u001b");
      view.handleInput?.("q");
      await completion;
    },
  };
}

test("a failed refresh is on the message line and, as an error, in Pi's notifications once; a host that cannot notify changes nothing; r works again", async (t) => {
  const noRejections = watchRejections(t);
  let reloadError: Error | undefined = new Error("git gone");
  const review = await mount({
    reload: async () => {
      if (reloadError) throw reloadError;
      return MODEL;
    },
  });
  review.failure.notify = new Error("notify broke");
  review.key("r");
  await noRejections("manual refresh");
  assert.match(review.screen(), /Refresh failed: git gone/u, "on the message line");

  review.failure.notify = new Error(STALE);
  reloadError = new Error("git still gone");
  review.key("r");
  await noRejections("stale host");
  assert.match(review.screen(), /Refresh failed: git still gone/u, "the open view still shows it");
  assert.equal(review.notices.length, 0);

  review.failure.notify = undefined;
  reloadError = new Error("git third");
  review.key("r");
  await noRejections("working host");
  assert.match(review.screen(), /Refresh failed: git third/u);
  assert.deepEqual(
    review.notices,
    ["Refresh failed: git third"],
    "kept for after the review closes",
  );

  review.failure.notify = undefined;
  reloadError = undefined;
  review.key("r");
  await noRejections("recovered");
  assert.match(review.screen(), /Read the changes again/u);
  assert.equal(review.notices.length, 1, "confirmations stay in the view");
  await review.close();
});

test("a findings read that fails with a host that cannot notify stays in the view", async (t) => {
  const noRejections = watchRejections(t);
  let calls = 0;
  const review = await mount({
    loadFindings: async () => {
      calls += 1;
      throw new Error("records gone");
    },
    reload: async () => MODEL,
  });
  await noRejections("initial findings read");
  review.failure.notify = new Error("notify broke");
  review.key("r");
  await noRejections("findings after refresh");
  assert.equal(calls, 2);
  assert.match(review.screen(), /Review findings could not be read: records gone/u);
  await review.close();
});

test("a side-chat tool call that triggers a failing refresh never rejects", async (t) => {
  const noRejections = watchRejections(t);
  const chat = new FailingChat();
  const review = await mount({
    createReviewChat: () => chat,
    reload: async () => {
      throw new Error("git gone");
    },
  });
  review.key("a");
  review.failure.notify = new Error("notify broke");
  chat.messages.push({
    role: "tool",
    toolCallId: "edit-1",
    toolName: "edit",
    args: {},
    done: true,
  });
  chat.emit();
  await noRejections("tool refresh");
  assert.match(review.screen(), /Refresh failed: git gone/u);
  await review.close();
});

test("chat commands, questions and guarded key actions that fail never reject", async (t) => {
  const noRejections = watchRejections(t);
  const chat = new FailingChat();
  const review = await mount({ createReviewChat: () => chat });
  review.failure.notify = new Error("notify broke");

  review.key("a");
  chat.modelError = new Error("no such model");
  review.key("/model nope");
  review.key("\r");
  await noRejections("/model");
  assert.match(review.screen(), /no such model/u);

  chat.askError = new Error("ask failed");
  review.key("\u001b[Z");
  review.key("j");
  review.key("j");
  review.key("a");
  review.key("why?");
  review.key("\r");
  await noRejections("question");
  assert.match(review.screen(), /ask failed/u);

  review.key("\u001b[Z");
  review.failure.input = new Error("prompt failed");
  review.key("/");
  await noRejections("search");
  assert.match(review.screen(), /prompt failed/u);

  review.failure.notify = undefined;
  review.failure.input = undefined;
  chat.modelError = undefined;
  review.key("a");
  review.key("/model good");
  review.key("\r");
  await noRejections("recovered");
  assert.match(review.screen(), /Chat model set to good/u);
  await review.close();
});

test("a chat command that settles after the review closed reports nothing", async (t) => {
  const noRejections = watchRejections(t);
  const chat = new FailingChat();
  let release: (() => void) | undefined;
  chat.setModel = (query: string) =>
    new Promise<string>((resolve) => {
      release = () => resolve(query);
    });
  const review = await mount({ createReviewChat: () => chat });
  review.key("a");
  review.key("/model late");
  review.key("\r");
  await review.close();
  release?.();
  await noRejections("late model change");
  assert.equal(
    review.notices.some((notice) => notice.includes("Chat model set")),
    false,
  );
});

/* ------------------------------------------- Finish exports every non-PR target */

test("Finish puts the comments of an earlier turn into the editor, saying they refer to that comparison", async (t) => {
  const noRejections = watchRejections(t);
  const comment = {
    id: "c1",
    path: "src/a.ts",
    side: "RIGHT" as const,
    line: 2,
    body: "Rename this.",
    anchor: { hunkHash: "h-1", snippetHash: "0".repeat(64), snippet: "added" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const review = await mount({
    record: {
      ...RECORD,
      target: { kind: "session-turn", sessionId: "s1", turnIndex: 1 },
      comments: [comment],
    },
    includesWorkingTree: false,
  });
  review.key("S");
  await review.closed;
  await noRejections("finish");
  assert.equal(review.editorTexts.length, 1, "the comments reach the editor");
  const text = review.editorTexts[0] ?? "";
  assert.match(text, /Rename this\./u);
  assert.match(text, /may not match the files as they are now/u);
  assert.equal(
    text.includes("Resolve each comment"),
    false,
    "no instruction to change the working tree",
  );
});
