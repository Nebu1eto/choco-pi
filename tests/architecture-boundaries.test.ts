import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const KNOWN_LEGACY_CYCLES: readonly (readonly string[])[] = [];

const KNOWN_PACKAGE_TO_PROFILE_EDGES: readonly string[] = [
  "packages/choco-pi-subagents -> profile",
];

const KNOWN_UI_PACKAGE_DEPENDENCIES: readonly string[] = [];

const KNOWN_OUT_OF_BUCKET_IMPORTS: readonly string[] = [];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "tests", "fixtures", ".git"]);
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;
const BUNDLE_FILE_PATTERN = /\.bundle\.js$/;

const FROM_SPECIFIER = /\bfrom\s*["']([^"'\n]+)["']/g;
const SIDE_EFFECT_SPECIFIER = /\bimport\s*["']([^"'\n]+)["']/g;
const DYNAMIC_SPECIFIER = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;

interface SourceFile {
  bucket: string;
  path: string;
}

interface ImportEdge {
  from: string;
  to: string;
  file: string;
  specifier: string;
}

interface WorkspaceGraph {
  buckets: string[];
  edges: ImportEdge[];
  outOfBucket: ImportEdge[];
}

const PackageManifestSchema = obj({ name: opt(str()) }, { open: true });
const isPackageManifest = compile(PackageManifestSchema).check;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isSourceFile(name: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
    !TEST_FILE_PATTERN.test(name) &&
    !BUNDLE_FILE_PATTERN.test(name)
  );
}

async function collectSourceFiles(directory: string, bucket: string): Promise<SourceFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<SourceFile[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.has(entry.name) ? [] : collectSourceFiles(path, bucket);
      }
      return entry.isFile() && isSourceFile(entry.name) ? [{ bucket, path }] : [];
    }),
  );
  return nested.flat();
}

async function packageBuckets(): Promise<string[]> {
  const entries = await readdir(join(REPO_ROOT, "packages"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

async function workspaceNames(buckets: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const bucket of buckets) {
    if (!bucket.startsWith("packages/")) continue;
    const manifest: unknown = JSON.parse(
      await readFile(join(REPO_ROOT, bucket, "package.json"), "utf8"),
    );
    if (isPackageManifest(manifest) && manifest.name) names.set(manifest.name, bucket);
  }
  return names;
}

function extractSpecifiers(source: string): string[] {
  const code = source.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, "");
  const specifiers: string[] = [];
  for (const pattern of [FROM_SPECIFIER, SIDE_EFFECT_SPECIFIER, DYNAMIC_SPECIFIER]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function bucketOfRepoPath(repoPath: string, buckets: readonly string[]): string | undefined {
  return buckets.find((bucket) => repoPath === bucket || repoPath.startsWith(`${bucket}/`));
}

function workspaceBucket(
  specifier: string,
  names: ReadonlyMap<string, string>,
): string | undefined {
  for (const [name, bucket] of names) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return bucket;
  }
  return undefined;
}

interface ScanContext {
  buckets: readonly string[];
  names: ReadonlyMap<string, string>;
  edges: ImportEdge[];
  outOfBucket: ImportEdge[];
}

function recordSpecifier(scan: ScanContext, file: SourceFile, specifier: string): void {
  const repoFile = toPosix(relative(REPO_ROOT, file.path));
  if (!specifier.startsWith(".")) {
    const bucket = workspaceBucket(specifier, scan.names);
    if (bucket !== undefined && bucket !== file.bucket) {
      scan.edges.push({ from: file.bucket, to: bucket, file: repoFile, specifier });
    }
    return;
  }
  const target = toPosix(relative(REPO_ROOT, resolve(dirname(file.path), specifier)));
  const bucket = bucketOfRepoPath(target, scan.buckets);
  if (bucket === undefined) {
    scan.outOfBucket.push({ from: file.bucket, to: target, file: repoFile, specifier });
  } else if (bucket !== file.bucket) {
    scan.edges.push({ from: file.bucket, to: bucket, file: repoFile, specifier });
  }
}

async function buildWorkspaceGraph(): Promise<WorkspaceGraph> {
  const buckets = [...(await packageBuckets()), "profile"];
  const scan: ScanContext = {
    buckets,
    names: await workspaceNames(buckets),
    edges: [],
    outOfBucket: [],
  };
  const files = (
    await Promise.all(buckets.map((bucket) => collectSourceFiles(join(REPO_ROOT, bucket), bucket)))
  ).flat();
  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file.path, "utf8");
      for (const specifier of extractSpecifiers(source)) recordSpecifier(scan, file, specifier);
    }),
  );
  return { buckets, edges: scan.edges, outOfBucket: scan.outOfBucket };
}

function adjacency(edges: readonly ImportEdge[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = graph.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    graph.set(edge.from, targets);
  }
  return graph;
}

function graphNodes(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const nodes = new Set(graph.keys());
  for (const targets of graph.values()) for (const target of targets) nodes.add(target);
  return [...nodes].sort();
}

function canonicalCycle(cycle: readonly string[]): string[] {
  let start = 0;
  cycle.forEach((node, index) => {
    if (node < (cycle[start] ?? node)) start = index;
  });
  return [...cycle.slice(start), ...cycle.slice(0, start)];
}

function cycleKey(cycle: readonly string[]): string {
  const ordered = canonicalCycle(cycle);
  return [...ordered, ordered[0] ?? ""].join(" -> ");
}

function simpleCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  for (const start of graphNodes(graph)) {
    const path = [start];
    const onPath = new Set([start]);
    const visit = (node: string): void => {
      for (const next of [...(graph.get(node) ?? [])].sort()) {
        if (next === start) {
          cycles.push([...path]);
        } else if (next > start && !onPath.has(next)) {
          path.push(next);
          onPath.add(next);
          visit(next);
          onPath.delete(next);
          path.pop();
        }
      }
    };
    visit(start);
  }
  return cycles;
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let counter = 0;
  const connect = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member = stack.pop();
    while (member !== undefined) {
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
      member = stack.pop();
    }
    if (component.length >= 2) components.push(component.sort());
  };
  for (const node of graphNodes(graph)) if (!index.has(node)) connect(node);
  return components.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

function describeCycle(cycle: readonly string[], edges: readonly ImportEdge[]): string {
  const ordered = canonicalCycle(cycle);
  const hops = ordered.map((from, position) => {
    const to = ordered[(position + 1) % ordered.length] ?? from;
    const files = edges
      .filter((edge) => edge.from === from && edge.to === to)
      .map((edge) => `    ${edge.file}: ${edge.specifier}`)
      .sort();
    return [`  ${from} -> ${to}`, ...files].join("\n");
  });
  return [cycleKey(cycle), ...hops].join("\n");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

const graphPromise = buildWorkspaceGraph();

test("the workspace scan sees every package bucket and real cross-package imports", async () => {
  const graph = await graphPromise;
  assert.ok(graph.buckets.includes("packages/choco-pi-codex"));
  assert.ok(graph.buckets.includes("packages/choco-pi-ui"));
  assert.ok(graph.buckets.includes("profile"));
  assert.ok(graph.edges.length > 0, "the scan must resolve at least one cross-bucket import");
});

test("the import extractor handles multi-line, re-export, dynamic and require forms", () => {
  const source = [
    "import {",
    "  first, // trailing note",
    "  second,",
    '} from "../a.ts";',
    'import type { Third } from "../b.ts";',
    'export { fourth } from "../c.ts";',
    'export * from "../d.ts";',
    'import "../e.ts";',
    "const lazy = await import(",
    '  "../f.ts"',
    ");",
    'const required = require("../g.ts");',
    '// import { ignored } from "../commented.ts";',
    '/* export * from "../block-commented.ts"; */',
  ].join("\n");
  assert.deepEqual(extractSpecifiers(source).sort(), [
    "../a.ts",
    "../b.ts",
    "../c.ts",
    "../d.ts",
    "../e.ts",
    "../f.ts",
    "../g.ts",
  ]);
});

test("cycle detection finds two- and three-package cycles and their components", () => {
  const edge = (from: string, to: string): ImportEdge => ({ from, to, file: from, specifier: to });
  const graph = adjacency([
    edge("a", "b"),
    edge("b", "a"),
    edge("b", "c"),
    edge("c", "d"),
    edge("d", "b"),
    edge("e", "a"),
  ]);
  assert.deepEqual(simpleCycles(graph).map(cycleKey).sort(), ["a -> b -> a", "b -> c -> d -> b"]);
  assert.deepEqual(stronglyConnectedComponents(graph), [["a", "b", "c", "d"]]);
});

test("no package-level import cycle exists beyond the documented legacy baseline", async () => {
  const graph = await graphPromise;
  const edges = adjacency(graph.edges);
  const cycles = simpleCycles(edges);
  const known = new Set(KNOWN_LEGACY_CYCLES.map(cycleKey));
  const detected = new Set(cycles.map(cycleKey));
  const introduced = cycles.filter((cycle) => !known.has(cycleKey(cycle)));
  assert.equal(
    introduced.length,
    0,
    [
      "New package import cycles; fix them, never add them to KNOWN_LEGACY_CYCLES:",
      ...introduced.map((cycle) => describeCycle(cycle, graph.edges)),
    ].join("\n"),
  );
  assert.deepEqual(
    [...known].filter((key) => !detected.has(key)),
    [],
    "These legacy cycles no longer exist; remove them from KNOWN_LEGACY_CYCLES",
  );
  const knownMembers = new Set(KNOWN_LEGACY_CYCLES.flat());
  for (const component of stronglyConnectedComponents(edges)) {
    assert.deepEqual(
      component.filter((bucket) => !knownMembers.has(bucket)),
      [],
      `Strongly connected buckets outside the legacy baseline: ${component.join(", ")}`,
    );
  }
});

test("package imports of profile/ stay within the ratcheted baseline", async () => {
  const graph = await graphPromise;
  const actual = uniqueSorted(
    graph.edges
      .filter((edge) => edge.from.startsWith("packages/") && edge.to === "profile")
      .map((edge) => `${edge.from} -> ${edge.to}`),
  );
  assert.deepEqual(
    actual,
    [...KNOWN_PACKAGE_TO_PROFILE_EDGES].sort(),
    "Packages must not gain profile/ imports; shrink KNOWN_PACKAGE_TO_PROFILE_EDGES when one goes away",
  );
});

test("choco-pi-ui imports no first-party bucket beyond the ratcheted baseline", async () => {
  const graph = await graphPromise;
  const actual = uniqueSorted(
    graph.edges.filter((edge) => edge.from === "packages/choco-pi-ui").map((edge) => edge.to),
  );
  assert.deepEqual(
    actual,
    [...KNOWN_UI_PACKAGE_DEPENDENCIES].sort(),
    "choco-pi-ui is a shared leaf; shrink KNOWN_UI_PACKAGE_DEPENDENCIES when one goes away",
  );
});

test("relative imports do not escape the scanned buckets beyond the baseline", async () => {
  const graph = await graphPromise;
  const actual = uniqueSorted(graph.outOfBucket.map((edge) => `${edge.from} -> ${edge.to}`));
  assert.deepEqual(
    actual,
    [...KNOWN_OUT_OF_BUCKET_IMPORTS].sort(),
    "Relative imports must stay inside packages/* and profile/; shrink KNOWN_OUT_OF_BUCKET_IMPORTS when one goes away",
  );
});

test("choco-pi-shared has zero outgoing dependencies on packages or profile", async () => {
  const graph = await graphPromise;
  const outgoing = uniqueSorted(
    graph.edges.filter((edge) => edge.from === "packages/choco-pi-shared").map((edge) => edge.to),
  );
  assert.deepEqual(outgoing, [], "@choco-pi/shared must remain a zero-dependency bottom layer");
});

test("choco-pi-code-mode imports neither choco-pi-codex nor profile/", async () => {
  const graph = await graphPromise;
  assert.ok(graph.buckets.includes("packages/choco-pi-code-mode"));
  const outgoing = uniqueSorted(
    graph.edges
      .filter((edge) => edge.from === "packages/choco-pi-code-mode")
      .map((edge) => edge.to),
  );
  assert.deepEqual(
    outgoing.filter((bucket) => bucket === "packages/choco-pi-codex" || bucket === "profile"),
    [],
    "Universal Code Mode must load without the Codex provider and the profile tree",
  );
  assert.deepEqual(
    outgoing,
    ["packages/choco-pi-shared"],
    "choco-pi-code-mode depends only on @choco-pi/shared among first-party buckets",
  );
});
