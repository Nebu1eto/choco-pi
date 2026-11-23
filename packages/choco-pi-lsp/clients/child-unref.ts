import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

export function unrefChildAndPipes(child: ChildProcess): void {
  try {
    child.unref();
    for (const stream of [child.stdout, child.stderr, child.stdin]) {
      if (stream && "unref" in stream && stream.unref instanceof Function) stream.unref();
    }
  } catch {}
}

export function spawnCollectStdout(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = nodeSpawn(command, args, options);
      unrefChildAndPipes(child);
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.once("error", () => settle(""));
      child.once("close", () => settle(out));
    } catch {
      settle("");
    }
  });
}
