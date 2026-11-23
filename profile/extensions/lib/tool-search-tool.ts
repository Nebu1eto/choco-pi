import type { ExtensionAPI, ToolDefinition, ToolExposure } from "@earendil-works/pi-coding-agent";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "./schema-bridge.ts";
import { toolCallSignature } from "@choco-pi/code-mode/tool-signature";
import { isBoundaryValue } from "@choco-pi/code-mode/runtime-values";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export const CODE_MODE_TOOL_NAME = "exec";

export const EXEC_DIRECT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "stop_subagent",
  "shell_start",
  "shell_read",
  "agent_browser",
]);

const NEVER_RETURNED: ReadonlySet<string> = new Set(["exec", "wait", TOOL_SEARCH_TOOL_NAME]);

export const DISABLED_TOOL_NAMES: ReadonlySet<string> = new Set(["grep"]);

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const FILE_TOOL_WORDS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "write",
  "edit",
  "cat",
  "file",
  "rg",
  "sed",
]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function searchWords(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map(stem);
}

function normalizeToken(token: string): string {
  return token
    .replace(/^[+-]+/, "")
    .replace(/^tools\./, "")
    .replace(/\(.*$/, "");
}

export interface NormalizedToolQuery {
  exact: string;
  terms: string[];
}

export function normalizeToolQuery(query: string): NormalizedToolQuery {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token.length > 0);
  return {
    exact: tokens.join(" ").toLowerCase(),
    terms: [...new Set(tokens.flatMap(searchWords))],
  };
}

export interface ToolSearchDocument {
  name: string;
  description: string;
}

function isExactName(exact: string, name: string): boolean {
  const lower = name.toLowerCase();
  return exact.length > 0 && (lower === exact || lower.endsWith("__" + exact));
}

export function rankTools<T extends ToolSearchDocument>(
  query: string,
  documents: readonly T[],
  limit: number,
): T[] {
  const { exact, terms } = normalizeToolQuery(query);
  if ((terms.length === 0 && exact === "") || limit <= 0) return [];
  const scored: Array<{ document: T; exact: boolean; nameHits: number; textHits: number }> = [];
  for (const document of documents) {
    const nameWords = new Set(searchWords(document.name));
    const textWords = new Set(searchWords(document.description));
    let nameHits = 0;
    let textHits = 0;
    for (const term of terms) {
      if (nameWords.has(term)) nameHits += 1;
      else if (textWords.has(term)) textHits += 1;
    }
    const isExact = isExactName(exact, document.name);
    if (!isExact && nameHits === 0 && textHits === 0) continue;
    scored.push({ document, exact: isExact, nameHits, textHits });
  }
  return scored
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.nameHits - left.nameHits ||
        right.textHits - left.textHits ||
        compareNames(left.document.name, right.document.name),
    )
    .slice(0, limit)
    .map(({ document }) => document);
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function compactName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

export function closeToolNames(requested: string, names: readonly string[], limit = 3): string[] {
  const wanted = compactName(normalizeToken(requested.trim()));
  if (wanted.length === 0) return [];
  const threshold = Math.max(2, Math.floor(wanted.length / 3));
  const ranked: Array<{ name: string; score: number }> = [];
  for (const name of new Set(names)) {
    const candidate = compactName(name);
    if (candidate === wanted) {
      ranked.push({ name, score: 0 });
      continue;
    }
    const distance = editDistance(wanted, candidate);
    if (distance <= threshold) ranked.push({ name, score: distance });
    else if (wanted.length >= 4 && candidate.includes(wanted))
      ranked.push({ name, score: threshold + 1 });
  }
  return ranked
    .sort((left, right) => left.score - right.score || compareNames(left.name, right.name))
    .slice(0, limit)
    .map(({ name }) => name);
}

export function firstSentence(description: string): string {
  const line = description.trim().split(/\r?\n/, 1)[0] ?? "";
  const sentence = line.split(/(?<=[.!?])\s/, 1)[0]?.trim() ?? "";
  return sentence.length > 160 ? sentence.slice(0, 159) + "…" : sentence;
}

type ToolInfoEntry = ReturnType<ExtensionAPI["getAllTools"]>[number];

function outsideExecBridge(tool: ToolInfoEntry): boolean {
  const source = tool.sourceInfo;
  return (
    source.source === "sdk" ||
    (source.source === "builtin" && source.path === "builtin:" + tool.name)
  );
}

export type ToolSearchHost = Pick<
  ExtensionAPI,
  "getAllTools" | "getActiveTools" | "setActiveTools"
>;

export interface ToolSearchOptions {
  host: ToolSearchHost;
  isAvailable?: (name: string) => boolean;
  onActivate?: (names: readonly string[]) => void;
}

export interface ToolSearchEntry {
  name: string;
  description: string;
  call: string;
}

export interface ToolSearchOutcome {
  mode: "code" | "normal";
  tools: ToolSearchEntry[];
  loaded: string[];
  output: string;
}

function isDeclaredExposure(exposure: ToolExposure | undefined): boolean {
  return exposure === undefined || exposure === "direct" || exposure === "model-only";
}

const CODE_MODE_FILE_NOTE =
  "Code Mode has no read or grep tool: read and search files with tools.exec_command (rg, sed -n) inside exec, and edit them with tools.apply_patch.";
const CODE_MODE_EMPTY_GUIDANCE =
  "Pi tools are called as tools.<name>(...) inside exec, and ALL_TOOLS lists them; read and search files with tools.exec_command (rg, sed -n).";
const NORMAL_EMPTY_GUIDANCE =
  'Search with capability words, such as "session transcript", or an exact tool name.';

const EXEC_NATIVE_NAMES: ReadonlyMap<string, string> = new Map([["web_run", "web__run"]]);

function execCall(tool: ToolInfoEntry): string {
  const native = EXEC_NATIVE_NAMES.get(tool.name);
  const schema = isBoundaryValue(tool.parameters) ? tool.parameters : undefined;
  const signature = native ? undefined : toolCallSignature(tool.name, schema);
  return "tools." + (signature ?? (native ?? tool.name) + "(...)") + " inside exec";
}

function formatEntries(entries: readonly ToolSearchEntry[]): string {
  return entries
    .map((entry) => "- " + entry.name + ": " + entry.call + " — " + entry.description)
    .join("\n");
}

function emptyResult(query: string, closeNames: readonly string[], guidance: string): string {
  const head = "No tools matched " + JSON.stringify(query.trim()) + ".";
  return closeNames.length > 0
    ? head + " Close names: " + closeNames.join(", ") + "."
    : head + " " + guidance;
}

export function searchTools(
  options: ToolSearchOptions,
  query: string,
  limit: number,
): ToolSearchOutcome {
  const { host } = options;
  const isAvailable = options.isAvailable ?? ((name: string) => !DISABLED_TOOL_NAMES.has(name));
  const active = host.getActiveTools();
  const activeSet = new Set(active);
  const registered = host
    .getAllTools()
    .filter(
      (tool) =>
        tool.exposure !== "hidden" && !NEVER_RETURNED.has(tool.name) && isAvailable(tool.name),
    );
  const codeMode = activeSet.has(CODE_MODE_TOOL_NAME);
  const fileWords = normalizeToolQuery(query).terms.some((term) => FILE_TOOL_WORDS.has(term));

  if (codeMode) {
    const callable = registered.filter(
      (tool) =>
        (!EXEC_DIRECT_ONLY_TOOL_NAMES.has(tool.name) && !outsideExecBridge(tool)) ||
        activeSet.has(tool.name),
    );
    const callFor = (tool: ToolInfoEntry): string =>
      EXEC_DIRECT_ONLY_TOOL_NAMES.has(tool.name) || outsideExecBridge(tool)
        ? "declared tool; call it directly"
        : execCall(tool);
    const matches = rankTools(query, callable, limit);
    const entries = matches.map((tool) => ({
      name: tool.name,
      description: firstSentence(tool.description),
      call: callFor(tool),
    }));
    const lines =
      entries.length > 0
        ? [
            "Found " +
              entries.length +
              " tool" +
              (entries.length === 1 ? "" : "s") +
              "; nothing was loaded:\n" +
              formatEntries(entries),
          ]
        : [
            emptyResult(
              query,
              closeToolNames(
                query,
                callable.map((tool) => tool.name),
              ),
              CODE_MODE_EMPTY_GUIDANCE,
            ),
          ];
    if (fileWords) lines.push(CODE_MODE_FILE_NOTE);
    return { mode: "code", tools: entries, loaded: [], output: lines.join("\n") };
  }

  const candidates = registered.filter(
    (tool) =>
      activeSet.has(tool.name) ||
      tool.exposure === "deferred" ||
      tool.exposure === "codemode" ||
      isDeclaredExposure(tool.exposure),
  );
  const matches = rankTools(query, candidates, limit);
  const loaded = matches.filter((tool) => !activeSet.has(tool.name)).map((tool) => tool.name);
  if (loaded.length > 0) {
    host.setActiveTools([...active, ...loaded]);
    options.onActivate?.(loaded);
  }
  const loadedSet = new Set(loaded);
  const entries = matches.map((tool) => ({
    name: tool.name,
    description: firstSentence(tool.description),
    call: loadedSet.has(tool.name) ? "loaded for your next call" : "already available",
  }));
  const output =
    entries.length > 0
      ? (loaded.length > 0
          ? "Loaded " +
            loaded.length +
            " tool" +
            (loaded.length === 1 ? "" : "s") +
            ". They are available from your next call:\n"
          : "No new tools were loaded; these are already available:\n") + formatEntries(entries)
      : emptyResult(
          query,
          closeToolNames(
            query,
            candidates.map((tool) => tool.name),
          ),
          NORMAL_EMPTY_GUIDANCE,
        );
  return { mode: "normal", tools: entries, loaded, output };
}

export const TOOL_SEARCH_DESCRIPTION =
  "Find tools by name or capability, including Pi tools callable as tools.<name> inside exec. In Code Mode it only lists matches; otherwise it loads them for your next call.";

const toolSearchParameters = hostParams(
  obj({
    query: str({ description: "Tool name or capability words." }),
    limit: opt(num({ description: "Maximum tools to return; defaults to 8." })),
  }),
);

export function createToolSearchToolDefinition(
  options: ToolSearchOptions,
): ToolDefinition<typeof toolSearchParameters, ToolSearchOutcome> {
  return {
    name: TOOL_SEARCH_TOOL_NAME,
    label: TOOL_SEARCH_TOOL_NAME,
    description: TOOL_SEARCH_DESCRIPTION,
    promptSnippet: "Find tools by name or capability",
    parameters: toolSearchParameters,
    exposure: "direct",
    defaultActive: false,
    reachesTools: () => "all",
    async execute(_toolCallId, { query, limit }) {
      if (query.trim() === "") throw new Error("query must not be empty");
      const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
      if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
      const outcome = searchTools(options, query, max);
      return { content: [{ type: "text", text: outcome.output }], details: outcome };
    },
  };
}
