import assert from "node:assert/strict";
import test from "node:test";

import { BridgeResponseRouter } from "../src/tools/exec/bridge-client.ts";

/** What one registered request was settled with, if anything. */
interface Settled {
  response?: unknown;
  error?: Error;
}

function pending(router: BridgeResponseRouter, requestId: number): Settled {
  const settled: Settled = {};
  router.register(requestId, {
    resolve: (response) => {
      settled.response = response;
    },
    reject: (error) => {
      settled.error = error;
    },
  });
  return settled;
}

test("a response split across chunks, even inside a multi-byte character, settles once complete", () => {
  const router = new BridgeResponseRouter();
  const one = pending(router, 1);
  const line = Buffer.from('{"request_id":1,"ok":true,"result":"\u00e9t\u00e9"}\n');
  const split = line.indexOf(0xc3) + 1; // inside the two-byte é
  router.push(line.subarray(0, split));
  assert.deepEqual(one, {});
  assert.equal(router.responded, false);
  router.push(line.subarray(split));
  assert.deepEqual(one.response, { request_id: 1, ok: true, result: "\u00e9t\u00e9" });
  assert.equal(router.responded, true);
});

test("log lines, unknown ids and late duplicates are ignored", () => {
  const router = new BridgeResponseRouter();
  const one = pending(router, 1);
  router.push(Buffer.from('starting\n{"request_id":9,"ok":true}\n\n{"request_id":1,"ok":true}\n'));
  assert.deepEqual(one.response, { request_id: 1, ok: true });
  router.push(Buffer.from('{"request_id":1,"ok":false,"error":"late"}\n'));
  assert.deepEqual(one.response, { request_id: 1, ok: true });
  assert.equal(one.error, undefined);
});

test("a known id with an invalid envelope rejects that request", () => {
  const router = new BridgeResponseRouter();
  const one = pending(router, 1);
  router.push(Buffer.from('{"request_id":1,"ok":"yes"}\n'));
  assert.match(String(one.error), /invalid response/);
});

test("close drops a trailing partial line, and rejectAll settles what is left", () => {
  const router = new BridgeResponseRouter();
  const one = pending(router, 1);
  const two = pending(router, 2);
  router.forget(2);
  router.push(Buffer.from('{"request_id":1,"ok":true}'));
  router.close();
  router.push(Buffer.from("\n"));
  assert.deepEqual(one, {});
  router.rejectAll(new Error("exec_bridge closed"));
  assert.match(String(one.error), /exec_bridge closed/);
  assert.deepEqual(two, {});
});
