import { basename, dirname, win32 } from "node:path";
import { isGeneratedOrArtifact } from "./generated-artifacts.ts";
import { isWindowsPath } from "./path-utils.ts";

export type FileRole =
  | "source"
  | "test"
  | "init"
  | "re-export"
  | "generated"
  | "config"
  | "stub"
  | "migration";

const RE_EXPORT_LINE = /^export\s+(type\s+)?\*\s+from\s+|^export\s*\{[^}]*\}\s+from\s+/;

function isReExportBarrel(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
  return lines.length > 0 && lines.every((l) => RE_EXPORT_LINE.test(l));
}

function isTypeStub(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith("//") &&
        !l.startsWith("*") &&
        !l.startsWith("/*") &&
        l !== "{" &&
        l !== "}",
    );
  if (lines.length < 4) return false;
  const typeOnlyLines = lines.filter(
    (l) =>
      /^(export\s+)?(interface|type|abstract\s+class|declare\s+(class|function|const|var|let|module|namespace|enum))\s+/.test(
        l,
      ) ||
      /^(import\s+type\s+|import\s+\{)/.test(l) ||
      /^export\s+type\s+\{/.test(l),
  );
  return typeOnlyLines.length / lines.length >= 0.75;
}

export function detectFileRole(filePath: string, content?: string): FileRole {
  const usesWindowsPathSyntax = isWindowsPath(filePath);
  const base = (
    usesWindowsPathSyntax ? win32.basename(filePath) : basename(filePath)
  ).toLowerCase();
  const dir = (usesWindowsPathSyntax ? win32.dirname(filePath) : dirname(filePath))
    .replace(/\\/g, "/")
    .toLowerCase();

  if (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.startsWith("test_") ||
    base.startsWith("spec_") ||
    dir.includes("/__tests__/") ||
    dir.includes("/test/") ||
    dir.includes("/tests/") ||
    dir.includes("/spec/") ||
    dir.includes("/specs/") ||
    /[/_-]tests?\/?$/.test(dir) ||
    /[/_-]specs?\/?$/.test(dir)
  )
    return "test";

  if (isGeneratedOrArtifact(filePath, { content, includeDeclarations: false })) {
    return "generated";
  }

  const forwardDir = dir.replace(/\\/g, "/");
  if (
    forwardDir.includes("/migrations/") ||
    forwardDir.includes("/migration/") ||
    /\/\d{4,}_[a-z]/.test(forwardDir + "/" + base)
  )
    return "migration";

  if (
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js") ||
    base.endsWith(".config.mjs") ||
    base.endsWith(".config.cjs") ||
    base === "vite.config.ts" ||
    base === "jest.config.ts" ||
    base === "jest.config.js" ||
    base === "webpack.config.js" ||
    base === "rollup.config.js" ||
    base === "tailwind.config.js" ||
    base === "tailwind.config.ts" ||
    base === "next.config.js" ||
    base === "next.config.mjs"
  )
    return "config";

  if (base.endsWith(".d.ts")) return "stub";
  if (content && isTypeStub(content)) return "stub";

  const isIndexFile =
    base === "index.ts" ||
    base === "index.tsx" ||
    base === "index.js" ||
    base === "index.mjs" ||
    base === "index.cjs" ||
    base === "index.jsx" ||
    base === "__init__.py" ||
    base === "mod.rs";

  if (isIndexFile) {
    if (content && isReExportBarrel(content)) return "re-export";
    return "init";
  }

  return "source";
}
