import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostString } from "./result-collection.ts";

export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name =
    base === "index.ts" || base === "index.js"
      ? basename(dirname(extPath))
      : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

async function readExtensionPackageName(extPath: string): Promise<string | undefined> {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
      continue;
    }
    const packageName = hostString(pkg.name);
    const entries = pkg.pi?.extensions;
    if (
      packageName !== undefined &&
      Array.isArray(entries) &&
      entries.some((candidate) => {
        const extensionEntry = hostString(candidate);
        return extensionEntry !== undefined && resolve(dir, extensionEntry) === entry;
      })
    ) {
      const short = packageName.startsWith("@")
        ? packageName.slice(packageName.indexOf("/") + 1)
        : packageName;
      return short.toLowerCase();
    }
    return undefined;
  }
}

const extensionPackageNames = new Map<string, string | undefined>();

export async function warmExtensionPackageNames(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)];
  const names = await Promise.all(unique.map((path) => readExtensionPackageName(path)));
  unique.forEach((path, index) => extensionPackageNames.set(path, names[index]));
}

export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageNames.get(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

export function shouldKeepExtension(
  extPath: string,
  filter: {
    loadAll: boolean;
    keepNames: ReadonlySet<string>;
    excludeNames: ReadonlySet<string>;
  },
): boolean {
  if (extPath.startsWith("<inline:")) return true;
  const canons = extensionCanonicalNames(extPath);
  if (canons.some((name) => filter.excludeNames.has(name))) return false;
  return filter.loadAll || canons.some((name) => filter.keepNames.has(name));
}

export interface ExtensionSelection {
  names: Set<string>;
  paths: string[];
  wildcard: boolean;
}

export function parseExtensionsSpec(entries: string[], cwd: string): ExtensionSelection {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

export interface ExtensionToolSelection {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
}

export function parseExtSelectors(entries: string[]): ExtensionToolSelection {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}
