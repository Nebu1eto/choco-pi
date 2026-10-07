import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateThemeJson } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js";

const themeDirectory = new URL("../themes/", import.meta.url);
const piPackage = new URL(
  "../../../../node_modules/@earendil-works/pi-coding-agent/package.json",
  import.meta.url,
);

test("every Nord theme passes Pi 1.0.4 theme validation", async () => {
  assert.match(await readFile(piPackage, "utf8"), /^\s*"version": "1\.0\.4",?$/m);

  const files = (await readdir(themeDirectory)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "expected at least one Nord theme");
  for (const file of files) {
    const document: unknown = JSON.parse(await readFile(new URL(file, themeDirectory), "utf8"));
    assert.doesNotThrow(() => validateThemeJson(file, document), file);
  }
});
