/**
 * A Node `--import` hook for tests: records each fs call whose first two
 * arguments name a path under FS_TRACE_ROOT, as one "<call> <path>" line
 * appended to FS_TRACE_LOG. It wraps node:fs (callback and sync forms) and
 * node:fs/promises, then syncs the ESM named exports, so a module that
 * imported `{ readFile }` calls the wrapper too. Lines are appended
 * asynchronously and in order; a process that ends through process.exit()
 * can drop its last lines, so trace processes that end normally.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

import { isString, type RuntimeValue } from "../../profile/extensions/lib/runtime-values.ts";

type TracedModule = typeof fs | typeof fsPromises;

const CALLS = new Set([
  "access",
  "appendFile",
  "chmod",
  "copyFile",
  "cp",
  "createReadStream",
  "createWriteStream",
  "exists",
  "lstat",
  "mkdir",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "watch",
  "watchFile",
  "writeFile",
]);

function pathText(argument: RuntimeValue): string | null {
  if (isString(argument)) return argument;
  if (argument instanceof URL)
    return argument.protocol === "file:" ? fileURLToPath(argument) : null;
  if (Buffer.isBuffer(argument)) return argument.toString();
  return null;
}

function install(root: string, log: string): void {
  const append = fsPromises.appendFile;
  let pending = Promise.resolve();
  const record = (call: string, args: readonly RuntimeValue[]) => {
    for (const argument of args.slice(0, 2)) {
      const file = pathText(argument);
      if (file === null || (file !== root && !file.startsWith(`${root}/`))) continue;
      const line = `${call} ${file}\n`;
      pending = pending.then(() => append(log, line)).catch(() => undefined);
    }
  };
  const wrapAll = (target: TracedModule, label: (name: string) => string | null) => {
    for (const [name, original] of Object.entries(target)) {
      const traced = label(name);
      if (traced === null || !(original instanceof Function)) continue;
      const wrapped = (...args: RuntimeValue[]): RuntimeValue => {
        record(traced, args);
        return original.apply(target, args);
      };
      Object.assign(wrapped, original);
      Object.defineProperty(target, name, { value: wrapped, writable: true, configurable: true });
    }
  };
  wrapAll(fs, (name) => (CALLS.has(name) || CALLS.has(name.replace(/Sync$/, "")) ? name : null));
  wrapAll(fsPromises, (name) => (CALLS.has(name) ? `promises.${name}` : null));
  syncBuiltinESMExports();
}

const root = process.env.FS_TRACE_ROOT;
const log = process.env.FS_TRACE_LOG;
if (root !== undefined && log !== undefined) install(root, log);
