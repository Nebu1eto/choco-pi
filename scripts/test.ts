import { spawn } from "node:child_process";
import { getPriority, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TESTS = ["tests/*.test.ts", "packages/*/tests/*.test.ts"];
export const FORMAL_TESTS = ["tests/formal/*.test.ts"];
export const FORMAL_FLAG = "--formal";
export const FORMAL_NOTICE = `The formal validation tests (${FORMAL_TESTS.join(", ")}) were not run; \`pnpm test ${FORMAL_FLAG}\` includes them.`;

export const TEST_NICENESS = 10;
export const NICENESS_ENV = "CHOCO_PI_TEST_NICE";

export function testNiceness(current: number, requested: string | undefined): number | undefined {
  const target = requested === undefined || requested === "" ? TEST_NICENESS : Number(requested);
  if (!Number.isInteger(target) || target < 0 || target > 19) {
    throw new Error(`${NICENESS_ENV} must be an integer from 0 to 19, got ${requested}`);
  }
  return target > current ? target : undefined;
}

export type TestCommand = {
  args: string[];
  formal: boolean;
};

export function testCommand(args: readonly string[]): TestCommand {
  const formal = args.includes(FORMAL_FLAG);
  const passed = args.filter((arg) => arg !== FORMAL_FLAG);
  const patterns = formal ? [...DEFAULT_TESTS, ...FORMAL_TESTS] : DEFAULT_TESTS;
  return { formal, args: ["--test", ...passed, ...patterns] };
}

export async function runTests(root: string, args: readonly string[]): Promise<number> {
  const command = testCommand(args);
  const child = spawn(process.execPath, command.args, { cwd: root, stdio: "inherit" });
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
  const niceness = testNiceness(getPriority(), process.env[NICENESS_ENV]);
  if (niceness !== undefined) setPriority(niceness);
  process.exitCode = await runTests(root, process.argv.slice(2));
}
