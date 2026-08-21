import {
  isString,
  reinterpretHostValue,
  runtimeTypeOf,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  createZentuiFrameAdapter,
  FRAME_BORDER_ROWS,
  FRAME_BORDER_WIDTH,
  resolveZentuiFile,
  type ZentuiLoader,
  type ZentuiModules,
} from "../.pi/extensions/review/ui/zentui-frame.ts";
import {
  realBoxZentuiLoader,
  realZentuiLoader,
  SKIP_WITHOUT_ZENTUI,
  withEditorConfig,
} from "./zentui-build.ts";

// SAFETY: The fixture supplies every host member exercised by this test.
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

/** pi-tui's Editor renders a plain rule above and below its text rows. */
function editorRender(width: number, ...text: string[]): string[] {
  const rule = "─".repeat(width);
  return [rule, ...text.map((line) => line.padEnd(width, " ")), rule];
}

type RecordedFrame = Parameters<ZentuiModules["renderMinimalistFrame"]>[0];
type RecordedPolishedFrame = Parameters<NonNullable<ZentuiModules["renderPolishedEditorFrame"]>>[0];
type RecordingLoader = { loader: ZentuiLoader; calls: RecordedFrame[] };
type PolishedRecordingLoader = {
  loader: ZentuiLoader;
  polishedCalls: RecordedPolishedFrame[];
  boxCalls: RecordedFrame[];
};

function recordingLoader(
  options: {
    config?: Record<string, RuntimeValue>;
    render?: (frame: RecordedFrame) => RuntimeValue;
  } = {},
): RecordingLoader {
  const calls: RecordedFrame[] = [];
  const loader: ZentuiLoader = async () => ({
    renderMinimalistFrame: (frame) => {
      calls.push(frame);
      // SAFETY: The fixture supplies every host member exercised by this test.
      return (options.render?.(frame) ?? ["framed"]) as string[];
    },
    loadConfig: () => options.config ?? {},
  });
  return { loader, calls };
}

/**
 * A zentui that also exports the polished renderer, which is what decorates the
 * session prompt in every style but `minimalist`.
 */
function polishedRecordingLoader(
  options: {
    config?: Record<string, RuntimeValue>;
    render?: (frame: RecordedPolishedFrame) => RuntimeValue;
  } = {},
): PolishedRecordingLoader {
  const polishedCalls: RecordedPolishedFrame[] = [];
  const boxCalls: RecordedFrame[] = [];
  const loader: ZentuiLoader = async () => ({
    renderMinimalistFrame: (frame) => {
      boxCalls.push(frame);
      return ["boxed"];
    },
    renderPolishedEditorFrame: (frame) => {
      polishedCalls.push(frame);
      // SAFETY: The fixture supplies every host member exercised by this test.
      return (options.render?.(frame) ?? ["polished"]) as string[];
    },
    formatProviderLabel: (provider) => (provider === "anthropic" ? "Anthropic" : (provider ?? "")),
    loadConfig: () => options.config ?? {},
  });
  return { loader, polishedCalls, boxCalls };
}

test("frame overhead constants describe zentui's borders", () => {
  assert.equal(FRAME_BORDER_WIDTH, 4, "│ plus a space on each side");
  assert.equal(FRAME_BORDER_ROWS, 2, "one top and one bottom border row");
});

test("an unavailable zentui leaves the editor exactly as pi-tui rendered it", async () => {
  const adapter = await createZentuiFrameAdapter(async () => undefined);
  const editorLines = editorRender(20, "line one", "line two");

  assert.equal(adapter.available, false);
  assert.equal(adapter.editorWidth(100), 100, "fallback keeps the full width");
  assert.equal(adapter.editorWidth(3), 3);
  assert.deepEqual(
    adapter.frame({ width: 100, editorLines, cwd: "/repo", uiTheme: PLAIN_THEME }),
    editorLines,
  );
});

test("an unavailable zentui keeps the completion list below the editor", async () => {
  const adapter = await createZentuiFrameAdapter(async () => undefined);
  const editorLines = editorRender(20, "src/");
  const autocompleteLines = ["→ src/auth.ts", "  src/ordinary.ts"];

  assert.deepEqual(
    adapter.frame({
      width: 100,
      editorLines,
      autocompleteLines,
      cwd: "/repo",
      uiTheme: PLAIN_THEME,
    }),
    [...editorLines, ...autocompleteLines],
    "exactly what pi-tui rendered on its own",
  );
});

test("a throwing loader falls back instead of failing the view", async () => {
  const adapter = await createZentuiFrameAdapter(async () => {
    throw new Error("module not found");
  });
  assert.equal(adapter.available, false);
  assert.equal(adapter.editorWidth(80), 80);
});

test("a module missing either export is refused at the boundary", async () => {
  for (const candidate of [
    { renderMinimalistFrame: "not a function", loadConfig: () => ({}) },
    { renderMinimalistFrame: () => [], loadConfig: undefined },
    {},
    undefined,
    "zentui",
  ]) {
    // SAFETY: The fixture supplies every host member exercised by this test.
    const adapter = await createZentuiFrameAdapter(async () => candidate as never);
    assert.equal(adapter.available, false, `refused ${JSON.stringify(candidate) ?? "undefined"}`);
  }
});

test("an unreadable config makes the adapter unavailable", async () => {
  const throwing = await createZentuiFrameAdapter(async () => ({
    renderMinimalistFrame: () => ["framed"],
    loadConfig: () => {
      throw new Error("config load failed");
    },
  }));
  assert.equal(throwing.available, false);

  const nonObject = await createZentuiFrameAdapter(async () => ({
    renderMinimalistFrame: () => ["framed"],
    // SAFETY: The fixture supplies every host member exercised by this test.
    loadConfig: (() => "not a config") as never,
  }));
  assert.equal(nonObject.available, false);
});

test("a renderer that throws or returns a non-string list falls back per call", async () => {
  let call = 0;
  const adapter = await createZentuiFrameAdapter(async () => ({
    renderMinimalistFrame: () => {
      call += 1;
      if (call === 1) throw new Error("render failed");
      if (call === 2) return reinterpretHostValue<string[]>([1, 2]);
      if (call === 3) return [];
      return ["recovered"];
    },
    loadConfig: () => ({}),
  }));
  const editorLines = editorRender(10, "original");
  const frame = () =>
    adapter.frame({
      width: 40,
      editorLines,
      cwd: "/repo",
      uiTheme: PLAIN_THEME,
    });

  assert.equal(adapter.available, true);
  assert.deepEqual(frame(), editorLines, "a throwing renderer keeps pi-tui's rows");
  assert.deepEqual(frame(), editorLines, "a non-string list is refused");
  assert.deepEqual(frame(), editorLines, "an empty list is refused");
  assert.deepEqual(frame(), ["recovered"]);
});

test("only the editor's text rows are framed, with review-appropriate metadata", async () => {
  const { loader, calls } = recordingLoader();
  const adapter = await createZentuiFrameAdapter(loader);
  adapter.frame({
    width: 60,
    editorLines: editorRender(56, "draft comment", "second line"),
    cwd: "/workspace/project",
    uiTheme: PLAIN_THEME,
  });

  assert.equal(calls.length, 1);
  const frame = calls[0]!;
  assert.deepEqual(
    frame.editorLines,
    ["draft comment".padEnd(56, " "), "second line".padEnd(56, " ")],
    "pi-tui's rule rows are replaced, not wrapped",
  );
  assert.equal(frame.inputText, "", "no shell-mode sigil in a review comment box");
  assert.deepEqual(frame.metadata, {
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
  });
  assert.equal(frame.viewport, undefined, "no scroll labels when nothing is hidden");
  assert.equal(frame.autocompleteLines, undefined, "no list, no rows to draw");
  assert.equal(frame.width, 60);
});

test("an open completion list is handed to zentui rather than left below the frame", async () => {
  const { loader, calls } = recordingLoader();
  const adapter = await createZentuiFrameAdapter(loader);
  const autocompleteLines = ["→ src/auth.ts", "  src/ordinary.ts"];
  const framed = adapter.frame({
    width: 60,
    editorLines: editorRender(56, "src/"),
    autocompleteLines,
    cwd: "/workspace/project",
    uiTheme: PLAIN_THEME,
  });

  assert.deepEqual(calls[0]?.editorLines, ["src/".padEnd(56, " ")]);
  assert.deepEqual(calls[0]?.autocompleteLines, autocompleteLines);
  assert.deepEqual(framed, ["framed"], "the rows come back from zentui, not appended after it");
});

test("a declined frame still returns the completion rows", async () => {
  const { loader, calls } = recordingLoader({
    render: () => {
      throw new Error("render failed");
    },
  });
  const adapter = await createZentuiFrameAdapter(loader);
  const autocompleteLines = ["→ src/auth.ts"];
  const frame = (editorLines: string[], width = 60) =>
    adapter.frame({
      width,
      editorLines,
      autocompleteLines,
      cwd: "/repo",
      uiTheme: PLAIN_THEME,
    });

  assert.deepEqual(
    frame(["not a rule", "text", "─────"]),
    ["not a rule", "text", "─────", ...autocompleteLines],
    "chrome zentui cannot own leaves the list where pi-tui put it",
  );
  assert.deepEqual(
    frame(editorRender(4, "x"), FRAME_BORDER_WIDTH),
    [...editorRender(4, "x"), ...autocompleteLines],
    "a width with no room for borders keeps the list too",
  );
  assert.deepEqual(
    frame(editorRender(56, "src/")),
    [...editorRender(56, "src/"), ...autocompleteLines],
    "and so does a renderer that throws",
  );
  assert.equal(calls.length, 1, "zentui was only reached once, by the last case");
});

test("editor scroll counts become frame viewport labels unless the user disabled them", async () => {
  const scrolled = ["─── ↑ 3 more ────────", "visible text", "─── ↓ 12 more ───────"];
  const shown = recordingLoader();
  const shownAdapter = await createZentuiFrameAdapter(shown.loader);
  shownAdapter.frame({ width: 40, editorLines: scrolled, cwd: "/repo", uiTheme: PLAIN_THEME });
  assert.deepEqual(shown.calls[0]?.viewport, { above: "3", below: "12" });

  const hidden = recordingLoader({
    config: { components: { editor: { viewportIndicators: false } } },
  });
  const hiddenAdapter = await createZentuiFrameAdapter(hidden.loader);
  hiddenAdapter.frame({ width: 40, editorLines: scrolled, cwd: "/repo", uiTheme: PLAIN_THEME });
  assert.deepEqual(hiddenAdapter.editorWidth(40), 36);
  assert.deepEqual(hidden.calls[0]?.viewport, {}, "counts are dropped, rows still framed");
});

test("unrecognised editor chrome is left alone", async () => {
  const { loader, calls } = recordingLoader();
  const adapter = await createZentuiFrameAdapter(loader);
  const cases = [["not a rule", "text", "─────"], ["─────", "text", "not a rule"], ["─────"], []];
  for (const editorLines of cases) {
    assert.deepEqual(
      adapter.frame({ width: 40, editorLines, cwd: "/repo", uiTheme: PLAIN_THEME }),
      editorLines,
    );
  }
  assert.equal(calls.length, 0, "zentui is never called with rows it cannot own");

  const narrow = editorRender(4, "x");
  assert.deepEqual(
    adapter.frame({
      width: FRAME_BORDER_WIDTH,
      editorLines: narrow,
      cwd: "/repo",
      uiTheme: PLAIN_THEME,
    }),
    narrow,
    "a width with no room for borders stays unframed",
  );
});

test("the default loader never throws and always yields a usable adapter", async () => {
  const adapter = await createZentuiFrameAdapter();
  const editorLines = editorRender(76, "text");
  const framed = adapter.frame({ width: 80, editorLines, cwd: "/repo", uiTheme: PLAIN_THEME });

  assert.equal(runtimeTypeOf(adapter.available), "boolean");
  assert.ok(framed.every((line) => isString(line)));
  assert.equal(adapter.editorWidth(80), adapter.available ? 76 : 80);
  if (!adapter.available) assert.deepEqual(framed, editorLines);
});

test(
  "zentui's own renderer keeps the row count and fills the requested width",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    const adapter = await createZentuiFrameAdapter(realBoxZentuiLoader);
    assert.equal(adapter.available, true);
    assert.equal(adapter.editorWidth(100), 96);
    assert.equal(adapter.editorWidth(5), 1);
    assert.equal(
      adapter.editorWidth(FRAME_BORDER_WIDTH),
      FRAME_BORDER_WIDTH,
      "no framing, no reduction",
    );
    assert.equal(adapter.editorWidth(3), 3);

    for (const width of [24, 40, 80, 200]) {
      const editorLines = editorRender(adapter.editorWidth(width), "draft comment", "second line");
      const framed = adapter.frame({
        width,
        editorLines,
        cwd: "/workspace/my-project",
        uiTheme: PLAIN_THEME,
      });
      const plain = framed.map(stripTerminalSequences);

      assert.equal(framed.length, editorLines.length, `width ${width} adds no rows`);
      for (const line of plain) {
        assert.equal(visibleWidth(line), width, `width ${width} fills every row`);
        assert.notEqual(line.trim(), "", `width ${width} leaves no blank row`);
      }
      assert.match(plain[0]!, /^╭─+╮$/, "an empty metadata row is a plain top border");
      assert.match(plain[1]!, /^│ draft comment {2,}│$/);
      assert.match(plain[2]!, /^│ second line {2,}│$/);
      assert.match(plain.at(-1)!, /^╰─+ my-project ─╯$/, "the cwd is the only bottom label");
    }
  },
);

test(
  "zentui's own renderer draws the completion list inside the frame",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    const adapter = await createZentuiFrameAdapter(realBoxZentuiLoader);
    for (const width of [40, 80, 120]) {
      const editorLines = editorRender(adapter.editorWidth(width), "src/");
      const autocompleteLines = ["→ src/auth.ts", "  src/ordinary.ts"];
      const framed = adapter
        .frame({
          width,
          editorLines,
          autocompleteLines,
          cwd: "/workspace/my-project",
          uiTheme: PLAIN_THEME,
        })
        .map(stripTerminalSequences);
      const label = `width ${width}`;

      assert.equal(
        framed.length,
        editorLines.length + 1 + autocompleteLines.length,
        `${label} rows`,
      );
      for (const line of framed) assert.equal(visibleWidth(line), width, `${label} row width`);
      assert.match(framed[0]!, /^╭─+╮$/, `${label} top border`);
      assert.match(framed[1]!, /^│ src\/ +│$/, `${label} text row`);
      assert.match(framed[2]!, /^├─+┤$/, `${label} the list is separated from the text`);
      assert.match(framed[3]!, /^│ → src\/auth\.ts +│$/, `${label} first candidate`);
      assert.match(framed[4]!, /^│ {3}src\/ordinary\.ts +│$/, `${label} second candidate`);
      assert.match(
        framed.at(-1)!,
        /^╰─+ my-project ─╯$/,
        `${label} the frame closes below the list`,
      );
    }
  },
);

test(
  "zentui's own renderer shows the editor's hidden-row counts",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    const adapter = await createZentuiFrameAdapter(realBoxZentuiLoader);
    const framed = adapter
      .frame({
        width: 60,
        editorLines: ["─── ↑ 3 more ───", "visible text", "─── ↓ 12 more ───"],
        cwd: "/workspace/my-project",
        uiTheme: PLAIN_THEME,
      })
      .map(stripTerminalSequences);

    assert.equal(framed.length, 3);
    assert.match(framed[0]!, /^╭─ ↑ 3 more ─+╮$/);
    assert.match(framed.at(-1)!, /^╰─ ↓ 12 more ─+ my-project ─╯$/);
  },
);

test("the configured prompt style decides which renderer draws the input", async () => {
  const styles = [
    { style: undefined, polished: 1, boxed: 0, reason: "zentui defaults to the polished prompt" },
    { style: "opencode", polished: 1, boxed: 0, reason: "the polished prompt is reproduced" },
    { style: "opencode-copy-friendly", polished: 1, boxed: 0, reason: "still a polished prompt" },
    { style: "minimalist", polished: 0, boxed: 1, reason: "the box is the user's choice" },
  ];
  for (const { style, polished, boxed, reason } of styles) {
    const config = style === undefined ? {} : { components: { editor: { style } } };
    const { loader, polishedCalls, boxCalls } = polishedRecordingLoader({ config });
    const adapter = await createZentuiFrameAdapter(loader);
    adapter.frame({
      width: 60,
      editorLines: editorRender(58, "text"),
      cwd: "/repo",
      uiTheme: PLAIN_THEME,
    });
    assert.equal(polishedCalls.length, polished, reason);
    assert.equal(boxCalls.length, boxed, reason);
  }
});

test("a zentui without the polished renderer still draws the box", async () => {
  const { loader, calls } = recordingLoader({
    config: { components: { editor: { style: "opencode" } } },
  });
  const adapter = await createZentuiFrameAdapter(loader);
  const framed = adapter.frame({
    width: 60,
    editorLines: editorRender(56, "text"),
    cwd: "/repo",
    uiTheme: PLAIN_THEME,
  });

  assert.equal(calls.length, 1, "the older export is used rather than dropping the frame");
  assert.deepEqual(framed, ["framed"]);
  assert.equal(adapter.editorWidth(60), 56, "box borders still cost four columns");
});

test("the polished frame is given the chat's model, provider, and effort", async () => {
  const { loader, polishedCalls } = polishedRecordingLoader();
  const adapter = await createZentuiFrameAdapter(loader);
  const autocompleteLines = ["→ src/auth.ts"];
  adapter.frame({
    width: 80,
    editorLines: editorRender(78, "question", "second line"),
    autocompleteLines,
    cwd: "/workspace/project",
    uiTheme: PLAIN_THEME,
    model: { label: "claude-opus-5", provider: "anthropic", thinkingLevel: "medium" },
  });

  const frame = polishedCalls[0]!;
  assert.deepEqual(
    frame.editorLines,
    ["question".padEnd(78, " "), "second line".padEnd(78, " ")],
    "pi-tui's rule rows are replaced, not wrapped",
  );
  assert.deepEqual(frame.autocompleteLines, autocompleteLines);
  assert.equal(frame.width, 80);
  assert.equal(frame.modelMeta.modelLabel, "claude-opus-5");
  assert.equal(
    frame.modelMeta.providerLabel,
    "Anthropic",
    "the provider id becomes its display name",
  );
  assert.equal(frame.thinkingLevel, "medium");
});

test("an input with no session behind it names no model", async () => {
  const { loader, polishedCalls } = polishedRecordingLoader();
  const adapter = await createZentuiFrameAdapter(loader);
  adapter.frame({
    width: 60,
    editorLines: editorRender(58, "draft comment"),
    cwd: "/repo",
    uiTheme: PLAIN_THEME,
  });

  const frame = polishedCalls[0]!;
  assert.equal(frame.modelMeta.modelLabel, "");
  assert.equal(frame.modelMeta.providerLabel, "");
  assert.equal(frame.thinkingLevel, undefined);
});

test("the box keeps naming the model when the user chose it", async () => {
  const { loader, calls } = recordingLoader({
    config: { components: { editor: { style: "minimalist" } } },
  });
  const adapter = await createZentuiFrameAdapter(loader);
  adapter.frame({
    width: 60,
    editorLines: editorRender(56, "question"),
    cwd: "/repo",
    uiTheme: PLAIN_THEME,
    model: { label: "claude-opus-5", provider: "anthropic", thinkingLevel: "medium" },
  });

  assert.deepEqual(calls[0]?.metadata, {
    cwd: "/repo",
    projectRoot: "/repo",
    modelLabel: "claude-opus-5",
    thinkingLevel: "medium",
  });
});

test("the polished styles reserve their own rail width, not the box's borders", async () => {
  const cases = [
    { config: {}, width: 1, reason: "the default rail icon is empty, leaving its space" },
    { config: { icons: { rail: "▌" } }, width: 2, reason: "the rail icon plus its space" },
    {
      config: {
        components: { editor: { style: "opencode-copy-friendly" } },
        icons: { editorPrompt: "❯" },
      },
      width: 2,
      reason: "the copy-friendly style prefixes the prompt icon instead",
    },
    {
      config: { components: { editor: { style: "opencode-copy-friendly" } } },
      width: 0,
      reason: "no prompt icon, no reserved columns",
    },
  ];
  for (const { config, width, reason } of cases) {
    const { loader } = polishedRecordingLoader({ config });
    const adapter = await createZentuiFrameAdapter(loader);
    assert.equal(adapter.editorWidth(100), 100 - width, reason);
  }
});

test(
  "zentui's own polished renderer reproduces the session prompt",
  {
    skip: SKIP_WITHOUT_ZENTUI,
  },
  async () => {
    // The separator row this asserts is a configurable padding row, so the
    // fixture pins it rather than inheriting the developer's own preference.
    const adapter = await createZentuiFrameAdapter(
      withEditorConfig(realZentuiLoader, { style: "opencode", paddingRows: "bottom" }),
    );
    assert.equal(adapter.available, true);

    for (const width of [40, 80, 120]) {
      const editorLines = editorRender(adapter.editorWidth(width), "question");
      const framed = adapter
        .frame({
          width,
          editorLines,
          cwd: "/workspace/my-project",
          uiTheme: PLAIN_THEME,
          model: { label: "claude-opus-5", provider: "anthropic", thinkingLevel: "medium" },
        })
        .map(stripTerminalSequences);
      const label = `width ${width}`;

      assert.equal(framed.length, editorLines.length + 2, `${label} adds the metadata rows`);
      assert.match(framed[0]!, /^─+$/, `${label} opens with a rule, not a box corner`);
      assert.match(framed[1]!, /question/, `${label} keeps the typed text`);
      assert.doesNotMatch(framed[2]!, /\w/, `${label} a blank row separates the metadata`);
      assert.match(framed[3]!, /claude-opus-5/, `${label} the model is named under the input`);
      assert.match(framed[3]!, /Anthropic/, `${label} the provider is named under the input`);
      assert.match(framed[3]!, /medium/, `${label} the effort is named under the input`);
      assert.match(framed.at(-1)!, /^─+$/, `${label} closes with a rule`);
      for (const line of framed) {
        assert.ok(visibleWidth(line) <= width, `${label} no row overflows`);
      }
    }
  },
);

test("a zentui pinned by path is found like an installed one", () => {
  const manifest = resolveZentuiFile("package.json");
  assert.equal(runtimeTypeOf(manifest), "string", "the pinned fork in .pi/packages must resolve");
  assert.match(manifest!, /choco-pi-ui[/\\]package\.json$/);
  assert.equal(existsSync(manifest!), true);
});
