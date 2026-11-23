import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BoundaryValue, isBoundaryRecord, isString } from "./runtime-values.ts";

export type PackageVersionResult = {
  ecosystem: string;
  version: string;
};

export type PackageVersionReadResult =
  | { kind: "ok"; result: PackageVersionResult | null }
  | { kind: "error" };

type ManifestSource = {
  files: readonly string[];
  parse: (raw: string) => string | undefined;
  kind?: "file" | "extensions";
};

export const PACKAGE_VERSION_ECOSYSTEMS = [
  "bun",
  "nodejs",
  "deno",
  "maven",
  "gradle",
  "python",
  "rust",
  "php",
  "crystal",
  "dart",
  "elixir",
  "elm",
  "fortran",
  "gleam",
  "haskell",
  "helm",
  "julia",
  "meson",
  "nim",
  "ruby",
  "vlang",
  "xmake",
] as const;

function cleanVersion(value: string | undefined): string | undefined {
  if (!value || new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]`).test(value)) {
    return undefined;
  }
  let text = value.trim();
  if (!text) return undefined;

  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1);
    }
  }

  while (text.startsWith("v") || text.startsWith("V")) {
    const next = text[1];
    if (!next || next < "0" || next > "9") break;
    text = text.slice(1);
  }

  text = text.trim();
  if (!text) return undefined;

  if (/\s/.test(text)) return undefined;
  if (/[{}\\<>]/.test(text)) return undefined;

  return text;
}

function safeJsonParse(raw: string): BoundaryValue {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stripJsonComments(raw: string): string {
  let result = "";
  let inString = false;
  let stringQuote = "";
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += "\n";
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\" && next !== undefined) {
        result += next;
        i += 1;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      result += ch;
      continue;
    }
    result += ch;
  }
  return result;
}

function safeJsoncParse(raw: string): BoundaryValue {
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return undefined;
  }
}

function readJsonVersionField(raw: string, key: string): string | undefined {
  const parsed = safeJsonParse(raw);
  if (!isBoundaryRecord(parsed)) return undefined;
  const value = parsed[key];
  return isString(value) ? value : undefined;
}

function readJsoncVersionField(raw: string, key: string): string | undefined {
  const parsed = safeJsoncParse(raw);
  if (!isBoundaryRecord(parsed)) return undefined;
  const value = parsed[key];
  return isString(value) ? value : undefined;
}

function readTomlSectionKeyValue(raw: string, section: string, key: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  let inTargetSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const headerMatch = trimmed.match(/^\[\[?([^\]]+)\]?\]\s*$/);
    if (headerMatch) {
      const name = (headerMatch[1] ?? "").trim();
      inTargetSection = name === section;
      continue;
    }

    if (!inTargetSection) continue;

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const candidateKey = match[1] ?? "";
    if (candidateKey !== key) continue;

    let value = (match[2] ?? "").trim();
    const trailingComment = value.indexOf("#");
    if (trailingComment >= 0 && !isInsideString(value, trailingComment)) {
      value = value.slice(0, trailingComment).trim();
    }
    return value || undefined;
  }

  return undefined;
}

function readTopLevelTomlValue(raw: string, key: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) return undefined;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const candidateKey = match[1] ?? "";
    if (candidateKey !== key) continue;
    return trimQuotes((match[2] ?? "").trim());
  }
  return undefined;
}

function trimQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isInsideString(value: string, index: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < index; i++) {
    const ch = value[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

function readYamlTopLevelValue(raw: string, key: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const target = `${key}:`;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    if (!line.startsWith(target)) continue;
    const value = line.slice(target.length).trim();
    return value || undefined;
  }
  return undefined;
}

function extractCabalPackageVersion(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  let packageStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^package\s*$/i.test(line.trim())) {
      packageStart = i + 1;
      break;
    }
  }

  for (let i = packageStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (line.trim().startsWith("--")) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s*version\s*:\s*(.+?)\s*$/i);
    if (match) return cleanVersion(match[1]);
  }

  for (let i = packageStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("--")) continue;
    if (!/^[a-zA-Z][\w-]*\s*:/.test(trimmed)) break;
    const match = trimmed.match(/^version\s*:\s*(.+?)\s*$/i);
    if (match) return cleanVersion(match[1]);
  }

  return undefined;
}

const parsers: readonly ManifestSource[] = [
  {
    files: ["package.json"],
    parse: (raw) => cleanVersion(readJsonVersionField(raw, "version")),
  },
  {
    files: ["deno.json", "deno.jsonc"],
    parse: (raw) => cleanVersion(readJsoncVersionField(raw, "version")),
  },
  {
    files: ["pom.xml"],
    parse: (raw) => {
      const match = raw.match(/<project\b[^>]*>[\s\S]*?<version>\s*([^<]+?)\s*<\/version>/i);
      return cleanVersion(match?.[1]);
    },
  },
  {
    files: ["gradle.properties"],
    parse: (raw) => {
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*version\s*[:=]\s*(.+?)\s*$/i);
        if (match) return cleanVersion(match[1]);
      }
      return undefined;
    },
  },
  {
    files: ["pyproject.toml"],
    parse: (raw) => {
      const project = cleanVersion(readTomlSectionKeyValue(raw, "project", "version"));
      if (project) return project;
      return cleanVersion(readTomlSectionKeyValue(raw, "tool.poetry", "version"));
    },
  },
  {
    files: ["setup.cfg"],
    parse: (raw) => cleanVersion(readTomlSectionKeyValue(raw, "metadata", "version")),
  },
  {
    files: ["Cargo.toml"],
    parse: (raw) => {
      const direct = readTomlSectionKeyValue(raw, "package", "version");
      const directClean = cleanVersion(direct);
      if (directClean && !/^\s*version\s*\.\s*workspace\s*=\s*true/i.test(direct ?? "")) {
        return directClean;
      }

      if (!/\bversion\s*\.\s*workspace\s*=\s*true/i.test(raw)) return undefined;
      const workspaceMatch = raw.match(/\[workspace\][\s\S]*?version\s*=\s*["']([^"']+)["']/i);
      return cleanVersion(workspaceMatch?.[1]);
    },
  },
  {
    files: ["composer.json"],
    parse: (raw) => cleanVersion(readJsonVersionField(raw, "version")),
  },
  {
    files: ["shard.yml"],
    parse: (raw) => cleanVersion(readYamlTopLevelValue(raw, "version")),
  },
  {
    files: ["pubspec.yaml", "pubspec.yml"],
    parse: (raw) => cleanVersion(readYamlTopLevelValue(raw, "version")),
  },
  {
    files: ["mix.exs"],
    parse: (raw) => {
      const match = raw.match(/(?:^|\n)\s*version\s*:\s*["']([^"']+)["']/);
      return cleanVersion(match?.[1]);
    },
  },
  {
    files: ["elm.json"],
    parse: (raw) => cleanVersion(readJsonVersionField(raw, "version")),
  },
  {
    files: ["fpm.toml"],
    parse: (raw) => {
      const fromPackage = cleanVersion(readTomlSectionKeyValue(raw, "package", "version"));
      if (fromPackage) return fromPackage;
      return cleanVersion(readTomlSectionKeyValue(raw, "project", "version"));
    },
  },
  {
    files: ["gleam.toml"],
    parse: (raw) => cleanVersion(readTopLevelTomlValue(raw, "version")),
  },
  {
    files: [".cabal"],
    kind: "extensions",
    parse: (raw) => extractCabalPackageVersion(raw),
  },
  {
    files: ["Chart.yaml"],
    parse: (raw) => cleanVersion(readYamlTopLevelValue(raw, "version")),
  },
  {
    files: ["Project.toml"],
    parse: (raw) => cleanVersion(readTopLevelTomlValue(raw, "version")),
  },
  {
    files: ["meson.build"],
    parse: (raw) => {
      const match = raw.match(/\bproject\s*\([^)]*?\bversion\s*:\s*['"]([^'"]+)['"]/);
      return cleanVersion(match?.[1]);
    },
  },
  {
    files: [".nimble"],
    kind: "extensions",
    parse: (raw) => cleanVersion(readTopLevelTomlValue(raw, "version")),
  },
  {
    files: [".gemspec"],
    kind: "extensions",
    parse: (raw) => {
      const quoted = raw.match(/\b(?:spec\.|\.)?version\s*=\s*["']([^"']+)["']/);
      if (quoted) return cleanVersion(quoted[1]);
      return undefined;
    },
  },
  {
    files: ["v.mod"],
    parse: (raw) => {
      const match = raw.match(/\bversion\s*:\s*['"]([^'']+)['"]/);
      if (match) return cleanVersion(match[1]);
      const numeric = raw.match(/\bversion\s*:\s*([0-9][^\s,]+)/);
      return cleanVersion(numeric?.[1]);
    },
  },
  {
    files: ["xmake.lua"],
    parse: (raw) => {
      const match = raw.match(/^\s*set_version\s*\(\s*["']([^"']+)["']\s*\)/m);
      return cleanVersion(match?.[1]);
    },
  },
];

function ecosystemFor(file: string): string {
  const lower = file.toLowerCase();
  if (lower === "package.json") return "nodejs";
  if (lower === "pom.xml") return "maven";
  if (lower === "gradle.properties") return "gradle";
  if (lower === "deno.json" || lower === "deno.jsonc") return "deno";
  if (lower === "pyproject.toml") return "python";
  if (lower === "setup.cfg") return "python";
  if (lower === "cargo.toml") return "rust";
  if (lower === "composer.json") return "php";
  if (lower === "shard.yml") return "crystal";
  if (lower === "pubspec.yaml" || lower === "pubspec.yml") return "dart";
  if (lower === "mix.exs") return "elixir";
  if (lower === "elm.json") return "elm";
  if (lower === "fpm.toml") return "fortran";
  if (lower === "gleam.toml") return "gleam";
  if (lower.endsWith(".cabal")) return "haskell";
  if (lower === "chart.yaml") return "helm";
  if (lower === "project.toml") return "julia";
  if (lower === "meson.build") return "meson";
  if (lower.endsWith(".nimble")) return "nim";
  if (lower.endsWith(".gemspec")) return "ruby";
  if (lower === "v.mod") return "vlang";
  if (lower === "xmake.lua") return "xmake";
  return "unknown";
}

function safeReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hasAnyExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  for (const ext of extensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function readPackageVersion(cwd: string): PackageVersionResult | null {
  for (let i = 0; i < parsers.length; i++) {
    const source = parsers[i];
    if (!source || source.kind === "extensions") continue;
    for (const file of source.files) {
      const full = join(cwd, file);
      if (!existsSync(full)) continue;
      const raw = safeReadFile(full);
      if (raw === undefined) continue;
      let version: string | undefined;
      try {
        version = source.parse(raw);
      } catch {
        continue;
      }
      if (version) return { ecosystem: ecosystemFor(file), version };
    }
  }

  let entries: readonly string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return null;
  }

  for (let i = 0; i < parsers.length; i++) {
    const source = parsers[i];
    if (source?.kind !== "extensions") continue;
    for (const entry of entries) {
      if (!hasAnyExtension(entry, source.files)) continue;
      const full = join(cwd, entry);
      const raw = safeReadFile(full);
      if (raw === undefined) continue;
      let version: string | undefined;
      try {
        version = source.parse(raw);
      } catch {
        continue;
      }
      if (version) return { ecosystem: ecosystemFor(entry), version };
    }
  }

  return null;
}

export async function readPackageVersionResult(cwd: string): Promise<PackageVersionReadResult> {
  try {
    return { kind: "ok", result: readPackageVersion(cwd) };
  } catch {
    return { kind: "error" };
  }
}

export const __test__ = {
  parsers,
  cleanVersion,
  ecosystemFor,
  hasAnyExtension,
};
