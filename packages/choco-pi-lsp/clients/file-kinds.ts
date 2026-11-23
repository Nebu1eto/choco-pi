import { basename, extname } from "node:path";

export type FileKind =
  | "clojure"
  | "cmake"
  | "csharp"
  | "css"
  | "cue"
  | "cxx"
  | "dart"
  | "docker"
  | "elixir"
  | "fish"
  | "fsharp"
  | "gleam"
  | "go"
  | "haskell"
  | "helm-template"
  | "html"
  | "java"
  | "json"
  | "jsts"
  | "kotlin"
  | "lua"
  | "markdown"
  | "nix"
  | "ocaml"
  | "php"
  | "powershell"
  | "prisma"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "swift"
  | "terraform"
  | "terragrunt"
  | "toml"
  | "yaml"
  | "zig";

export const KIND_EXTENSIONS = {
  clojure: [".clj", ".cljc", ".cljs", ".edn"],
  cmake: [".cmake"],
  csharp: [".cs"],
  css: [".css", ".less", ".sass", ".scss"],
  cue: [".cue"],
  cxx: [
    ".c",
    ".h",
    ".c++",
    ".cc",
    ".cp",
    ".cpp",
    ".cxx",
    ".hh",
    ".hpp",
    ".hxx",
    ".inl",
    ".ipp",
    ".tpp",
    ".txx",
    ".c++m",
    ".cppm",
    ".cxxm",
    ".ixx",
    ".cu",
    ".hip",
    ".m",
    ".mm",
    ".cl",
    ".clcpp",
  ],
  dart: [".dart"],
  docker: [".dockerfile"],
  elixir: [".ex", ".exs"],
  fish: [".fish"],
  fsharp: [".fs", ".fsi", ".fsx"],
  gleam: [".gleam"],
  go: [".go"],
  haskell: [".hs", ".lhs"],
  "helm-template": [".tpl"],
  html: [".htm", ".html"],
  java: [".java"],
  json: [".json", ".json5", ".jsonc"],
  jsts: [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".svelte", ".ts", ".tsx", ".vue"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  markdown: [".md", ".mdx"],
  nix: [".nix"],
  ocaml: [".ml", ".mli"],
  php: [".php"],
  powershell: [".ps1", ".psm1", ".psd1"],
  prisma: [".prisma"],
  python: [".py", ".pyi"],
  ruby: [".gemspec", ".rake", ".rb", ".ru"],
  rust: [".rs"],
  shell: [".bash", ".sh", ".zsh"],
  sql: [".sql"],
  swift: [".swift"],
  terraform: [".tf", ".tfvars"],
  terragrunt: [],
  toml: [".toml"],
  yaml: [".yaml", ".yml"],
  zig: [".zig", ".zon"],
} satisfies Record<FileKind, readonly string[]>;

export function hasKindExtension(filePath: string, kind: FileKind): boolean {
  const extension = extname(filePath).toLowerCase();
  return KIND_EXTENSIONS[kind].some((candidate) => candidate === extension);
}

const JSTS_FACT_EXTENSIONS = new Set(
  KIND_EXTENSIONS.jsts.filter((extension) => ![".vue", ".svelte"].includes(extension)),
);

export function isJstsFactFile(filePath: string): boolean {
  return JSTS_FACT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

const NON_KIND_READABLE_EXTENSIONS = new Set([".txt", ".env", ".cfg", ".conf", ".ini", ".xml"]);

export function isReadableSourceFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  const kinds = Object.keys(KIND_EXTENSIONS);
  // SAFETY: KIND_EXTENSIONS satisfies Record<FileKind, ...>, so each own key is a FileKind.
  return (
    kinds.some((kind) => hasKindExtension(filePath, kind as FileKind)) ||
    NON_KIND_READABLE_EXTENSIONS.has(extension)
  );
}

export const DOTNET_CSHARP_ROOT_MARKERS: readonly string[] = ["*.csproj", "*.sln", "*.slnx"];
export const DOTNET_FSHARP_ROOT_MARKERS: readonly string[] = ["*.fsproj", "*.sln"];

export const TERRAGRUNT_FILENAMES: readonly string[] = ["terragrunt.hcl", "root.hcl"];

const EXT_TO_KIND = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(KIND_EXTENSIONS)) {
  // SAFETY: KIND_EXTENSIONS satisfies Record<FileKind, ...>, so Object.entries yields FileKind keys.
  const fileKind = kind as FileKind;
  for (const ext of exts) EXT_TO_KIND.set(ext.toLowerCase(), fileKind);
  for (const ext of exts) {
    if (ext.startsWith(".")) EXT_TO_KIND.set(ext.slice(1).toLowerCase(), fileKind);
  }
}

export const SPECIAL_FILENAMES: Array<{ pattern: RegExp; kind: FileKind }> = [
  { pattern: /^CMakeLists\.txt$/i, kind: "cmake" },
  { pattern: /^Makefile$/i, kind: "shell" },
  { pattern: /^Dockerfile(\.\w+)?$/i, kind: "docker" },
  ...TERRAGRUNT_FILENAMES.map((name) => ({
    pattern: new RegExp(`^${name.replaceAll(".", "\\.")}$`, "i"),
    kind: "terragrunt" as const,
  })),
];

export function detectFileKind(filePath: string): FileKind | undefined {
  if (!filePath) {
    return undefined;
  }

  const base = basename(filePath);
  for (const { pattern, kind } of SPECIAL_FILENAMES) {
    if (pattern.test(base)) {
      return kind;
    }
  }

  const ext = extname(filePath).toLowerCase();
  return EXT_TO_KIND.get(ext);
}

export function isFileKind(filePath: string, kind: FileKind | FileKind[]): boolean {
  const detected = detectFileKind(filePath);
  if (!detected) return false;

  if (Array.isArray(kind)) {
    return kind.includes(detected);
  }

  return detected === kind;
}

export function getFileKindsForExtension(ext: string): FileKind[] {
  const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
  const kind = EXT_TO_KIND.get(normalizedExt.toLowerCase());
  return kind ? [kind] : [];
}

export const CODE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "clojure",
  "cmake",
  "csharp",
  "cue",
  "cxx",
  "dart",
  "docker",
  "elixir",
  "fish",
  "fsharp",
  "gleam",
  "go",
  "haskell",
  "helm-template",
  "java",
  "jsts",
  "kotlin",
  "lua",
  "nix",
  "ocaml",
  "php",
  "powershell",
  "prisma",
  "python",
  "ruby",
  "rust",
  "shell",
  "sql",
  "swift",
  "terraform",
  "terragrunt",
  "zig",
]);

export const NON_CODE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "css",
  "html",
  "json",
  "markdown",
  "toml",
  "yaml",
]);

export function isCodeKind(kind: FileKind): boolean {
  return CODE_KINDS.has(kind);
}

export function isConfigKind(kind: FileKind): boolean {
  return NON_CODE_KINDS.has(kind);
}

export function isCodeKindFile(filePath: string): boolean {
  const kind = detectFileKind(filePath);
  return kind !== undefined && CODE_KINDS.has(kind);
}

export function getFileKindLabel(kind: FileKind): string {
  const labels = {
    jsts: "JavaScript/TypeScript",
    python: "Python",
    go: "Go",
    rust: "Rust",
    cxx: "C/C++",
    cmake: "CMake",
    shell: "Shell",
    json: "JSON",
    markdown: "Markdown",
    css: "CSS",
    yaml: "YAML",
    sql: "SQL",
    ruby: "Ruby",
    html: "HTML",
    docker: "Dockerfile",
    php: "PHP",
    powershell: "PowerShell",
    prisma: "Prisma",
    csharp: "C#",
    fish: "Fish shell",
    fsharp: "F#",
    java: "Java",
    kotlin: "Kotlin",
    swift: "Swift",
    dart: "Dart",
    lua: "Lua",
    zig: "Zig",
    haskell: "Haskell",
    "helm-template": "Helm template",
    elixir: "Elixir",
    gleam: "Gleam",
    ocaml: "OCaml",
    clojure: "Clojure",
    cue: "CUE",
    terraform: "Terraform",
    terragrunt: "Terragrunt",
    nix: "Nix",
    toml: "TOML",
  } satisfies Record<FileKind, string>;
  return labels[kind] ?? kind;
}

export function getExtensionsForKind(kind: FileKind): string[] {
  return [...(KIND_EXTENSIONS[kind] ?? [])];
}

export function isScannableFile(filePath: string): boolean {
  const kind = detectFileKind(filePath);
  if (!kind) return false;

  const base = basename(filePath);
  if (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.startsWith("test-") ||
    base.startsWith("spec-")
  ) {
    return false;
  }

  return isCodeKind(kind) || isConfigKind(kind);
}

export function getLanguageId(kind: FileKind): string {
  const languageIds = {
    jsts: "typescript",
    python: "python",
    go: "go",
    rust: "rust",
    cxx: "cpp",
    cmake: "cmake",
    shell: "shell",
    json: "json",
    markdown: "markdown",
    css: "css",
    yaml: "yaml",
    sql: "sql",
    ruby: "ruby",
    html: "html",
    docker: "dockerfile",
    php: "php",
    powershell: "powershell",
    prisma: "prisma",
    csharp: "csharp",
    fish: "fish",
    fsharp: "fsharp",
    java: "java",
    kotlin: "kotlin",
    swift: "swift",
    dart: "dart",
    lua: "lua",
    zig: "zig",
    haskell: "haskell",
    "helm-template": "helm",
    elixir: "elixir",
    gleam: "gleam",
    ocaml: "ocaml",
    clojure: "clojure",
    cue: "cue",
    terraform: "terraform",
    terragrunt: "terragrunt",
    nix: "nix",
    toml: "toml",
  } satisfies Record<FileKind, string>;
  return languageIds[kind] ?? "plaintext";
}
