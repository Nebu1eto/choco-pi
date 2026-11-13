import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LENS_FLAGS } from "../clients/lsp-flag-registry.ts";

interface RegistrationManifest {
  flags: Array<{ name: string }>;
}

test("registration manifest and LENS_FLAGS contain the same flag names", async () => {
  const contents = await readFile(
    new URL("../registration-manifest.json", import.meta.url),
    "utf-8",
  );
  // SAFETY: This vendored fixture is consumed through the same flags-only manifest boundary exercised by the assertions below.
  const manifest = JSON.parse(contents) as RegistrationManifest;
  const registryNames = LENS_FLAGS.map((flag) => flag.name).sort();
  const manifestNames = manifest.flags.map((flag) => flag.name).sort();

  assert.deepEqual(manifestNames, registryNames);
});
