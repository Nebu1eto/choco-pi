import { type BoundaryValue, isString } from "./runtime-values.ts";

export type IconMode = "auto" | "nerd" | "ascii";

export type IconGlyphs = {
  cwd: string;
  git: string;
  ahead: string;
  behind: string;
  diverged: string;
  conflicted: string;
  untracked: string;
  stashed: string;
  modified: string;
  staged: string;
  renamed: string;
  deleted: string;
  typechanged: string;
  cacheHit: string;
  editorPrompt: string;
  rail: string;
  username: string;
  time: string;
  os: string;
  package: string;
};

export type ResolvedIcons = IconGlyphs & { mode: IconMode };

export const ICON_GLYPH_KEYS = [
  "cwd",
  "git",
  "ahead",
  "behind",
  "diverged",
  "conflicted",
  "untracked",
  "stashed",
  "modified",
  "staged",
  "renamed",
  "deleted",
  "typechanged",
  "cacheHit",
  "editorPrompt",
  "rail",
  "username",
  "time",
  "os",
  "package",
] as const satisfies readonly (keyof IconGlyphs)[];

export const NERD_DEFAULT_ICONS: IconGlyphs = {
  cwd: "",
  git: "",
  ahead: "↑",
  behind: "↓",
  diverged: "⇕",
  conflicted: "=",
  untracked: "?",
  stashed: "$",
  modified: "!",
  staged: "+",
  renamed: "»",
  deleted: "✘",
  typechanged: "T",
  cacheHit: "󰆼",
  editorPrompt: "",
  rail: "│",
  username: "",
  time: "",
  os: "",
  package: "",
};

export const ASCII_DEFAULT_ICONS: IconGlyphs = {
  cwd: "",
  git: "*",
  ahead: "^",
  behind: "v",
  diverged: "^v",
  conflicted: "=",
  untracked: "?",
  stashed: "$",
  modified: "!",
  staged: "+",
  renamed: ">",
  deleted: "x",
  typechanged: "T",
  cacheHit: "c",
  editorPrompt: "",
  rail: "|",
  username: "@",
  time: "t",
  os: "o",
  package: "pkg",
};

interface PlatformIconMap {
  [platform: string]: string;
}

interface RuntimeAsciiSymbolMap {
  [runtime: string]: string;
}

export const OS_PLATFORM_ICONS_NERD: PlatformIconMap = {
  darwin: "\uf179",
  linux: "\uf17c",
  win32: "\uf17a",
};

export const OS_PLATFORM_ICONS_ASCII: PlatformIconMap = {
  darwin: "mac",
  linux: "linux",
  win32: "win",
};

export const RUNTIME_ASCII_SYMBOLS: RuntimeAsciiSymbolMap = {
  xmake: "xm",
  maven: "mvn",
  gradle: "grd",
  bun: "bun",
  deno: "deno",
  lua: "lua",
  nodejs: "node",
  python: "py",
  golang: "go",
  rust: "rs",
  java: "java",
  ruby: "rb",
  php: "php",
  buf: "buf",
  cmake: "cmake",
  cpp: "c++",
  c: "c",
  cobol: "cob",
  conda: "conda",
  crystal: "cr",
  dart: "dart",
  dotnet: ".net",
  elixir: "ex",
  elm: "elm",
  erlang: "erl",
  fennel: "fnl",
  fortran: "f90",
  gleam: "glm",
  guix_shell: "guix",
  haskell: "hs",
  haxe: "hx",
  helm: "helm",
  julia: "jl",
  kotlin: "kt",
  meson: "meson",
  mojo: "mojo",
  nim: "nim",
  nix_shell: "nix",
  ocaml: "ml",
  odin: "odin",
  opa: "opa",
  perl: "pl",
  pixi: "pixi",
  pulumi: "pul",
  purescript: "purs",
  raku: "raku",
  red: "red",
  rlang: "R",
  scala: "scala",
  solidity: "sol",
  spack: "spack",
  swift: "swift",
  terraform: "tf",
  typst: "typ",
  vagrant: "vag",
  vlang: "v",
  zig: "zig",
};

export function isIconMode(value: BoundaryValue): value is IconMode {
  return value === "auto" || value === "nerd" || value === "ascii";
}

export function normalizeIconMode(value: BoundaryValue): IconMode {
  return isIconMode(value) ? value : "auto";
}

export function modeDefaultIcons(mode: IconMode): IconGlyphs {
  return mode === "ascii" ? { ...ASCII_DEFAULT_ICONS } : { ...NERD_DEFAULT_ICONS };
}

export function resolveConfiguredIcons(
  mode: IconMode,
  overrides: Partial<IconGlyphs> = {},
): ResolvedIcons {
  const base = modeDefaultIcons(mode);
  const rail =
    isString(overrides.rail) && overrides.rail.trim().length > 0 ? overrides.rail : base.rail;
  return {
    mode,
    ...base,
    ...overrides,
    rail,
  };
}

export function resolveOsIcon(
  configuredOsIcon: string,
  mode: IconMode = "auto",
  platform: string = process.platform,
): string {
  const modeDefault = modeDefaultIcons(mode).os;
  if (configuredOsIcon !== modeDefault) return configuredOsIcon;
  const platformMap = mode === "ascii" ? OS_PLATFORM_ICONS_ASCII : OS_PLATFORM_ICONS_NERD;
  return platformMap[platform] ?? configuredOsIcon;
}

export function resolveRuntimeSymbol(
  name: string,
  nerdSymbol: string,
  mode: IconMode = "auto",
): string {
  if (mode !== "ascii") return nerdSymbol;
  return RUNTIME_ASCII_SYMBOLS[name] ?? (name.slice(0, 3) || "*");
}

export function resolvePackageIcon(configuredPackageIcon: string, mode: IconMode = "auto"): string {
  const modeDefault = modeDefaultIcons(mode).package;
  if (isString(configuredPackageIcon) && configuredPackageIcon.length > 0) {
    return configuredPackageIcon;
  }
  return modeDefault;
}
