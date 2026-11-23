import { dump } from "./deps/js-yaml.ts";

export interface StructuralIntent {
  pattern?: string;
  lang: string;
  nodeKind?: string;
  insideKind?: string;
  hasKind?: string;
  hasDescendantKind?: string;
  follows?: string;
  precedes?: string;
}

const MAX_SYNTHESIZED_PATTERN_CHARS = 4_000;
const MAX_NODE_KIND_CHARS = 80;
const NODE_KIND_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function hasStructuralIntent(intent: Omit<StructuralIntent, "pattern" | "lang">): boolean {
  return !!(
    intent.nodeKind ||
    intent.insideKind ||
    intent.hasKind ||
    intent.hasDescendantKind ||
    intent.follows ||
    intent.precedes
  );
}

export function synthesizeReplaceRule(intent: StructuralIntent & { rewrite: string }): string {
  const base = synthesizeRule(intent);
  return `${base}fix: ${JSON.stringify(intent.rewrite)}\n`;
}

interface SynthesizedRelation {
  kind?: string;
  pattern?: string;
  stopBy?: "end";
}

interface SynthesizedRule {
  kind?: string;
  pattern?: string;
  inside?: SynthesizedRelation;
  has?: SynthesizedRelation;
  follows?: SynthesizedRelation;
  precedes?: SynthesizedRelation;
}

export function synthesizeRule(intent: StructuralIntent): string {
  const hasPattern = !!intent.pattern?.trim();
  const hasNodeKind = !!intent.nodeKind?.trim();
  if (hasPattern === hasNodeKind) {
    throw new Error("provide exactly one of pattern or node_kind");
  }
  const pattern = intent.pattern;
  if (hasPattern && pattern) assertSafePattern(pattern, "pattern");
  if (intent.hasKind?.trim() && intent.hasDescendantKind?.trim()) {
    throw new Error("has_kind and has_descendant_kind are mutually exclusive");
  }

  const language = canonicalLanguage(intent.lang);

  const rule: SynthesizedRule = hasNodeKind
    ? { kind: assertSafeNodeKind(intent.nodeKind ?? "", "node_kind") }
    : { pattern };

  if (intent.insideKind) {
    rule.inside = {
      kind: assertSafeNodeKind(intent.insideKind, "inside_kind"),
      stopBy: "end",
    };
  }
  if (intent.hasKind) {
    rule.has = { kind: assertSafeNodeKind(intent.hasKind, "has_kind") };
  }
  if (intent.hasDescendantKind) {
    rule.has = {
      kind: assertSafeNodeKind(intent.hasDescendantKind, "has_descendant_kind"),
      stopBy: "end",
    };
  }
  if (intent.follows) {
    assertSafePattern(intent.follows, "follows");
    rule.follows = { pattern: intent.follows };
  }
  if (intent.precedes) {
    assertSafePattern(intent.precedes, "precedes");
    rule.precedes = { pattern: intent.precedes };
  }

  const doc = {
    id: "agent-rule",
    language,
    rule,
  };

  return dump(doc, { lineWidth: -1 });
}

function assertSafePattern(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} is required for YAML synthesis`);
  }
  if (value.length > MAX_SYNTHESIZED_PATTERN_CHARS) {
    throw new Error(`${field} is too long for YAML synthesis`);
  }
  if (value.includes("\0")) {
    throw new Error(`${field} contains a NUL byte`);
  }
}

function assertSafeNodeKind(value: string, field: string): string {
  const kind = value.trim();
  if (kind.length === 0) {
    throw new Error(`${field} is required for YAML synthesis`);
  }
  if (kind.length > MAX_NODE_KIND_CHARS || !NODE_KIND_RE.test(kind)) {
    throw new Error(`${field} must be a single AST node kind like function_declaration`);
  }
  return kind;
}

function canonicalLanguage(lang: string): string {
  const map = {
    typescript: "TypeScript",
    tsx: "Tsx",
    javascript: "JavaScript",
    jsx: "JavaScript",
    python: "Python",
    rust: "Rust",
    go: "Go",
    java: "Java",
    kotlin: "Kotlin",
    swift: "Swift",
    csharp: "CSharp",
    cpp: "Cpp",
    c: "C",
    ruby: "Ruby",
    php: "Php",
    dart: "Dart",
    elixir: "Elixir",
    lua: "Lua",
    ocaml: "OCaml",
    zig: "Zig",
    bash: "Bash",
    css: "Css",
    html: "Html",
    json: "Json",
    yaml: "Yaml",
    toml: "Toml",
    vue: "Vue",
  } satisfies Record<string, string>;
  return Object.entries(map).find(([key]) => key === lang.toLowerCase())?.[1] ?? lang;
}
