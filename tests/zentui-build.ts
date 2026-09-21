import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
/**
 * Loading the real zentui from a test process.
 *
 * zentui ships TypeScript sources. Pi transpiles them for the session, but a
 * plain `node --test` process only strips types, which zentui's parameter
 * properties defeat. This helper compiles the package once with the project's
 * own TypeScript and loads that output, so the review's frame contract is
 * checked against zentui itself rather than a stand-in.
 *
 * The output goes to the repository's `node_modules` cache: emitting there,
 * rather than a temporary directory, keeps zentui's bare imports resolvable.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, extname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  resolveZentuiFile,
  type ZentuiLoader,
  type ZentuiModules,
} from "../.pi/extensions/review/ui/zentui-frame.ts";

const REPOSITORY_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
/** The fork this repository pins, after it was renamed from `pi-zentui`. */
const PINNED_MANIFEST = resolvePath(REPOSITORY_ROOT, ".pi/packages/choco-pi-ui/package.json");
const execFileAsync = promisify(execFile);
const COMPLETION_MARKER = ".complete";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function compileZentui(): Promise<string | undefined> {
  // The pinned fork is the copy the session loads; the adapter's lookup still
  // covers an installed package or a fork pinned elsewhere.
  const manifest = (await pathExists(PINNED_MANIFEST))
    ? PINNED_MANIFEST
    : resolveZentuiFile("package.json");
  if (!manifest) return undefined;
  const sourceDirectory = resolvePath(dirname(manifest), "extensions/zentui");
  const compiler = resolvePath(REPOSITORY_ROOT, "node_modules/.bin/tsc");
  if (!(await pathExists(compiler))) return undefined;
  let sources: string[];
  let compilerVersion: string;
  try {
    sources = (await readdir(sourceDirectory))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => resolvePath(sourceDirectory, entry))
      .sort();
    ({ stdout: compilerVersion } = await execFileAsync(compiler, ["--version"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }));
  } catch {
    return undefined;
  }
  if (sources.length === 0) return undefined;
  let sourceContents: Buffer[];
  try {
    sourceContents = await Promise.all(sources.map(async (source) => await readFile(source)));
  } catch {
    return undefined;
  }
  const hash = createHash("sha256");
  hash.update(compilerVersion);
  for (const [index, source] of sources.entries()) {
    hash.update("\0");
    hash.update(relative(sourceDirectory, source));
    hash.update("\0");
    hash.update(sourceContents[index]);
  }
  const cacheRoot =
    process.env.CHOCO_PI_ZENTUI_CACHE_ROOT ??
    resolvePath(REPOSITORY_ROOT, "node_modules/.cache/choco-pi-zentui");
  const outDir = resolvePath(cacheRoot, hash.digest("hex"));
  const marker = resolvePath(outDir, COMPLETION_MARKER);
  if (await pathExists(marker)) return outDir;

  const temporaryOutDir = `${outDir}.tmp-${process.pid}`;
  try {
    await mkdir(cacheRoot, { recursive: true });
    await rm(temporaryOutDir, { force: true, recursive: true });
    await execFileAsync(
      compiler,
      [
        "--ignoreConfig",
        ...sources,
        "--outDir",
        temporaryOutDir,
        "--target",
        "esnext",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--noCheck",
        "--skipLibCheck",
      ],
      { cwd: REPOSITORY_ROOT },
    );
    await writeFile(resolvePath(temporaryOutDir, COMPLETION_MARKER), "complete\n");
    try {
      await rename(temporaryOutDir, outDir);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
      ) {
        throw error;
      }
      await rm(temporaryOutDir, { force: true, recursive: true });
      if (!(await pathExists(marker))) return undefined;
    }
  } catch {
    await rm(temporaryOutDir, { force: true, recursive: true });
    return undefined;
  }
  return (await pathExists(resolvePath(outDir, "ui.js"))) ? outDir : undefined;
}

export const ZENTUI_BUILD = await compileZentui();
export const SKIP_WITHOUT_ZENTUI = ZENTUI_BUILD
  ? false
  : "choco-pi-ui could not be compiled for tests";

let hooksRegistered = false;
/** zentui's relative imports carry no extension, which Node ESM requires. */
function registerBuildHooks(buildDirectory: string): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const parent = context.parentURL;
      if (
        specifier.startsWith(".") &&
        parent?.startsWith("file:") &&
        fileURLToPath(parent).startsWith(buildDirectory)
      ) {
        const target = resolvePath(dirname(fileURLToPath(parent)), specifier);
        if (extname(target) === "") {
          return { url: pathToFileURL(`${target}.js`).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * Imports one compiled zentui module by file name, e.g. `working-line.js`.
 *
 * Guard the call with `SKIP_WITHOUT_ZENTUI`; it throws when the package could
 * not be compiled, rather than silently returning a stand-in.
 */
export async function loadZentuiModule(file: string): Promise<Record<string, RuntimeValue>> {
  if (!ZENTUI_BUILD) throw new Error("choco-pi-ui could not be compiled for tests");
  registerBuildHooks(ZENTUI_BUILD);
  return import(pathToFileURL(resolvePath(ZENTUI_BUILD, file)).href);
}

/** Loads zentui's real renderers, config reader, and provider labels. */
export const realZentuiLoader: ZentuiLoader = async () => {
  if (!ZENTUI_BUILD) return undefined;
  registerBuildHooks(ZENTUI_BUILD);
  const load = async (file: string): Promise<Record<string, RuntimeValue>> =>
    await import(pathToFileURL(resolvePath(ZENTUI_BUILD, file)).href);
  const [editor, config, ui, format] = await Promise.all([
    load("minimalist-editor.js"),
    load("config.js"),
    load("ui.js"),
    load("format.js"),
  ]);
  // SAFETY: The fixture supplies every host member exercised by this test.
  return {
    renderMinimalistFrame: editor.renderMinimalistFrame,
    loadConfig: config.loadConfig,
    renderPolishedEditorFrame: ui.renderPolishedEditorFrame,
    formatProviderLabel: format.formatProviderLabel,
  } as ZentuiModules;
};

/**
 * The user's own zentui config decides the prompt style, so a test that asserts
 * one style pins it rather than depending on whatever is configured here.
 */
/**
 * Overrides editor config keys on top of the loaded configuration.
 *
 * zentui's `loadConfig` reads the developer's real config file, so a test that
 * asserts a fixed frame layout has to pin every setting that moves rows;
 * otherwise a local preference such as `paddingRows` decides the assertion.
 */
export function withEditorConfig(
  loader: ZentuiLoader,
  patch: Record<string, RuntimeValue>,
): ZentuiLoader {
  return async () => {
    const modules = await loader();
    if (!modules) return undefined;
    return {
      ...modules,
      loadConfig: () => {
        // SAFETY: The fixture supplies every host member exercised by this test.
        const config = modules.loadConfig() as Record<string, RuntimeValue>;
        // SAFETY: The fixture supplies every host member exercised by this test.
        const components = (config.components ?? {}) as Record<string, RuntimeValue>;
        // SAFETY: The fixture supplies every host member exercised by this test.
        const editor = (components.editor ?? {}) as Record<string, RuntimeValue>;
        return {
          ...config,
          components: { ...components, editor: { ...editor, ...patch } },
        };
      },
    };
  };
}

export function withEditorStyle(loader: ZentuiLoader, style: string): ZentuiLoader {
  return withEditorConfig(loader, { style });
}

/** zentui as it draws the box: the style the polished renderer never handles. */
export const realBoxZentuiLoader: ZentuiLoader = withEditorStyle(realZentuiLoader, "minimalist");

export const unavailableZentuiLoader: ZentuiLoader = async () => undefined;
