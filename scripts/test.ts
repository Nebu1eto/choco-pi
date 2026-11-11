/**
 * `pnpm test`: the repository's tests under `node --test`.
 *
 * The tests of the formal-verify scripts (`tests/formal/`) start Java and TLC
 * and are the slowest files of the suite, and only a change to `formal/`, to
 * the formal-verify skill or to those tests can break them. They run only
 * with `--formal`. Every other argument goes to `node --test` unchanged.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Patterns `node --test` expands itself, relative to the repository root. */
export const DEFAULT_TESTS = ["tests/*.test.ts", ".pi/packages/*/tests/*.test.ts"];
export const FORMAL_TESTS = ["tests/formal/*.test.ts"];
export const FORMAL_FLAG = "--formal";
export const FORMAL_NOTICE = `The formal validation tests (${FORMAL_TESTS.join(", ")}) were not run; \`pnpm test ${FORMAL_FLAG}\` includes them.`;

/** What `pnpm test <args>` runs. */
export type TestCommand = {
  /** Arguments for `node`. */
  args: string[];
  /** Whether the formal validation tests are among them. */
  formal: boolean;
};

/** The command for `pnpm test <args>`: `--formal` adds the formal tests and is not passed on. */
export function testCommand(args: readonly string[]): TestCommand {
  const formal = args.includes(FORMAL_FLAG);
  const passed = args.filter((arg) => arg !== FORMAL_FLAG);
  const patterns = formal ? [...DEFAULT_TESTS, ...FORMAL_TESTS] : DEFAULT_TESTS;
  return { formal, args: ["--test", ...passed, ...patterns] };
}

/** Run the tests from `root` and resolve with the exit code `pnpm test` should have. */
export async function runTests(root: string, args: readonly string[]): Promise<number> {
  const command = testCommand(args);
  const child = spawn(process.execPath, command.args, { cwd: root, stdio: "inherit" });
  // A signal sent to this process alone (a watchdog's kill) must stop the tests too.
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (!command.formal) process.stdout.write(`${FORMAL_NOTICE}\n`);
    return code;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = await runTests(root, process.argv.slice(2));
}
