import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("concurrent processes publish one complete zentui build", async () => {
  const cacheParent = path.resolve(repositoryRoot, "node_modules/.cache");
  await mkdir(cacheParent, { recursive: true });
  const cacheRoot = await mkdtemp(path.join(cacheParent, "choco-pi-zentui-race-"));
  const helperUrl = pathToFileURL(path.resolve(repositoryRoot, "tests/zentui-build.ts")).href;
  const childScript = `
    const helper = await import(${JSON.stringify(helperUrl)});
    if (!helper.ZENTUI_BUILD) throw new Error(helper.SKIP_WITHOUT_ZENTUI);
    await helper.loadZentuiModule("footer.js");
  `;

  try {
    await Promise.all(
      Array.from(
        { length: 6 },
        async () =>
          await execFileAsync(process.execPath, ["--input-type=module", "--eval", childScript], {
            cwd: repositoryRoot,
            env: { ...process.env, CHOCO_PI_ZENTUI_CACHE_ROOT: cacheRoot },
          }),
      ),
    );
    const entries = await readdir(cacheRoot);
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0], /\.tmp-/);
  } finally {
    await rm(cacheRoot, { force: true, recursive: true });
  }
});
