/**
 * extension-selection.ts — Extension allowlist/denylist parsing, package name warming, and ext: selectors.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostString } from "./result-collection.ts";

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name =
    base === "index.ts" || base === "index.js"
      ? basename(dirname(extPath))
      : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `choco-pi-subagents`, so a looser rule would misattribute every co-located
 * file to `choco-pi-subagents`.
 */
async function readExtensionPackageName(extPath: string): Promise<string | undefined> {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
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

/**
 * Package names resolved by {@link warmExtensionPackageNames}, keyed by
 * extension path. Pi calls the loader's `extensionsOverride` and the tool-scope
 * hooks synchronously, so the manifests are read asynchronously beforehand and
 * the synchronous name lookups below only read this map.
 */
const extensionPackageNames = new Map<string, string | undefined>();

/**
 * (Re-)read the owning package manifest of every path, concurrently, so
 * {@link extensionCanonicalNames} reflects the manifests as they are now.
 */
export async function warmExtensionPackageNames(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)];
  const names = await Promise.all(unique.map((path) => readExtensionPackageName(path)));
  unique.forEach((path, index) => extensionPackageNames.set(path, names[index]));
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 *
 * The package name comes from the cache {@link warmExtensionPackageNames}
 * fills; a path that was never warmed answers to its path-derived name only.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageNames.get(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/** Preserve loader-owned inline resources while filtering configured extensions by name. */
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

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
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

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
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
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
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
