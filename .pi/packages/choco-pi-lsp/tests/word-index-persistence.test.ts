import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  deserializeWordIndex,
  serializeWordIndex,
  type SerializedWordIndex,
  type WordIndex,
} from "../clients/word-index.ts";
import { PathKeyedMap } from "../clients/path-keyed-map.ts";

function realisticIndex(fileCount = 1_000, tokenCount = 8_000): WordIndex {
  const files = Array.from({ length: fileCount }, (_, index) => `/repo/src/file-${index}.ts`);
  const docLengths = new PathKeyedMap<number>((value) => value);
  const fileMtimes = new PathKeyedMap<number>((value) => value);
  const fileSizes = new PathKeyedMap<number>((value) => value);
  const forward = new PathKeyedMap<Map<string, number>>((value) => value);
  for (const [index, file] of files.entries()) {
    docLengths.set(file, 24);
    fileMtimes.set(file, 1_700_000_000_000 + index);
    fileSizes.set(file, 1_024 + index);
    forward.set(file, new Map([[`token${index % tokenCount}`, 1]]));
  }
  return {
    postings: new Map(
      Array.from({ length: tokenCount }, (_, token) => [
        `token${token}`,
        Array.from({ length: 12 }, (__, hit) => ({
          file: files[(token * 13 + hit) % files.length],
          line: hit + 1,
        })),
      ]),
    ),
    docLengths,
    totalTokens: tokenCount * 12,
    docCount: fileCount,
    truncated: false,
    forward,
    fileMtimes,
    fileSizes,
  };
}

test("round-trips word-index semantics", () => {
  const serialized = serializeWordIndex(realisticIndex(20, 80));
  const hydrated = deserializeWordIndex(serialized);
  assert.ok(hydrated);
  assert.deepEqual(serializeWordIndex(hydrated), serialized);
});

test("returns the rebuild sentinel for stale and corrupt snapshots", () => {
  const valid = serializeWordIndex(realisticIndex(4, 8));
  const stale = structuredClone(valid);
  Object.defineProperty(stale, "version", { value: 1 });
  assert.equal(deserializeWordIndex(stale), null);

  const corruptCases: SerializedWordIndex[] = [
    { ...valid, docLengths: valid.docLengths.slice(1) },
    { ...valid, postings: [["broken", [999, 1]]] },
    { ...valid, postings: [["broken", [0]]] },
    { ...valid, forward: [[999, [["token", 1]]]] },
    { ...valid, fileSizes: [1] },
    { ...valid, totalTokens: Number.NaN },
  ];
  for (const corrupt of corruptCases) assert.equal(deserializeWordIndex(corrupt), null);
});

test("hydrates a realistic snapshot well under 30ms", (context) => {
  const serialized: SerializedWordIndex = serializeWordIndex(realisticIndex());
  const size = Buffer.byteLength(JSON.stringify(serialized));
  deserializeWordIndex(serialized); // Warm module/JIT effects out of the measured call.
  const started = performance.now();
  const hydrated = deserializeWordIndex(serialized);
  const elapsed = performance.now() - started;
  assert.ok(hydrated);
  assert.ok(size > 500_000, `benchmark fixture is only ${size} bytes`);
  assert.ok(elapsed < 30, `deserialized ${size} bytes in ${elapsed.toFixed(1)}ms`);
  context.diagnostic(`deserialized ${size} bytes in ${elapsed.toFixed(1)}ms`);
});
