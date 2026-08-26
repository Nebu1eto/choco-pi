import assert from "node:assert/strict";
import test from "node:test";
import {
  CombinedAutocompleteProvider,
  Editor,
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import {
  AUTOCOMPLETE_ANYWHERE_BRIDGE,
  installAutocompleteAnywhere,
  isAutocompleteSuppressedContext,
  SLASH_COMPLETION_ITEM,
  slashTokenBeforeCursor,
} from "../.pi/extensions/lib/autocomplete-anywhere.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

type PrototypeRecord = Record<PropertyKey, RuntimeValue>;

function editorPrototype(): PrototypeRecord {
  // SAFETY: the extension patches these pinned host methods by name.
  return reinterpretHostValue<PrototypeRecord>(Editor.prototype);
}

function providerPrototype(): PrototypeRecord {
  // SAFETY: the extension patches these pinned host methods by name.
  return reinterpretHostValue<PrototypeRecord>(CombinedAutocompleteProvider.prototype);
}

function withInstalledPatches(run: () => void | Promise<void>) {
  return async () => {
    // SAFETY: the test restores only the symbol-keyed registry entry it temporarily replaces.
    const store = reinterpretHostValue<PrototypeRecord>(globalThis);
    const originalEditorStart = editorPrototype()["isAtStartOfMessage"];
    const originalEditorContext = editorPrototype()["isInSlashCommandContext"];
    const originalGetSuggestions = providerPrototype()["getSuggestions"];
    const originalApplyCompletion = providerPrototype()["applyCompletion"];
    const originalBridge = store[AUTOCOMPLETE_ANYWHERE_BRIDGE];
    delete store[AUTOCOMPLETE_ANYWHERE_BRIDGE];
    try {
      installAutocompleteAnywhere();
      await run();
    } finally {
      editorPrototype()["isAtStartOfMessage"] = originalEditorStart;
      editorPrototype()["isInSlashCommandContext"] = originalEditorContext;
      providerPrototype()["getSuggestions"] = originalGetSuggestions;
      providerPrototype()["applyCompletion"] = originalApplyCompletion;
      if (originalBridge === undefined) delete store[AUTOCOMPLETE_ANYWHERE_BRIDGE];
      else store[AUTOCOMPLETE_ANYWHERE_BRIDGE] = originalBridge;
    }
  };
}

test("suppression tracks fenced code across lines", () => {
  assert.equal(
    isAutocompleteSuppressedContext({ lines: ["```", "code"], cursorLine: 1, cursorCol: 4 }),
    true,
  );
  assert.equal(
    isAutocompleteSuppressedContext({
      lines: ["```", "code", "```", "normal"],
      cursorLine: 3,
      cursorCol: 6,
    }),
    false,
  );
  assert.equal(
    isAutocompleteSuppressedContext({ lines: ["~~~", "code"], cursorLine: 1, cursorCol: 4 }),
    true,
  );
  assert.equal(
    isAutocompleteSuppressedContext({
      lines: ["~~~", "code", "~~~", "normal"],
      cursorLine: 3,
      cursorCol: 6,
    }),
    false,
  );
});

test("suppression includes the fence line itself on any line", () => {
  assert.equal(
    isAutocompleteSuppressedContext({ lines: ["plain", "```"], cursorLine: 1, cursorCol: 3 }),
    true,
  );
  assert.equal(
    isAutocompleteSuppressedContext({ lines: ["plain", "  ~~~"], cursorLine: 1, cursorCol: 5 }),
    true,
  );
});

test("suppression detects blockquotes and open inline code", () => {
  assert.equal(
    isAutocompleteSuppressedContext({
      lines: ["plain", "  > quoted"],
      cursorLine: 1,
      cursorCol: 10,
    }),
    true,
  );
  assert.equal(
    isAutocompleteSuppressedContext({ lines: ["plain", "use `code"], cursorLine: 1, cursorCol: 9 }),
    true,
  );
  assert.equal(
    isAutocompleteSuppressedContext({
      lines: ["plain", "use `code`"],
      cursorLine: 1,
      cursorCol: 10,
    }),
    false,
  );
  assert.equal(
    isAutocompleteSuppressedContext({ lines: ["plain", "normal"], cursorLine: 1, cursorCol: 6 }),
    false,
  );
});

test("slash tokens require a whitespace boundary", () => {
  assert.equal(slashTokenBeforeCursor("/re"), "/re");
  assert.equal(slashTokenBeforeCursor("text /re"), "/re");
  assert.equal(slashTokenBeforeCursor("/usr/bi"), "/usr/bi");
  assert.equal(slashTokenBeforeCursor("src/f"), undefined);
  assert.equal(slashTokenBeforeCursor("@"), undefined);
  assert.equal(slashTokenBeforeCursor("   /re"), "/re");
});

const commands = [
  { name: "reload", argumentHint: "", description: "Reload extensions" },
  { name: "review", description: "Review changes" },
];

test(
  "provider suggests marked commands after text and at line start",
  withInstalledPatches(async () => {
    const provider = new CombinedAutocompleteProvider(commands, process.cwd());
    for (const [line, cursorCol] of [
      ["text /rel", 9],
      ["/rel", 4],
    ] as const) {
      const suggestions = await provider.getSuggestions([line], 0, cursorCol, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(suggestions?.prefix, "/rel");
      const reload = suggestions?.items.find((item) => item.value === "reload");
      assert.ok(reload);
      // SAFETY: the extension deliberately adds this symbol property to command items.
      assert.equal(
        reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(reload)[SLASH_COMPLETION_ITEM],
        true,
      );
      assert.equal(
        Object.prototype.propertyIsEnumerable.call(reload, SLASH_COMPLETION_ITEM),
        false,
      );
    }
  }),
);

test(
  "provider suppresses completion inside inline code",
  withInstalledPatches(async () => {
    const provider = new CombinedAutocompleteProvider(commands, process.cwd());
    const suggestions = await provider.getSuggestions(["see `code /rel`"], 0, 14, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(suggestions, null);
  }),
);

test(
  "marked command completion replaces only the slash token",
  withInstalledPatches(async () => {
    const provider = new CombinedAutocompleteProvider(commands, process.cwd());
    const suggestions = await provider.getSuggestions(["edit /re"], 0, 8, {
      signal: AbortSignal.timeout(5000),
    });
    const reload = suggestions?.items.find((item) => item.value === "reload");
    assert.ok(reload);
    assert.deepEqual(provider.applyCompletion(["edit /re"], 0, 8, reload, "/re"), {
      lines: ["edit /reload "],
      cursorLine: 0,
      cursorCol: 13,
    });
  }),
);

test(
  "unmarked completion items retain the host path behavior",
  withInstalledPatches(() => {
    const provider = new CombinedAutocompleteProvider(commands, process.cwd());
    const item: AutocompleteItem = { value: "src/file.ts", label: "file.ts" };
    assert.deepEqual(provider.applyCompletion(["open src/f"], 0, 10, item, "src/f"), {
      lines: ["open src/file.ts"],
      cursorLine: 0,
      cursorCol: 16,
    });
  }),
);

interface EditorFixture {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
}

function editorFixture(lines: string[], cursorLine: number, cursorCol: number): EditorFixture {
  // SAFETY: these tests need only the state read by the patched private methods.
  return reinterpretHostValue<EditorFixture>(
    Object.create(Editor.prototype, {
      state: { configurable: true, writable: true, value: { lines, cursorLine, cursorCol } },
    }),
  );
}

test(
  "editor slash context works on later lines and after text",
  withInstalledPatches(() => {
    const start = editorFixture(["plain", "next /"], 1, 6);
    const middle = editorFixture(["use /reload now"], 0, 7);
    // SAFETY: the runtime prototype owns these private methods even though the declaration omits them.
    const isAtStart = reinterpretHostValue<(this: EditorFixture) => boolean>(
      editorPrototype()["isAtStartOfMessage"],
    );
    // SAFETY: the runtime prototype owns these private methods even though the declaration omits them.
    const isInContext = reinterpretHostValue<(this: EditorFixture, text: string) => boolean>(
      editorPrototype()["isInSlashCommandContext"],
    );
    assert.equal(isAtStart.call(start), true);
    assert.equal(isInContext.call(middle, "use /re"), true);
  }),
);

test(
  "editor slash context is suppressed in fences and ignores ordinary paths",
  withInstalledPatches(() => {
    const fenced = editorFixture(["```", "/"], 1, 1);
    const path = editorFixture(["src/fa"], 0, 6);
    // SAFETY: the runtime prototype owns these private methods even though the declaration omits them.
    const isAtStart = reinterpretHostValue<(this: EditorFixture) => boolean>(
      editorPrototype()["isAtStartOfMessage"],
    );
    // SAFETY: the runtime prototype owns these private methods even though the declaration omits them.
    const isInContext = reinterpretHostValue<(this: EditorFixture, text: string) => boolean>(
      editorPrototype()["isInSlashCommandContext"],
    );
    assert.equal(isAtStart.call(fenced), false);
    assert.equal(isInContext.call(fenced, "/"), false);
    assert.equal(isInContext.call(path, "src/fa"), false);
  }),
);
