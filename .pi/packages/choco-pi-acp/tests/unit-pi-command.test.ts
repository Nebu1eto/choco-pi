import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPiCommand,
  resolvePiLaunch,
  shouldUseShellForPiCommand,
} from "../src/pi-rpc/command.ts";

test("defaultPiCommand: uses the shell-independent pi name", () => {
  const originalPlatform = process.platform;

  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.equal(defaultPiCommand(), "pi");

    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.equal(defaultPiCommand(), "pi");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("shouldUseShellForPiCommand: never enables shell interpolation", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });

  try {
    assert.equal(shouldUseShellForPiCommand("pi.cmd"), false);
    assert.equal(shouldUseShellForPiCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\pi.CMD"), false);
    assert.equal(shouldUseShellForPiCommand("pi.bat"), false);
    assert.equal(shouldUseShellForPiCommand("pi"), false);
    assert.equal(shouldUseShellForPiCommand("C:\\tools\\pi.exe"), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("resolvePiLaunch: resolves an exact executable from PATH without a shell", () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-command-"));
  const bin = join(root, "bin with spaces");
  const executable = join(bin, "pi");
  mkdirSync(bin);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);

  assert.deepEqual(resolvePiLaunch(undefined, { PATH: bin }, "darwin"), {
    command: executable,
    argsPrefix: [],
  });
});

test("shouldUseShellForPiCommand: keeps shell disabled on non-Windows", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });

  try {
    assert.equal(shouldUseShellForPiCommand("pi.cmd"), false);
    assert.equal(shouldUseShellForPiCommand("pi"), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});
