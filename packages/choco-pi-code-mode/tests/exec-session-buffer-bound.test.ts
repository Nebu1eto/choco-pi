import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { compile, nul, num, obj, union } from "@earendil-works/pi-schema";

const isProbeReport = compile(
  obj({
    exit_code: union([num(), nul()]),
    output_length: num(),
    original_token_count: num(),
    live_max_mb: num(),
    retained_mb: num(),
  }),
).check;

test("a large pipe producer leaves the host heap bounded and the count intact", async () => {
  const megabytes = 64;
  const probe = fileURLToPath(new URL("./exec-heap-probe.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", probe, String(megabytes)],
    { cwd: process.cwd(), timeout: 120_000 },
  );
  const report: unknown = JSON.parse(stdout);
  assert.ok(isProbeReport(report), `unexpected probe output: ${stdout}`);
  assert.equal(report.exit_code, 0);
  assert.ok(report.output_length <= 4_000 + 200, "reader gets only the requested tail");
  assert.ok(
    report.original_token_count >= (megabytes * 1024 * 1024) / 4 / 1.1,
    "the dropped head is still counted",
  );
  assert.ok(
    report.live_max_mb < 48,
    `live heap grew by ${Math.round(report.live_max_mb)} MB for a ${megabytes} MB producer`,
  );
  assert.ok(
    report.retained_mb < 32,
    `${Math.round(report.retained_mb)} MB stayed reachable after the producer finished`,
  );
});
