// Body loads that finish after a newer snapshot was applied are dropped.
import assert from "node:assert/strict";
import test from "node:test";
import type { FileBody } from "../.pi/extensions/lib/changes/git/model.ts";
import { ChangesView } from "../.pi/extensions/lib/changes/view/changes-view.ts";
import { plainPaneStyler } from "../.pi/extensions/lib/changes/view/rows.ts";
import { file, flush, hunk, snapshot, textBody } from "./diff-actions-fakes.ts";

type Load = {
  path: string;
  resolve(value: { revision: number; body: FileBody }): void;
  reject(error: Error): void;
};

/**
 * Every load stays pending until the test settles it, in any order. Like the real store
 * (tests/changes-store-contract.test.ts), a load answers with the store's revision when it
 * began: settling it with any other revision fails the test.
 */
class ControlledStore {
  readonly loads: Load[] = [];
  /** The store's own snapshot revision; it can be ahead of the view's. */
  revision = 0;
  loadFile(path: string): Promise<{ revision: number; body: FileBody }> {
    const began = this.revision;
    return new Promise((resolve, reject) =>
      this.loads.push({
        path,
        resolve: (value) => {
          assert.equal(value.revision, began, "a load answers with the revision it began at");
          resolve(value);
        },
        reject,
      }),
    );
  }
}

const A = file("a.txt");
const BODY_1 = textBody("a.txt", [hunk("h1", 1, ["-one", "+REVISION-ONE"])]);
const BODY_2 = textBody("a.txt", [hunk("h2", 1, ["-one", "+REVISION-TWO"])]);

function mount() {
  const store = new ControlledStore();
  let renders = 0;
  const view = new ChangesView({
    store,
    styler: plainPaneStyler,
    keyHint: "",
    helpLines: [],
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {
        renders += 1;
      },
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
  });
  /** The store moves to `revision` and the view applies it, as the hosts' subscriptions do. */
  const ready = (revision: number) => {
    store.revision = revision;
    view.setState({ kind: "ready", snapshot: snapshot(revision, [A]), refreshing: false });
  };
  return { store, view, ready, renders: () => renders };
}

function shown(view: ChangesView): string {
  return view.renderBody(80, true).join("\n");
}

test("a revision-1 body resolving after revision 2 was applied is dropped", async () => {
  const { store, view, ready } = mount();
  ready(1);
  view.toggleExpanded();
  ready(2);
  assert.deepEqual(
    store.loads.map((load) => load.path),
    ["a.txt", "a.txt"],
    "revision 2 requested its own body",
  );
  store.loads[0]?.resolve({ revision: 1, body: BODY_1 });
  await flush();
  assert.equal(shown(view).includes("REVISION-ONE"), false);
  assert.equal(view.visibleHunks(A), undefined, "no hunks are offered to actions");
  store.loads[1]?.resolve({ revision: 2, body: BODY_2 });
  await flush();
  assert.equal(shown(view).includes("REVISION-TWO"), true);
  assert.deepEqual(
    view.visibleHunks(A)?.map((entry) => entry.id),
    ["h2"],
  );
});

test("a revision-1 failure after revision 2 was applied is dropped too", async () => {
  const { store, view, ready } = mount();
  ready(1);
  view.toggleExpanded();
  ready(2);
  store.loads[0]?.reject(new Error("late failure"));
  await flush();
  assert.equal(shown(view).includes("late failure"), false);
  store.loads[1]?.resolve({ revision: 2, body: BODY_2 });
  await flush();
  assert.equal(shown(view).includes("REVISION-TWO"), true);
});

test("a body loaded for revision 1 is not shown or offered under revision 2", async () => {
  const { store, view, ready } = mount();
  ready(1);
  view.toggleExpanded();
  store.loads[0]?.resolve({ revision: 1, body: BODY_1 });
  await flush();
  assert.equal(shown(view).includes("REVISION-ONE"), true);
  ready(2);
  assert.equal(shown(view).includes("REVISION-ONE"), false);
  assert.equal(view.visibleHunks(A), undefined);
  assert.equal(view.loadedHunks("a.txt"), undefined);
  store.loads[1]?.resolve({ revision: 2, body: BODY_2 });
  await flush();
  assert.equal(shown(view).includes("REVISION-TWO"), true);
});

test("the current revision's body resolving first is not replaced by a late older one", async () => {
  const { store, view, ready } = mount();
  ready(1);
  view.toggleExpanded();
  ready(2);
  store.loads[1]?.resolve({ revision: 2, body: BODY_2 });
  await flush();
  store.loads[0]?.resolve({ revision: 1, body: BODY_1 });
  await flush();
  assert.equal(shown(view).includes("REVISION-TWO"), true);
  assert.equal(shown(view).includes("REVISION-ONE"), false);
});
