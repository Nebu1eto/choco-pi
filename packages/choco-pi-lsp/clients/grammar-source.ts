import { compile, map, obj, opt, str } from "@earendil-works/pi-schema";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { recordDegradationOnce } from "./degradation-ledger.ts";
import { getPackageRoot } from "./package-root.ts";

export const TREE_SITTER_WASMS_VERSION = "0.1.13";

export const GRAMMAR_CDN_BASE = `https://unpkg.com/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out`;

export interface GrammarSourceOverride {
  package: string;
  version: string;
  url: string;
}

export const GRAMMAR_SOURCE_OVERRIDES = {
  "tree-sitter-lua.wasm": {
    package: "@tree-sitter-grammars/tree-sitter-lua",
    version: "0.4.1",
    url: "https://unpkg.com/@tree-sitter-grammars/tree-sitter-lua@0.4.1/tree-sitter-lua.wasm",
  },
  "tree-sitter-yaml.wasm": {
    package: "@tree-sitter-grammars/tree-sitter-yaml",
    version: "0.7.1",
    url: "https://unpkg.com/@tree-sitter-grammars/tree-sitter-yaml@0.7.1/tree-sitter-yaml.wasm",
  },
} satisfies Record<string, GrammarSourceOverride>;

export function grammarSourceUrl(filename: string): string {
  const override = Object.entries(GRAMMAR_SOURCE_OVERRIDES).find(([key]) => key === filename)?.[1];
  return override?.url ?? `${GRAMMAR_CDN_BASE}/${filename}`;
}

export interface VendoredGrammarSource {
  repo: string;
  commit: string;
  license: string;
  buildCommand: string;
}

export const VENDORED_GRAMMARS = {
  "tree-sitter-cue.wasm": {
    repo: "https://github.com/eonpatapon/tree-sitter-cue",
    commit: "dd7b90e0770ff18070c515937ba3c3d6d93db00e",
    license: "MIT",
    buildCommand: "npx tree-sitter-cli build --wasm",
  },
} satisfies Record<string, VendoredGrammarSource>;

export function isVendoredGrammar(filename: string): boolean {
  return Object.hasOwn(VENDORED_GRAMMARS, filename);
}

export function vendoredGrammarRefusal(filename: string): GrammarDownloadResult {
  return {
    ok: false,
    retryable: false,
    reason:
      `${filename} is built in-house and ships in vendor/grammars/; it has no ` +
      `download source, so a missing copy means the install is incomplete.`,
  };
}

export function vendoredGrammarsDir(): string {
  return path.join(getPackageRoot(import.meta.url), "vendor", "grammars");
}

export const LANGUAGE_TO_GRAMMAR = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  dart: "tree-sitter-dart.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  elixir: "tree-sitter-elixir.wasm",
  ruby: "tree-sitter-ruby.wasm",
  bash: "tree-sitter-bash.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  css: "tree-sitter-css.wasm",
  html: "tree-sitter-html.wasm",
  json: "tree-sitter-json.wasm",
  lua: "tree-sitter-lua.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  php: "tree-sitter-php.wasm",
  swift: "tree-sitter-swift.wasm",
  toml: "tree-sitter-toml.wasm",
  vue: "tree-sitter-vue.wasm",
  yaml: "tree-sitter-yaml.wasm",
  zig: "tree-sitter-zig.wasm",
  cue: "tree-sitter-cue.wasm",
} satisfies Record<string, string>;

export const GRAMMAR_FILES: string[] = [...new Set(Object.values(LANGUAGE_TO_GRAMMAR))];

export interface GrammarRuntime {
  nodeMajor: number;
  isV8: boolean;
  platform: NodeJS.Platform;
}

interface GrammarBlock {
  blocked: (rt: GrammarRuntime) => boolean;
  reason: string;
}

export const BLOCKED_GRAMMARS = {
  "tree-sitter-swift.wasm": {
    blocked: ({ isV8, nodeMajor }) => isV8 && nodeMajor >= 24,
    reason:
      "tree-sitter-swift crashes the runtime on Node >= 24 (V8 Turboshaft WASM OOM, #423/#432); skipped so the process degrades gracefully instead of aborting.",
  },
} satisfies Record<string, GrammarBlock>;

export function currentGrammarRuntime(): GrammarRuntime {
  const m = /^v?(\d+)/.exec(process.versions?.node ?? "");
  return {
    nodeMajor: m ? Number(m[1]) : 0,
    isV8: !process.versions.bun && Boolean(process.versions.v8),
    platform: process.platform,
  };
}

export function grammarBlockReason(
  filename: string,
  rt: GrammarRuntime = currentGrammarRuntime(),
): string | null {
  if (process.env.PILENS_UNSAFE_FORCE_GRAMMAR_LOAD === "1") return null;
  const block = Object.entries(BLOCKED_GRAMMARS).find(([key]) => key === filename)?.[1];
  return block?.blocked(rt) ? block.reason : null;
}

export interface GrammarDownloadResult {
  ok: boolean;
  retryable: boolean;
  reason?: string;
}

export const WASM_MAGIC: readonly number[] = [0x00, 0x61, 0x73, 0x6d];

export function hasWasmMagic(bytes: Uint8Array): boolean {
  if (bytes.length < WASM_MAGIC.length) return false;
  return WASM_MAGIC.every((byte, i) => bytes[i] === byte);
}

export function fileHasWasmMagic(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(WASM_MAGIC.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && hasWasmMagic(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const HTML_PREFIXES = ["<!doctype html", "<html", "<head", "<?xml"];

export function describeNonWasmBody(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "The download returned an empty body (0 bytes) instead of a wasm module.";
  }
  const head = Buffer.from(bytes.subarray(0, Math.min(16, bytes.length))).toString("latin1");
  const lead = head.trimStart().toLowerCase();
  const payloadKind = HTML_PREFIXES.some((prefix) => lead.startsWith(prefix))
    ? "an HTML page (a captive portal or proxy intercepted the request)"
    : "non-wasm data";
  const magic = Buffer.from(bytes.subarray(0, WASM_MAGIC.length))
    .toString("hex")
    .replace(/../g, "$& ")
    .trim();
  return (
    `The download returned ${payloadKind} — ` +
    `${bytes.length} bytes starting ${magic}, not a wasm module.`
  );
}

const GrammarSourceOverrideSchema = obj(
  { package: str(), version: str(), url: str() },
  { open: true },
);
const VendoredGrammarSourceSchema = obj(
  { repo: str(), commit: str(), license: str(), buildCommand: str(), sha256: str() },
  { open: true },
);
const GrammarManifestSchema = obj(
  {
    package: str(),
    version: str(),
    grammars: map(str()),
    overrides: opt(map(GrammarSourceOverrideSchema)),
    vendored: opt(map(VendoredGrammarSourceSchema)),
  },
  { open: true },
);
const isGrammarManifest = compile(GrammarManifestSchema).check;

export interface GrammarManifest {
  package: string;
  version: string;
  grammars: Record<string, string>;
  overrides?: Record<string, GrammarSourceOverride>;
  vendored?: Record<string, VendoredGrammarSource & { sha256: string }>;
}

let manifestOverride: GrammarManifest | null | undefined;
let cachedManifest: GrammarManifest | null | undefined;

function grammarManifestPath(): string {
  return path.join(getPackageRoot(import.meta.url), "scripts", "grammars.lock.json");
}

function resolveGrammarManifest(): GrammarManifest | null {
  if (manifestOverride !== undefined) return manifestOverride;
  if (cachedManifest !== undefined) return cachedManifest;
  try {
    const raw = fs.readFileSync(grammarManifestPath(), "utf-8");
    const parsed = JSON.parse(raw);
    cachedManifest = isGrammarManifest(parsed) ? parsed : null;
  } catch {
    cachedManifest = null;
  }
  return cachedManifest;
}

function loadGrammarManifest(): GrammarManifest | null {
  const manifest = resolveGrammarManifest();
  if (manifest === null) {
    recordDegradationOnce({
      kind: "grammar-blocked",
      subject: "grammars.lock.json",
      reason:
        "the pinned sha256 manifest is unavailable — runtime grammar downloads " +
        "fall back to the weaker Content-Length check (or no integrity check at " +
        "all for a source with neither).",
    });
  }
  return manifest;
}

export function _setGrammarManifestForTests(manifest: GrammarManifest | null | undefined): void {
  manifestOverride = manifest;
}

function sha256Hex(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function shortHash(hash: string): string {
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return `sha256:${hex.slice(0, 12)}…`;
}

export async function downloadGrammarDetailed(
  destDir: string,
  filename: string,
): Promise<GrammarDownloadResult> {
  if (isVendoredGrammar(filename)) return vendoredGrammarRefusal(filename);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const res = await fetch(grammarSourceUrl(filename));
    if (!res.ok) {
      const retryable = res.status !== 404 && res.status !== 410;
      return { ok: false, retryable };
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!hasWasmMagic(data)) {
      return { ok: false, retryable: true, reason: describeNonWasmBody(data) };
    }
    const declaredLength = res.headers.get("content-length");
    if (declaredLength !== null) {
      const expectedBytes = Number.parseInt(declaredLength, 10);
      if (Number.isFinite(expectedBytes) && expectedBytes !== data.length) {
        return {
          ok: false,
          retryable: true,
          reason:
            `The download reported Content-Length: ${expectedBytes} but only ` +
            `${data.length} bytes arrived — a truncated transfer.`,
        };
      }
    }
    const expectedHash = loadGrammarManifest()?.grammars[filename];
    if (expectedHash) {
      const actualHash = sha256Hex(data);
      if (actualHash !== expectedHash) {
        return {
          ok: false,
          retryable: true,
          reason:
            `The download's sha256 (${shortHash(actualHash)}) does not match the ` +
            `pinned manifest (${shortHash(expectedHash)}) — a corrupt or truncated transfer.`,
        };
      }
    }
    writeFileAtomic(path.join(destDir, filename), data, { bestEffort: false });
    return { ok: true, retryable: true };
  } catch {
    return { ok: false, retryable: true };
  }
}

export async function downloadGrammar(destDir: string, filename: string): Promise<boolean> {
  return (await downloadGrammarDetailed(destDir, filename)).ok;
}
