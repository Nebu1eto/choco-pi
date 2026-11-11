// Every row the changes view returns fits the requested width, including at 0 to 3 columns
// and with a double-width character at the cut.
import assert from "node:assert/strict";
import test from "node:test";
import { Input, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffStoreState, FileBody } from "../.pi/extensions/lib/changes/git/model.ts";
import { EMPTY_FINDINGS, type RecordedFinding } from "../.pi/extensions/lib/changes/findings.ts";
import { NotesBook } from "../.pi/extensions/lib/changes/notes.ts";
import { ChangesView } from "../.pi/extensions/lib/changes/view/changes-view.ts";
import { plainPaneStyler } from "../.pi/extensions/lib/changes/view/rows.ts";
import { file, flush, hunk, snapshot, textBody } from "./diff-actions-fakes.ts";

const WIDE = "漢字ファイル";
const FILES = [file(`${WIDE}/名前.ts`), file("b.txt")];
const HUNK = hunk("h1", 1, ["-古い行", `+新しい行 ${WIDE.repeat(4)}`, " context"]);

function finding(path: string, id: string): RecordedFinding {
  return {
    id,
    class: "finding",
    severity: "high",
    path,
    startLine: 1,
    endLine: 1,
    invariant: `${WIDE} must hold ${WIDE}`,
    evidence: "code_path",
    reproduction: "",
    workTask: "t",
    agentId: "a",
    completedAt: 0,
  };
}

function view(options: { trailer?: boolean } = {}) {
  const bodies = new Map<string, FileBody>([[FILES[0]!.path, textBody(FILES[0]!.path, [HUNK])]]);
  let revision = 1;
  const instance = new ChangesView({
    store: {
      loadFile: async (path: string) => ({ revision, body: bodies.get(path) ?? { kind: "gone" } }),
    },
    styler: plainPaneStyler,
    keyHint: `keys ${WIDE}`,
    helpLines: [`help ${WIDE}`, "j/k move"],
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {},
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
    rowDetails: () => [{ text: `detail ${WIDE}`, color: "muted" }],
    trailer: () => (options.trailer ? [`trailer ${WIDE.repeat(3)}`] : []),
  });
  const ready = (files = FILES, omittedFiles = 0) => {
    const state: DiffStoreState = {
      kind: "ready",
      snapshot: { ...snapshot(revision, files), omittedFiles },
      refreshing: true,
    };
    instance.setState(state);
  };
  return {
    instance,
    ready,
    setRevision: (value: number) => {
      revision = value;
    },
  };
}

async function fixtures(): Promise<Array<{ name: string; view: ChangesView }>> {
  const idle = view().instance;
  const error = view().instance;
  error.setState({ kind: "error", message: `cannot read ${WIDE.repeat(5)}` });
  const empty = view({ trailer: true });
  empty.ready([]);
  const omitted = view();
  omitted.ready(FILES, 7);
  const full = view({ trailer: true });
  full.ready();
  full.instance.toggleExpanded();
  await flush();
  const notes = new NotesBook();
  notes.add({ path: FILES[0]!.path, hunk: HUNK, range: "line 1", text: `note ${WIDE}`, now: 1 });
  notes.add({ path: "gone.txt", hunk: HUNK, range: "line 1", text: `old ${WIDE}`, now: 2 });
  full.instance.notes = notes;
  full.instance.setRecorded(
    { ...EMPTY_FINDINGS, findings: [finding(FILES[0]!.path, "F1"), finding("elsewhere.ts", "F2")] },
    new Map(),
  );
  full.instance.setMessage(`message about ${WIDE.repeat(3)}`, "warning");
  full.instance.helpOpen = true;
  full.instance.invalidate();
  const noting = view();
  noting.ready();
  noting.instance.noteInput = {
    input: new Input(),
    path: FILES[0]!.path,
    hunkId: "h1",
    range: "line 1",
  };
  return [
    { name: "idle", view: idle },
    { name: "error", view: error },
    { name: "empty", view: empty.instance },
    { name: "omitted", view: omitted.instance },
    { name: "full", view: full.instance },
    { name: "noting", view: noting.instance },
  ];
}

test("no header or body row is wider than the requested width, for widths 0 to 12", async () => {
  const all = await fixtures();
  assert.ok(
    all
      .find((entry) => entry.name === "full")
      ?.view.renderBody(80, true)
      .join("\n")
      .includes("新しい行"),
    "the full fixture shows its expanded body",
  );
  for (const { name, view: subject } of all) {
    for (let width = 0; width <= 12; width += 1) {
      for (const focused of [true, false]) {
        const rows = [
          ...subject.renderHeader(width, focused).map((row) => ["header", row] as const),
          ...subject.renderBody(width, focused).map((row) => ["body", row] as const),
        ];
        for (const [part, row] of rows) {
          assert.ok(
            visibleWidth(row) <= width,
            `${name} ${part} at width ${width}: ${visibleWidth(row)} columns`,
          );
        }
      }
    }
  }
});
