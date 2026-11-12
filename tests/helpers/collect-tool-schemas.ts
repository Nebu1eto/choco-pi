/**
 * Child-process collector for "tests/tool-io-naming.test.ts".
 *
 * Loads every repository extension entry (each ".pi/packages/<name>/package.json"
 * "pi.extensions" entry plus the project-local ".pi/extensions" entries) with
 * Pi's own extension loader and prints the parameter schema of every tool
 * registered during load. Run it with PI_CODING_AGENT_DIR and HOME pointing at
 * an empty scratch directory so nothing under ~/.pi is read.
 *
 * Output: one stdout line "TOOL_SCHEMAS_JSON:{tools,failures}", then exit 0.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";
import {
  discoverAndLoadExtensions,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isFunction, reinterpretHostValue } from "../../.pi/extensions/lib/runtime-values.ts";

export const OUTPUT_PREFIX = "TOOL_SCHEMAS_JSON:";

export type CollectedTool = { source: string; parameters: unknown };
export type CollectedSchemas = {
  tools: Record<string, CollectedTool>;
  /** Entries Pi's loader could not load, with its error. */
  failures: Record<string, string>;
  /** For each failed entry: "loaded" when a plain Node import with a stub API registered its tools, else why not. */
  fallback: Record<string, string>;
};

/** The part of a package manifest Pi reads for extension entries. */
const packageManifest = compile(
  obj({ pi: opt(obj({ extensions: opt(arr(str())) }, { open: true })) }, { open: true }),
);

async function kind(target: string): Promise<"file" | "dir" | undefined> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return "dir";
    return info.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** Pi's one-level directory discovery: "*.ts" files and "<dir>/index.ts". */
async function entriesInDirectory(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const candidate = path.join(dir, name);
    const candidateKind = await kind(candidate);
    if (candidateKind === "file" && name.endsWith(".ts")) found.push(candidate);
    else if (candidateKind === "dir" && (await kind(path.join(candidate, "index.ts"))) === "file") {
      found.push(path.join(candidate, "index.ts"));
    }
  }
  return found;
}

/** Every "pi.extensions" entry of the repository's packages, expanded to files. */
export async function packageExtensionEntries(root: string): Promise<string[]> {
  const packagesDir = path.join(root, ".pi", "packages");
  const entries: string[] = [];
  for (const name of (await readdir(packagesDir)).sort()) {
    const manifestPath = path.join(packagesDir, name, "package.json");
    if ((await kind(manifestPath)) !== "file") continue;
    const manifest = packageManifest.validate(JSON.parse(await readFile(manifestPath, "utf8")));
    if (!manifest.ok) throw new Error(`${manifestPath}: invalid package manifest`);
    for (const entry of manifest.value.pi?.extensions ?? []) {
      const resolved = path.resolve(packagesDir, name, entry);
      const resolvedKind = await kind(resolved);
      if (resolvedKind === "dir") entries.push(...(await entriesInDirectory(resolved)));
      else if (resolvedKind === "file") entries.push(resolved);
    }
  }
  return entries;
}

/**
 * Second chance for an entry Pi's loader rejected (its jiti alias table cannot
 * resolve some host subpaths outside a real Pi process): import it natively and
 * run its factory against a stub API that only records registerTool calls.
 */
async function registerWithStubApi(
  entry: string,
  onTool: (tool: ToolDefinition) => void,
): Promise<string> {
  try {
    const loaded: { default?: unknown } = await import(pathToFileURL(entry).href);
    if (!isFunction(loaded.default)) return "no default factory export";
    const noop = () => undefined;
    const events = { on: noop, emit: noop };
    const api = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "registerTool") return onTool;
          return key === "events" ? events : noop;
        },
      },
    );
    const factory = reinterpretHostValue<ExtensionFactory>(loaded.default);
    const settled = await Promise.race([
      Promise.resolve(factory(reinterpretHostValue<ExtensionAPI>(api))).then(() => "loaded"),
      new Promise<string>((resolve) => setTimeout(() => resolve("loaded"), 5_000).unref()),
    ]);
    return settled;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function collectToolSchemas(
  root: string,
  agentDir: string,
): Promise<CollectedSchemas> {
  const configured = await packageExtensionEntries(root);
  // Pi itself adds the project-local ".pi/extensions" entries for cwd = root.
  const result = await discoverAndLoadExtensions(configured, root, agentDir);
  const tools: Record<string, CollectedTool> = {};
  for (const extension of result.extensions) {
    const source = path.relative(root, extension.resolvedPath);
    for (const [name, registered] of extension.tools) {
      tools[name] = { source, parameters: registered.definition.parameters };
    }
  }
  const failures: Record<string, string> = {};
  const fallback: Record<string, string> = {};
  for (const failure of result.errors) {
    const entry = path.resolve(root, failure.path);
    const source = path.relative(root, entry);
    failures[source] = failure.error;
    fallback[source] = await registerWithStubApi(entry, (tool) => {
      tools[tool.name] ??= { source, parameters: tool.parameters };
    });
  }
  return { tools, failures, fallback };
}

async function main(): Promise<void> {
  const root = process.argv[2];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!root || !agentDir) {
    process.stderr.write(
      "usage: PI_CODING_AGENT_DIR=<empty dir> node collect-tool-schemas.ts <repo root>\n",
    );
    process.exit(2);
  }
  const watchdog = setTimeout(() => {
    process.stderr.write("collect-tool-schemas: extension loading did not finish within 90s\n");
    process.exit(3);
  }, 90_000);
  const collected = await collectToolSchemas(path.resolve(root), agentDir);
  clearTimeout(watchdog);
  // Extensions may leave timers or sockets open; the JSON line is the whole result.
  process.stdout.write(`\n${OUTPUT_PREFIX}${JSON.stringify(collected)}\n`, () => process.exit(0));
}

if (import.meta.main) await main();
