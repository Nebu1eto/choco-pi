import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireContract, UsageError } from "./contract.ts";
import { exists, samePath } from "./provision.ts";
import { uninstall } from "./uninstall.ts";

function isMissingPackage(error: Error): boolean {
  return (
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.startsWith("Cannot find package ")
  );
}

async function withoutDependencies(argv: readonly string[], reason: string): Promise<number> {
  const [first, verb, ...rest] = argv;
  const purge = rest.length === 1 && rest[0] === "--purge";
  if (first !== "self" || verb !== "uninstall" || (rest.length > 0 && !purge)) {
    process.stderr.write(
      `choco-pi: the app's dependencies are missing (${reason}); re-run install.sh. Only "self uninstall [--purge]" works without them.\n`,
    );
    return 1;
  }
  try {
    const { home, launcher } = requireContract();
    if (await exists(path.join(home, "install.json")))
      throw new Error(
        `reading ${home}/install.json needs the app's dependencies; re-run install.sh first`,
      );
    await uninstall({
      home,
      launcher,
      manifest: null,
      purge,
      log: {
        info: (line) => process.stdout.write(`${line}\n`),
        warn: (line) => process.stderr.write(`warning: ${line}\n`),
      },
    });
    return 0;
  } catch (error) {
    process.stderr.write(`choco-pi: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let cli: typeof import("./cli.ts");
  try {
    cli = await import("./cli.ts");
  } catch (error) {
    if (!(error instanceof Error) || !isMissingPackage(error)) throw error;
    return withoutDependencies(argv, error.message.split("\n")[0] ?? error.message);
  }
  return cli.main(argv);
}

if (process.argv[1] && (await samePath(process.argv[1], fileURLToPath(import.meta.url)))) {
  process.exitCode = await main(process.argv.slice(2));
}
