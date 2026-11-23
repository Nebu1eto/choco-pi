import type { ProtocolDictionary } from "../../tools/runtime-values.ts";
import { isRuntimeObject, isRuntimeString } from "../../tools/runtime-values.ts";

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeMapKey } from "../path-utils.ts";
import { aliasedImportTargets, referencedProjectImportTarget } from "./tsconfig-paths.ts";
import { buildModuleGraph, type WorkspaceModule } from "./workspace-modules.ts";

function isWithin(cwd: string, p: string): boolean {
  const root = path.resolve(cwd);
  const rp = path.resolve(p);
  return rp === root || rp.startsWith(root + path.sep);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function firstExistingFile(cwd: string, candidates: string[]): string[] {
  for (const c of candidates) {
    if (isWithin(cwd, c) && isFile(c)) return [normalizeMapKey(c)];
  }
  return [];
}

function sourceFilesIn(cwd: string, dir: string, ext: string): string[] {
  if (!isWithin(cwd, dir) || !isDir(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(ext))
      .map((n) => normalizeMapKey(path.join(dir, n)))
      .sort();
  } catch {
    return [];
  }
}

function resolveRelative(cwd: string, filePath: string, source: string, exts: string[]): string[] {
  const base = path.resolve(path.dirname(filePath), source);
  return firstExistingFile(cwd, [base, ...exts.map((e) => base + e)]);
}

function resolveDart(cwd: string, filePath: string, source: string): string[] {
  if (source.startsWith("package:") || source.startsWith("dart:")) return [];
  return resolveRelative(cwd, filePath, source, [".dart"]);
}

export const JS_TS_EXT_RE = /\.(mjs|cjs|mts|cts|jsx?|tsx?)$/i;

function jsTsExtensionCandidates(base: string, strippedBase: string, ext: string): string[] {
  const candidates: string[] = [];
  if (ext === ".mjs") candidates.push(`${strippedBase}.mts`);
  if (ext === ".cjs") candidates.push(`${strippedBase}.cts`);
  if (ext === ".mts") candidates.push(`${strippedBase}.mts`);
  if (ext === ".cts") candidates.push(`${strippedBase}.cts`);
  candidates.push(
    `${strippedBase}.ts`,
    `${strippedBase}.tsx`,
    `${strippedBase}.mts`,
    `${strippedBase}.cts`,
  );
  candidates.push(
    base,
    `${strippedBase}.js`,
    `${strippedBase}.jsx`,
    `${strippedBase}.mjs`,
    `${strippedBase}.cjs`,
  );
  for (const index of [
    "index.ts",
    "index.tsx",
    "index.mts",
    "index.cts",
    "index.js",
    "index.jsx",
    "index.mjs",
    "index.cjs",
  ]) {
    candidates.push(path.join(base, index));
  }
  return [...new Set(candidates)];
}

export function jsTsCandidatePaths(filePath: string, source: string): string[] {
  const base = path.resolve(path.dirname(filePath), source);
  const strippedSource = source.replace(JS_TS_EXT_RE, "");
  const strippedBase =
    strippedSource === source ? base : path.resolve(path.dirname(filePath), strippedSource);
  const ext = path.extname(source).toLowerCase();
  return jsTsExtensionCandidates(base, strippedBase, ext);
}

function findWorkspaceModuleForSpecifier(
  modules: Iterable<WorkspaceModule>,
  source: string,
): { mod: WorkspaceModule; subpath: string } | undefined {
  let best: { mod: WorkspaceModule; subpath: string } | undefined;
  for (const mod of modules) {
    let subpath: string | undefined;
    if (source === mod.name) subpath = "";
    else if (source.startsWith(`${mod.name}/`)) subpath = source.slice(mod.name.length + 1);
    if (subpath === undefined) continue;
    if (!best || mod.name.length > best.mod.name.length) best = { mod, subpath };
  }
  return best;
}

function pickExportsMain<T>(exportsField: T): string | undefined {
  if (isRuntimeString(exportsField)) return exportsField;
  if (!exportsField || !isRuntimeObject(exportsField)) return undefined;
  // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
  const obj = exportsField as ProtocolDictionary;
  const dot = obj["."] ?? obj;
  if (isRuntimeString(dot)) return dot;
  if (dot && isRuntimeObject(dot)) {
    for (const key of ["import", "require", "default"]) {
      // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
      const v = (dot as ProtocolDictionary)[key];
      if (isRuntimeString(v)) return v;
    }
  }
  return undefined;
}

function workspaceEntryCandidates(pkgRoot: string): string[] {
  let main: string | undefined;
  try {
    // SAFETY: The parsed value is consumed only through the optional fields declared here and each field is validated before use.
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8")) as {
      main?: string;
      module?: string;
      exports?: unknown;
    };
    main = pickExportsMain(pkg.exports) ?? pkg.module ?? pkg.main;
  } catch {}
  const candidates: string[] = [];
  if (main) {
    const mainPath = path.resolve(pkgRoot, main);
    const ext = path.extname(mainPath).toLowerCase();
    const stripped = mainPath.replace(JS_TS_EXT_RE, "");
    candidates.push(...jsTsExtensionCandidates(mainPath, stripped, ext));
  }
  for (const base of [pkgRoot, path.join(pkgRoot, "src")]) {
    candidates.push(
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
      path.join(base, "index.mts"),
      path.join(base, "index.cts"),
      path.join(base, "index.js"),
      path.join(base, "index.jsx"),
      path.join(base, "index.mjs"),
      path.join(base, "index.cjs"),
    );
  }
  return [...new Set(candidates)];
}

function workspaceSubpathCandidates(pkgRoot: string, subpath: string): string[] {
  const base = path.join(pkgRoot, subpath);
  const strippedSubpath = subpath.replace(JS_TS_EXT_RE, "");
  const strippedBase = strippedSubpath === subpath ? base : path.join(pkgRoot, strippedSubpath);
  const ext = path.extname(subpath).toLowerCase();
  return jsTsExtensionCandidates(base, strippedBase, ext);
}

export function resolveAliasedImport(
  cwd: string,
  specifier: string,
  importerDir: string,
): string[] {
  for (const target of aliasedImportTargets(specifier, importerDir)) {
    const ext = path.extname(target).toLowerCase();
    const stripped = target.replace(JS_TS_EXT_RE, "");
    const found = firstExistingFile(cwd, jsTsExtensionCandidates(target, stripped, ext));
    if (found.length) return found;
  }
  return [];
}

export function resolveProjectReferenceImport(
  cwd: string,
  specifier: string,
  importerDir: string,
): string[] {
  const target = referencedProjectImportTarget(specifier, importerDir);
  return target ? firstExistingFile(cwd, [target]) : [];
}

export function resolveWorkspacePackageImport(cwd: string, source: string): string[] {
  if (source.startsWith(".")) return [];
  const graph = buildModuleGraph(cwd);
  if (!graph) return [];
  const match = findWorkspaceModuleForSpecifier(graph.modules.values(), source);
  if (!match) return [];
  const candidates = match.subpath
    ? workspaceSubpathCandidates(match.mod.root, match.subpath)
    : workspaceEntryCandidates(match.mod.root);
  return firstExistingFile(cwd, candidates);
}

function resolveJsTs(cwd: string, filePath: string, source: string): string[] {
  if (!source.startsWith(".")) {
    const aliased = resolveAliasedImport(cwd, source, path.dirname(filePath));
    if (aliased.length) return aliased;
    const referenced = resolveProjectReferenceImport(cwd, source, path.dirname(filePath));
    return referenced.length ? referenced : resolveWorkspacePackageImport(cwd, source);
  }
  return firstExistingFile(cwd, jsTsCandidatePaths(filePath, source));
}

function resolveCxx(cwd: string, filePath: string, source: string): string[] {
  if (source.startsWith("<")) return [];
  const dir = path.dirname(path.resolve(filePath));
  return firstExistingFile(cwd, [
    path.resolve(dir, source),
    path.resolve(cwd, source),
    path.resolve(cwd, "include", source),
    path.resolve(cwd, "src", source),
  ]);
}

function pythonRoots(cwd: string, fileDir: string): string[] {
  let p = fileDir;
  const root = path.resolve(cwd);
  while (isWithin(cwd, p) && isFile(path.join(p, "__init__.py"))) {
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  const roots = new Set([p, root, path.join(root, "src")]);
  return [...roots].filter((r) => isDir(r));
}

function resolvePython(cwd: string, filePath: string, source: string): string[] {
  const fileDir = path.dirname(path.resolve(filePath));
  if (source.startsWith(".")) {
    const m = source.match(/^(\.+)(.*)$/);
    if (!m) return [];
    const dots = m[1].length;
    let baseDir = fileDir;
    for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
    const rest = m[2] ? m[2].split(".") : [];
    const target = path.join(baseDir, ...rest);
    return firstExistingFile(cwd, [`${target}.py`, path.join(target, "__init__.py")]);
  }
  const parts = source.split(".");
  for (const root of pythonRoots(cwd, fileDir)) {
    const target = path.join(root, ...parts);
    const found = firstExistingFile(cwd, [`${target}.py`, path.join(target, "__init__.py")]);
    if (found.length) return found;
  }
  return [];
}

function findGoModule(
  cwd: string,
  filePath: string,
): { moduleDir: string; modulePath: string } | null {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.resolve(cwd);
  while (true) {
    try {
      const content = fs.readFileSync(path.join(dir, "go.mod"), "utf-8");
      const m = content.match(/^\s*module\s+(\S+)/m);
      if (m) return { moduleDir: dir, modulePath: m[1] };
    } catch {}
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir || !isWithin(cwd, parent)) break;
    dir = parent;
  }
  return null;
}

function resolveGo(cwd: string, filePath: string, source: string): string[] {
  const mod = findGoModule(cwd, filePath);
  if (!mod) return [];
  if (source !== mod.modulePath && !source.startsWith(`${mod.modulePath}/`)) {
    return [];
  }
  const rel = source === mod.modulePath ? "" : source.slice(mod.modulePath.length + 1);
  return sourceFilesIn(cwd, path.join(mod.moduleDir, rel), ".go");
}

function javaSourceRoots(cwd: string, filePath: string): string[] {
  const root = path.resolve(cwd);
  const roots = new Set<string>();
  for (const c of ["src/main/java", "src/test/java", "src", ""]) {
    roots.add(path.join(root, c));
  }
  let p = path.dirname(path.resolve(filePath));
  while (true) {
    roots.add(p);
    if (p === root) break;
    const parent = path.dirname(p);
    if (parent === p || !isWithin(cwd, parent)) break;
    p = parent;
  }
  return [...roots].filter((r) => isDir(r));
}

function resolveJava(cwd: string, filePath: string, source: string): string[] {
  const parts = source.split(".");
  for (const root of javaSourceRoots(cwd, filePath)) {
    const asFile = firstExistingFile(cwd, [`${path.join(root, ...parts)}.java`]);
    if (asFile.length) return asFile;
    const asPkg = sourceFilesIn(cwd, path.join(root, ...parts), ".java");
    if (asPkg.length) return asPkg;
    if (parts.length > 1) {
      const dropLast = firstExistingFile(cwd, [`${path.join(root, ...parts.slice(0, -1))}.java`]);
      if (dropLast.length) return dropLast;
    }
  }
  return [];
}

export function resolveImportToFiles(
  cwd: string,
  filePath: string,
  languageId: string,
  source: string,
): string[] {
  switch (languageId) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsts":
      return resolveJsTs(cwd, filePath, source);
    case "c":
    case "cpp":
      return resolveCxx(cwd, filePath, source);
    case "ruby":
      return resolveRelative(cwd, filePath, source, [".rb"]);
    case "zig":
      return resolveRelative(cwd, filePath, source, [".zig"]);
    case "bash":
      return resolveRelative(cwd, filePath, source, [".sh", ".bash"]);
    case "dart":
      return resolveDart(cwd, filePath, source);
    case "python":
      return resolvePython(cwd, filePath, source);
    case "go":
      return resolveGo(cwd, filePath, source);
    case "java":
      return resolveJava(cwd, filePath, source);
    default:
      return [];
  }
}
