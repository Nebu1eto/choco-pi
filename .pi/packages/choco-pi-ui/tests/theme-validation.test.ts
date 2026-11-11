import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateThemeJson } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.js";

const themeDirectory = new URL("../themes/", import.meta.url);
const piPackage = new URL(
  "../../../../node_modules/@earendil-works/pi-coding-agent/package.json",
  import.meta.url,
);

test("every Nord theme passes Pi 1.5 theme validation", async () => {
  // The SDK range is ~1.5.2: any stable 1.5 patch release from 1.5.2.
  assert.match(await readFile(piPackage, "utf8"), /^\s*"version": "1\.5\.([2-9]|[1-9]\d+)",?$/m);

  const files = (await readdir(themeDirectory)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "expected at least one Nord theme");
  for (const file of files) {
    const document: unknown = JSON.parse(await readFile(new URL(file, themeDirectory), "utf8"));
    assert.doesNotThrow(() => validateThemeJson(file, document), file);
  }
});
