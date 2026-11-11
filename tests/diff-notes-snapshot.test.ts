// Notes sent to the editor quote a hunk only from a body of the snapshot current when the
// message is built. The fake store answers like the real one: with the revision and body
// current when each load began (tests/changes-store-contract.test.ts checks that).
import assert from "node:assert/strict";
import test from "node:test";
import type { DiffHunk } from "../.pi/extensions/lib/changes/types.ts";
import { file, flush, harness, hunk, textBody } from "./diff-actions-fakes.ts";

const OUTDATED =
  "Notes on the current diff:\n- @a.ts lines 3-4 (outdated: that hunk has changed since the note): check\n";

function at(original: DiffHunk, line: number): DiffHunk {
  return { ...original, newStart: line, oldStart: line, header: `@@ -${line},1 +${line},2 @@` };
}

async function withNote() {
  const h = harness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("focus");
  assert.ok(h.tui.paneFocused(), "the pane has focus");
  const original = hunk("h-a", 3, [" keep", "+added"]);
  const store = h.store();
  store.bodies.set("a.ts", textBody("a.ts", [original]));
  store.ready(1, [file("a.ts")]);
  h.tui.input("n");
  await flush();
  h.tui.input("c");
  h.tui.type("check");
  h.tui.input("\r");
  assert.equal(h.probe.session()?.notes?.notes.length, 1);
  store.holdLoads = true;
  store.held.length = 0;
  /** Move the store to `revision` with the hunk at `line`. */
  const move = (revision: number, line: number) => {
    store.bodies.set("a.ts", textBody("a.ts", [at(original, line)]));
    store.ready(revision, [file("a.ts")]);
  };
  /** Release the oldest load the send is waiting on, once it has begun. */
  const release = async () => {
    await flush();
    const index = store.held.findIndex((entry) => entry.path === "a.ts");
    assert.ok(index >= 0, "a load is waiting");
    const [entry] = store.held.splice(index, 1);
    entry?.release();
    await flush();
  };
  const sendLoads = () => store.loads.length;
  h.editor.text = "";
  return { h, store, move, release, sendLoads };
}

test("a second move during the retry sends the note outdated", async () => {
  const { h, store, move, release } = await withNote();
  const sent = h.run("notes send");
  await flush();
  move(2, 20);
  await release(); // revision 1's body
  move(3, 30);
  // Release everything still waiting: the send's revision-2 load and the view's loads.
  while (store.held.length > 0) await release();
  await sent;
  assert.equal(h.editor.text, OUTDATED);
});

test("one move during the send: the retry's body of the current snapshot is used", async () => {
  const { h, store, move, release } = await withNote();
  const sent = h.run("notes send");
  await flush();
  move(2, 10);
  await release();
  while (store.held.length > 0) await release();
  await sent;
  assert.equal(h.editor.text, "Notes on the current diff:\n- @a.ts lines 10-11: check\n");
});

test("no move: the note goes with its current range and one load", async () => {
  const { h, store, release, sendLoads } = await withNote();
  const before = sendLoads();
  const sent = h.run("notes send");
  await release();
  while (store.held.length > 0) await release();
  await sent;
  assert.equal(sendLoads() - before, 1);
  assert.equal(h.editor.text, "Notes on the current diff:\n- @a.ts lines 3-4: check\n");
});
