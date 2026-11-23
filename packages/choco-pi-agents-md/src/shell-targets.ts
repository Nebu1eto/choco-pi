import fs from "node:fs";
import { resolvePath } from "./paths.ts";

const DISCOVERY_COMMANDS = new Set([
  "ls",
  "find",
  "rg",
  "grep",
  "fd",
  "tree",
  "cat",
  "sed",
  "head",
  "tail",
]);

const PATTERN_FIRST_COMMANDS = new Set(["rg", "grep"]);

const FILE_OPERAND_COMMANDS = new Set(["cat", "head", "tail"]);

function tokenize(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      if (current) {
        parts.push(current);
        current = "";
      }
      parts.push(";");
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}

export function isDiscoveryShellCommand(value: string): boolean {
  const parts = tokenize(value);
  let segmentStart = 0;
  for (let index = 0; index <= parts.length; index += 1) {
    if (index < parts.length && parts[index] !== ";") continue;
    const segment = parts.slice(segmentStart, index);
    const command = segment[0]?.toLowerCase();
    if (command && DISCOVERY_COMMANDS.has(command)) {
      if (!FILE_OPERAND_COMMANDS.has(command)) return true;
      if (segment.slice(1).some((argument) => !argument.startsWith("-") && !argument.includes("=")))
        return true;
    }
    segmentStart = index + 1;
  }
  return false;
}

export function shellTargets(value: string, base: string): string[] {
  const parts = tokenize(value);
  if (!parts.length) return [base];
  const paths: string[] = [];
  let cwd = base;
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (item === ";") continue;
    if (item === "cd") {
      const next = parts[index + 1];
      if (next) cwd = resolvePath(next, cwd);
      index += 1;
      continue;
    }
    if (!DISCOVERY_COMMANDS.has(item.toLowerCase())) continue;
    const skipFirstPathLikeToken = PATTERN_FIRST_COMMANDS.has(item.toLowerCase());
    let skipNext = skipFirstPathLikeToken;
    let foundPath = false;
    let cursor = index + 1;
    while (cursor < parts.length && parts[cursor] !== ";") {
      const arg = parts[cursor];
      cursor += 1;
      if (!arg || arg.startsWith("-") || arg.includes("=")) continue;
      if (skipNext) {
        skipNext = false;
        continue;
      }
      const resolved = resolvePath(arg, cwd);
      if (fs.existsSync(resolved)) {
        paths.push(resolved);
        foundPath = true;
      }
    }
    if (!foundPath) paths.push(cwd);
    index = cursor - 1;
  }
  return paths.length ? paths : [cwd];
}
