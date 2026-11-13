#!/usr/bin/env node

const [, entryPath = "choco-pi-acp", command, ...arguments_] = process.argv;

if (command === "zed") {
  const { runZedSetupCli } = await import("../src/zed/setup.ts");
  process.exitCode = await runZedSetupCli(arguments_, { adapterPath: entryPath });
} else {
  await import("../src/index.ts");
}
