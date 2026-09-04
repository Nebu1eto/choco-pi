import test from "node:test";
import assert from "node:assert/strict";
import {
  expandSlashCommand,
  type FileSlashCommand,
  parseCommandArgs,
  substituteArgs,
  toAvailableCommands,
} from "../src/acp/slash-commands.ts";

test("parseCommandArgs: handles quotes", () => {
  assert.deepEqual(parseCommandArgs("a b"), ["a", "b"]);
  assert.deepEqual(parseCommandArgs("'a b' c"), ["a b", "c"]);
  assert.deepEqual(parseCommandArgs('"a b" c'), ["a b", "c"]);
});

test("substituteArgs: replaces $1.. and $@", () => {
  assert.equal(
    substituteArgs("x=$1 y=$2 all=$@", ["one", "two"]).trim(),
    "x=one y=two all=one two",
  );
  assert.equal(substituteArgs("$3", ["one"]).trim(), "");
});

test("expandSlashCommand: expands known command", () => {
  const cmds: FileSlashCommand[] = [
    { name: "hello", description: "(user)", content: "Say hi to $1", source: "(user)" },
  ];

  assert.equal(expandSlashCommand("/hello world", cmds), "Say hi to world");
  assert.equal(expandSlashCommand("/unknown world", cmds), "/unknown world");
  assert.equal(expandSlashCommand("not a command", cmds), "not a command");
});

test("toAvailableCommands: de-dupes by name (first wins)", () => {
  const cmds: FileSlashCommand[] = [
    { name: "x", description: "first", content: "1", source: "(user)" },
    { name: "x", description: "second", content: "2", source: "(project)" },
  ];

  assert.deepEqual(toAvailableCommands(cmds), [{ name: "x", description: "first" }]);
});
