import { Script } from "node:vm";

import type { CodeModeExecutionKind } from "./shared-runtime.ts";
import { maskJavaScriptCommentsAndStrings } from "./tool-source.ts";

export interface CodeModeSourcePreflightOptions {
  mode: CodeModeExecutionKind;
  availableToolNames: readonly string[];
  outsideToolNames?: readonly string[] | undefined;
}

interface SourceToken {
  value: string;
  index: number;
  line: number;
}

const RESTRICTED_CAPABILITIES =
  "Restricted code mode is fresh JavaScript with tools, image, generatedImage, store, load, exit, setTimeout, clearTimeout, ALL_TOOLS, text(), notify(), and yield_control(); it has no Deno, console, imports, Node, filesystem/network, or browser globals. Notebook cells instead use persistent Deno TypeScript with console, imports/npm, Deno, and Web APIs.";

const UNAVAILABLE_GLOBALS = new Map<string, string>([
  [
    "Deno",
    "use a bridged Pi tool or tools.exec_command for filesystem and process work; notebook cells DO have Deno",
  ],
  ["console", "use text()/notify() to emit output; notebook cells DO have console"],
  [
    "require",
    "use a bridged Pi tool or tools.exec_command; restricted cells do not load Node modules",
  ],
  [
    "process",
    "use tools.exec_command for process or environment work; restricted cells have no Node globals",
  ],
  ["Buffer", "use a bridged tool for binary work; restricted cells have no Node globals"],
  ["module", "restricted cells have no CommonJS module object"],
  ["exports", "restricted cells have no CommonJS exports object"],
  ["__dirname", "pass an explicit path to a tool; restricted cells have no Node path globals"],
  ["__filename", "pass an explicit path to a tool; restricted cells have no Node path globals"],
  [
    "window",
    "use a bridged browser tool; notebook cells provide Web APIs but restricted cells do not",
  ],
  [
    "document",
    "use a bridged browser tool; notebook cells provide Web APIs but restricted cells do not",
  ],
  [
    "navigator",
    "use a bridged browser tool; notebook cells provide Web APIs but restricted cells do not",
  ],
  [
    "location",
    "use a bridged browser tool; notebook cells provide Web APIs but restricted cells do not",
  ],
  ["fetch", "use a bridged web tool; notebook cells provide Web APIs but restricted cells do not"],
  [
    "WebSocket",
    "use a bridged network tool; notebook cells provide Web APIs but restricted cells do not",
  ],
  [
    "XMLHttpRequest",
    "use a bridged web tool; notebook cells provide Web APIs but restricted cells do not",
  ],
  ["localStorage", "use store/load for cell data or a bridged browser tool"],
  ["sessionStorage", "use store/load for cell data or a bridged browser tool"],
  ["Worker", "use a bridged tool; restricted cells have no browser workers"],
]);

const TOKEN_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*|\?\.|=>|&&|\|\||\?\?|[()[\]{}.,:;=?]/g;
const BINDING_KEYWORDS = new Set(["const", "let", "var", "class"]);

export function preflightCodeModeSource(
  source: string,
  options: CodeModeSourcePreflightOptions,
): void {
  if (options.mode === "code") validateRestrictedJavaScript(source);
  const tokens = tokenizeExecutableSource(source);
  if (options.mode === "code") validateRestrictedGlobals(tokens);
  validateToolCalls(tokens, options);
}

function validateRestrictedJavaScript(source: string): void {
  try {
    new Script(`void (async () => {\n${source}\n})();`, { filename: "code-mode-exec.js" });
  } catch (error) {
    const parsedError = error instanceof Error ? error : new Error(String(error));
    const message = parsedError.message;
    const line = syntaxErrorLine(parsedError);
    throw new Error(
      `Code mode source preflight [invalid_javascript]${line ? ` at line ${line}` : ""}: restricted code mode accepts JavaScript source only; it did not parse (${message}). Check quotes and nested backticks/template interpolation; use String.raw only as a tag (String.raw\`...\`) or move complex text into an ordinary quoted string. ${RESTRICTED_CAPABILITIES}`,
    );
  }
}

function syntaxErrorLine(error: Error): number | undefined {
  if (!error.stack) return undefined;
  const match = /code-mode-exec\.js:(\d+)/.exec(error.stack);
  if (!match) return undefined;
  return Math.max(1, Number(match[1]) - 1);
}

function validateRestrictedGlobals(tokens: readonly SourceToken[]): void {
  const bindings = collectBindings(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const alternative = UNAVAILABLE_GLOBALS.get(token.value);
    if (!alternative || bindings.has(token.value) || isPropertyName(tokens, index)) continue;
    const line = token.line;
    throw new Error(
      `Code mode source preflight [unsupported_global] at line ${line}: ${token.value} is not available in restricted code mode — ${alternative}. ${RESTRICTED_CAPABILITIES}`,
    );
  }
}

function validateToolCalls(
  tokens: readonly SourceToken[],
  options: CodeModeSourcePreflightOptions,
): void {
  if (collectBindings(tokens).has("tools")) return;
  const available = [...new Set(options.availableToolNames)].sort((left, right) =>
    left.localeCompare(right),
  );
  const outside = new Set(options.outsideToolNames ?? []);
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index]!.value !== "tools" || isPropertyName(tokens, index)) continue;
    if (tokens[index + 1]!.value !== "." && tokens[index + 1]!.value !== "?.") continue;
    const name = tokens[index + 2]!.value;
    if (
      !isIdentifier(name) ||
      available.includes(name) ||
      outside.has(name) ||
      !isUnconditionalTopLevelReference(tokens, index)
    )
      continue;
    const suggestions = closeMatches(name, available, outside);
    throw new Error(
      [
        `Code mode source preflight [unknown_tool] at line ${tokens[index + 2]!.line}: tools.${name} is an unconditional top-level reference, but ${name} is not registered in this cell or as a direct Pi tool.`,
        `Available tools in this cell: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
        `Close matches: ${suggestions.length > 0 ? suggestions.join(", ") : "(none)"}.`,
        `Outside code mode: no — ${name} is not registered as a direct Pi tool either.`,
      ].join(" "),
    );
  }
}

function tokenizeExecutableSource(source: string): SourceToken[] {
  const executable = maskJavaScriptCommentsAndStrings(source);
  const tokens: SourceToken[] = [];
  let line = 1;
  let scannedThrough = 0;
  for (const match of executable.matchAll(TOKEN_PATTERN)) {
    for (let index = scannedThrough; index < match.index; index += 1) {
      if (source[index] === "\n") line += 1;
    }
    tokens.push({ value: match[0], index: match.index, line });
    scannedThrough = match.index + match[0].length;
  }
  return tokens;
}

function collectBindings(tokens: readonly SourceToken[]): Set<string> {
  const bindings = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index]!.value;
    if (BINDING_KEYWORDS.has(value)) {
      const next = tokens[index + 1]?.value;
      if (isIdentifier(next)) bindings.add(next);
      else if (next === "{" || next === "[") {
        collectDestructuredBindings(tokens, index + 1, bindings);
      }
    }
    if (value === "function") {
      if (isIdentifier(tokens[index + 1]?.value)) bindings.add(tokens[index + 1]!.value);
      const open = findNextToken(tokens, index + 1, "(");
      if (open !== -1) collectParameterBindings(tokens, open, bindings);
    }
    if (value === "catch" && tokens[index + 1]?.value === "(") {
      collectParameterBindings(tokens, index + 1, bindings);
    }
    if (value === "=>") collectArrowBindings(tokens, index, bindings);
  }
  return bindings;
}

function collectDestructuredBindings(
  tokens: readonly SourceToken[],
  openIndex: number,
  bindings: Set<string>,
): void {
  const closing = tokens[openIndex]!.value === "{" ? "}" : "]";
  let depth = 0;
  let inDefault = false;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index]!.value;
    if (value === "{" || value === "[") depth += 1;
    else if (value === "}" || value === "]") {
      depth -= 1;
      if (depth === 0 && value === closing) return;
    } else if (value === "=" && depth === 1) inDefault = true;
    else if (value === "," && depth === 1) inDefault = false;
    else if (!inDefault && isIdentifier(value) && tokens[index + 1]?.value !== ":") {
      bindings.add(value);
    }
  }
}

function collectParameterBindings(
  tokens: readonly SourceToken[],
  openIndex: number,
  bindings: Set<string>,
): void {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index]!.value;
    if (value === "(") depth += 1;
    else if (value === ")") {
      depth -= 1;
      if (depth === 0) return;
    } else if (
      depth === 1 &&
      isIdentifier(value) &&
      tokens[index + 1]?.value !== ":" &&
      isParameterBindingPosition(tokens, index)
    ) {
      bindings.add(value);
    }
  }
}

function collectArrowBindings(
  tokens: readonly SourceToken[],
  arrowIndex: number,
  bindings: Set<string>,
): void {
  const previous = tokens[arrowIndex - 1]?.value;
  if (isIdentifier(previous)) {
    bindings.add(previous);
    return;
  }
  if (previous !== ")") return;
  let depth = 0;
  for (let index = arrowIndex - 1; index >= 0; index -= 1) {
    const value = tokens[index]!.value;
    if (value === ")") depth += 1;
    else if (value === "(") {
      depth -= 1;
      if (depth === 0) {
        collectParameterBindings(tokens, index, bindings);
        return;
      }
    }
  }
}

function isParameterBindingPosition(tokens: readonly SourceToken[], index: number): boolean {
  const previous = tokens[index - 1]?.value;
  if (previous === "(" || previous === "," || previous === "{" || previous === "[") return true;
  if (previous === ":") return true;
  return previous === "." && tokens[index - 2]?.value === "." && tokens[index - 3]?.value === ".";
}

function findNextToken(tokens: readonly SourceToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]!.value === value) return index;
    if (tokens[index]!.value === "{" || tokens[index]!.value === ";") return -1;
  }
  return -1;
}

function isPropertyName(tokens: readonly SourceToken[], index: number): boolean {
  const previous = tokens[index - 1]?.value;
  if (previous === "." || previous === "?.") return true;
  const next = tokens[index + 1]?.value;
  if (next === ":" && (previous === "{" || previous === ",")) return true;
  return (
    (next === "(" || next === "=") && (previous === "{" || previous === "," || previous === ";")
  );
}

function isUnconditionalTopLevelReference(
  tokens: readonly SourceToken[],
  referenceIndex: number,
): boolean {
  let depth = 0;
  let statementStart = 0;
  for (let index = 0; index < referenceIndex; index += 1) {
    const value = tokens[index]!.value;
    if (value === "{") depth += 1;
    else if (value === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) statementStart = index + 1;
    } else if (value === ";" && depth === 0) statementStart = index + 1;
  }
  if (depth !== 0) return false;
  const guards = new Set([
    "if",
    "for",
    "while",
    "do",
    "switch",
    "catch",
    "try",
    "function",
    "class",
    "=>",
    "&&",
    "||",
    "??",
    "?",
  ]);
  return !tokens.slice(statementStart, referenceIndex).some((token) => guards.has(token.value));
}

function isIdentifier(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value));
}

function closeMatches(
  requested: string,
  available: readonly string[],
  outside: ReadonlySet<string>,
): string[] {
  const candidates = new Set([...available, ...outside]);
  candidates.delete(requested);
  return [...candidates]
    .map((name) => ({ name, distance: levenshtein(requested, name) }))
    .filter(({ distance }) => distance <= Math.max(2, Math.floor(requested.length / 3)))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map(
      ({ name }) =>
        `${name}${outside.has(name) && !available.includes(name) ? " (direct Pi tool only)" : ""}`,
    );
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}
