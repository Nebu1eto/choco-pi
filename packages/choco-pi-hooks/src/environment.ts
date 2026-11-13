import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

export function hookEnvironmentFile(sessionId: string): string {
  const directory = path.join(os.tmpdir(), "choco-pi-hooks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_")}.env`);
}

export function applyHookEnvironment(file: string): void {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const normalized = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*export\s+/, ""))
    .join("\n");
  for (const [name, value] of Object.entries(parseEnv(normalized))) process.env[name] = value;
}

export function removeHookEnvironment(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}
