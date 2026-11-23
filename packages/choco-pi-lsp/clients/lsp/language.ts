import path from "node:path";
import {
  getLanguageId as getKindLanguageId,
  KIND_EXTENSIONS,
  SPECIAL_FILENAMES,
} from "../file-kinds.ts";
import { getLspCapableKinds } from "../language-policy.ts";

interface LanguageExtensionMap {
  [extension: string]: string;
}

const CURATED_LANGUAGE_EXTENSIONS: LanguageExtensionMap = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".svelte": "svelte",
  ".vue": "vue",
  ".astro": "astro",

  ".py": "python",
  ".pyi": "python",

  ".go": "go",
  ".mod": "go",
  ".sum": "go",

  ".rs": "rust",
  ".ron": "rust",

  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".hh": "cpp",

  ".java": "java",

  ".kt": "kotlin",
  ".kts": "kotlin",

  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",

  ".php": "php",

  ".cs": "csharp",

  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",

  ".swift": "swift",

  ".dart": "dart",

  ".lua": "lua",

  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "fish",

  ".cmake": "cmake",

  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",

  ".md": "markdown",
  ".mdx": "markdown",

  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",

  ".html": "html",
  ".htm": "html",

  ".sql": "sql",

  ".dockerfile": "dockerfile",

  ".tf": "terraform",
  ".tfvars": "terraform",

  ".nix": "nix",

  ".ex": "elixir",
  ".exs": "elixir",

  ".hs": "haskell",
  ".lhs": "haskell",

  ".ml": "ocaml",
  ".mli": "ocaml",

  ".zig": "zig",
  ".zon": "zig",

  ".gleam": "gleam",

  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",

  ".scala": "scala",
  ".sc": "scala",

  ".r": "r",
  ".R": "r",

  ".jl": "julia",

  ".pl": "perl",
  ".pm": "perl",

  ".erl": "erlang",
  ".hrl": "erlang",

  ".f": "fortran",
  ".f90": "fortran",
  ".f95": "fortran",

  ".cob": "cobol",
  ".cbl": "cobol",

  ".pas": "pascal",
  ".pp": "pascal",

  ".adb": "ada",
  ".ads": "ada",

  ".vhd": "vhdl",
  ".vhdl": "vhdl",
  ".v": "verilog",
  ".sv": "systemverilog",

  ".graphql": "graphql",
  ".gql": "graphql",

  ".proto": "proto",

  ".toml": "toml",

  ".prisma": "prisma",

  ".typ": "typst",
  ".typc": "typst",
} as const;

export const LANGUAGE_EXTENSIONS: LanguageExtensionMap = (() => {
  const map: LanguageExtensionMap = { ...CURATED_LANGUAGE_EXTENSIONS };
  for (const kind of getLspCapableKinds()) {
    for (const extension of KIND_EXTENSIONS[kind]) {
      map[extension] ??= getKindLanguageId(kind);
    }
  }
  return map;
})();

const BASENAME_LANGUAGE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  languageId: string;
}> = (() => {
  const lspCapableKinds = new Set(getLspCapableKinds());
  return SPECIAL_FILENAMES.filter(({ kind }) => lspCapableKinds.has(kind)).map(
    ({ pattern, kind }) => ({
      pattern,
      languageId: getKindLanguageId(kind),
    }),
  );
})();

function getBasenameLanguageId(base: string): string | undefined {
  return BASENAME_LANGUAGE_PATTERNS.find(({ pattern }) => pattern.test(base))?.languageId;
}

export function getLanguageId(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && LANGUAGE_EXTENSIONS[ext]) {
    return LANGUAGE_EXTENSIONS[ext];
  }

  const base = path.basename(filePath);
  return (
    LANGUAGE_EXTENSIONS[base] ??
    LANGUAGE_EXTENSIONS[base.toLowerCase()] ??
    getBasenameLanguageId(base)
  );
}

export function getExtensionsForLanguage(languageId: string): string[] {
  return Object.entries(LANGUAGE_EXTENSIONS)
    .filter(([, id]) => id === languageId)
    .map(([ext]) => ext);
}
