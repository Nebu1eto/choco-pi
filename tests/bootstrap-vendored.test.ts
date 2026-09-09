import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bootstrap, installOne, VENDORED, type Runner } from "../scripts/bootstrap-vendored.ts";

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendored-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function tree(root: string, value: string) {
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "marker"), value);
}

async function marker(root: string) {
  return readFile(path.join(root, "node_modules", "marker"), "utf8");
}

const fs = { lstat, mkdir, readdir, rename, rm };

test("first successful install leaves only its new modules", async (t) => {
  const root = await fixture(t);
  await installOne(root, async () => {
    await tree(root, "new");
    return "";
  });
  assert.equal(await marker(root), "new");
  assert.deepEqual(await readdir(root), ["node_modules"]);
});

test("interrupted claim is preserved without starting a child", async (t) => {
  const root = await fixture(t);
  await tree(root, "prior");
  const claim = path.join(root, "node_modules.bootstrap-lock");
  await mkdir(claim);
  await writeFile(path.join(claim, "marker"), "unknown owner");
  await assert.rejects(
    installOne(root, async () => assert.fail("must not spawn")),
    /Cannot claim/,
  );
  assert.equal(await marker(root), "prior");
  assert.equal(await readFile(path.join(claim, "marker"), "utf8"), "unknown owner");
});

for (const failure of ["spawn", "nonzero", "partial", "missing-after-success"]) {
  test(`restores prior modules after ${failure}`, async (t) => {
    const root = await fixture(t);
    await tree(root, "prior");
    const runner: Runner = async () => {
      if (failure === "partial") await tree(root, "partial");
      if (failure !== "missing-after-success") throw new Error(failure);
      return "";
    };
    await assert.rejects(
      installOne(root, runner),
      failure === "missing-after-success" ? /absent/ : new RegExp(failure),
    );
    assert.equal(await marker(root), "prior");
    assert.deepEqual(await readdir(root), ["node_modules"]);
  });
}

test("successful install uses only frozen install flags and deletes its own backup", async (t) => {
  const root = await fixture(t);
  await tree(root, "prior");
  await installOne(root, async (args, cwd) => {
    assert.equal(cwd, root);
    assert.deepEqual(args, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    const backups = (await readdir(root)).filter((name) =>
      name.startsWith("node_modules.bootstrap-backup-"),
    );
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(root, backups[0]!, "marker"), "utf8"), "prior");
    await tree(root, "new");
    return "";
  });
  assert.equal(await marker(root), "new");
  assert.deepEqual(await readdir(root), ["node_modules"]);
});

for (const partial of [false, true]) {
  test(`failed first install restores absence (partial=${partial})`, async (t) => {
    const root = await fixture(t);
    await assert.rejects(
      installOne(root, async () => {
        if (partial) await tree(root, "partial");
        throw new Error("failed");
      }),
      /failed/,
    );
    assert.deepEqual(await readdir(root), []);
  });
}

for (const backup of ["node_modules.bootstrap-backup", "node_modules.bootstrap-backup-unknown"]) {
  test(`refuses untouched unknown backup ${backup}`, async (t) => {
    const root = await fixture(t);
    await tree(root, "prior");
    await mkdir(path.join(root, backup));
    await writeFile(path.join(root, backup, "marker"), "recovery");
    await assert.rejects(
      installOne(root, async () => assert.fail("must not spawn")),
      /Recovery required/,
    );
    assert.equal(await marker(root), "prior");
    assert.equal(await readFile(path.join(root, backup, "marker"), "utf8"), "recovery");
    assert.deepEqual((await readdir(root)).sort(), ["node_modules", backup].sort());
  });
}

test("concurrent attempt cannot mutate while first runner is unsettled", async (t) => {
  const root = await fixture(t);
  await tree(root, "prior");
  const entered = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<string>();
  const first = installOne(root, async () => {
    await tree(root, "partial");
    entered.resolve();
    return exit.promise;
  });
  const failed = assert.rejects(first, /child exited/);
  await entered.promise;
  try {
    await assert.rejects(
      installOne(root, async () => assert.fail("must not spawn")),
      /Cannot claim/,
    );
    assert.equal(await marker(root), "partial");
  } finally {
    exit.reject(new Error("child exited"));
    await failed;
  }
  assert.equal(await marker(root), "prior");
});

for (const stage of ["remove", "restore"]) {
  test(`rollback ${stage} failure retains backup and reports both failures`, async (t) => {
    const root = await fixture(t);
    await tree(root, "prior");
    await assert.rejects(
      installOne(
        root,
        async () => {
          await tree(root, "partial");
          throw new Error("install error");
        },
        {
          ...fs,
          rm: async (target, options) => {
            if (stage === "remove" && target === path.join(root, "node_modules"))
              throw new Error("remove error");
            await rm(target, options);
          },
          rename: async (source, target) => {
            if (stage === "restore" && source.toString().includes("bootstrap-backup"))
              throw new Error("restore error");
            await rename(source, target);
          },
        },
      ),
      (error: Error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /install error/);
        assert.match(error.message, new RegExp(`${stage} error`));
        return true;
      },
    );
    const entries = await readdir(root);
    assert.ok(entries.includes("node_modules.bootstrap-lock"));
    const backup = entries.find((name) => name.startsWith("node_modules.bootstrap-backup-"));
    assert.ok(backup);
    assert.equal(await readFile(path.join(root, backup, "marker"), "utf8"), "prior");
  });
}

test("failure moving original tree never removes it or starts the installer", async (t) => {
  const root = await fixture(t);
  await tree(root, "prior");
  await assert.rejects(
    installOne(root, async () => assert.fail("must not spawn"), {
      ...fs,
      rename: async () => {
        throw new Error("cannot move");
      },
    }),
    /cannot move/,
  );
  assert.equal(await marker(root), "prior");
  assert.deepEqual(await readdir(root), ["node_modules"]);
});

test("backup cleanup failure preserves successful new tree", async (t) => {
  const root = await fixture(t);
  await tree(root, "prior");
  await assert.rejects(
    installOne(
      root,
      async () => {
        await tree(root, "new");
        return "";
      },
      {
        ...fs,
        rm: async (target, options) => {
          if (target.toString().includes("bootstrap-backup"))
            throw new Error("backup cleanup error");
          await rm(target, options);
        },
      },
    ),
    /backup cleanup error/,
  );
  assert.equal(await marker(root), "new");
  assert.equal((await readdir(root)).filter((name) => name.includes("bootstrap-backup")).length, 1);
});

async function workspace(root: string) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.11.0" }),
  );
  for (const dir of VENDORED) await tree(path.join(root, dir), "prior");
}

for (const manifest of [
  "{",
  "null",
  "{}",
  "[]",
  "42",
  "true",
  '"pnpm@11.11.0"',
  '{"packageManager":null}',
  '{"packageManager":42}',
  '{"packageManager":true}',
  '{"packageManager":["pnpm@11.11.0"]}',
  '{"packageManager":{}}',
  '{"packageManager":"pnpm@^11.11.0"}',
  '{"packageManager":"pnpm@11.11.0-beta.1"}',
  '{"packageManager":"npm@11.11.0"}',
]) {
  test(`invalid manifest fails before spawn: ${manifest}`, async (t) => {
    const root = await fixture(t);
    await workspace(root);
    await writeFile(path.join(root, "package.json"), manifest);
    await assert.rejects(
      bootstrap(root, async () => assert.fail("must not spawn")),
      /package.json/,
    );
    for (const dir of VENDORED) {
      assert.equal(await marker(path.join(root, dir)), "prior");
      assert.deepEqual(await readdir(path.join(root, dir)), ["node_modules"]);
    }
  });
}

test("exact pin comes from the selected root manifest", async (t) => {
  const root = await fixture(t);
  await workspace(root);
  await writeFile(path.join(root, "package.json"), '{"packageManager":"pnpm@10.9.8"}');
  await bootstrap(
    root,
    async (args, cwd) => {
      if (args[0] === "--version") return "10.9.8\n";
      await tree(cwd, "selected pin");
      return "";
    },
    () => {},
  );
  for (const dir of VENDORED) assert.equal(await marker(path.join(root, dir)), "selected pin");
});

for (const version of ["11.10.0", "11.11.1", "12.0.0"]) {
  test(`exact version preflight rejects ${version} before any tree mutation`, async (t) => {
    const root = await fixture(t);
    await workspace(root);
    await assert.rejects(
      bootstrap(root, async (args, cwd) => {
        assert.deepEqual(args, ["--version"]);
        assert.equal(cwd, root);
        return version;
      }),
      /Expected pnpm 11.11.0/,
    );
    for (const dir of VENDORED) {
      assert.equal(await marker(path.join(root, dir)), "prior");
      assert.deepEqual(await readdir(path.join(root, dir)), ["node_modules"]);
    }
  });
}

test("version spawn failure leaves all packages untouched", async (t) => {
  const root = await fixture(t);
  await workspace(root);
  await assert.rejects(
    bootstrap(root, async () => {
      throw new Error("pnpm unavailable");
    }),
    /pnpm unavailable/,
  );
  for (const dir of VENDORED)
    assert.deepEqual(await readdir(path.join(root, dir)), ["node_modules"]);
});

for (const failing of [false, true]) {
  test(`bootstrap visits all six packages and aggregates failures=${failing}`, async (t) => {
    const root = await fixture(t);
    await workspace(root);
    const visited: string[] = [];
    const runner: Runner = async (args, cwd) => {
      if (args[0] === "--version") return "11.11.0\n";
      assert.deepEqual(args, ["install", "--frozen-lockfile", "--ignore-scripts"]);
      visited.push(cwd);
      await tree(cwd, "new");
      if (failing && visited.length <= 2) throw new Error(`failure ${visited.length}`);
      return "";
    };
    const result = bootstrap(root, runner, () => {});
    if (failing) {
      await assert.rejects(result, (error: Error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.message, /failure 1/);
        assert.match(error.message, /failure 2/);
        return true;
      });
    } else await result;
    assert.deepEqual(
      visited,
      VENDORED.map((dir) => path.join(root, dir)),
    );
    for (const [index, dir] of VENDORED.entries()) {
      assert.equal(await marker(path.join(root, dir)), failing && index < 2 ? "prior" : "new");
    }
  });
}
