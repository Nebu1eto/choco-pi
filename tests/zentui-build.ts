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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveZentuiFile,
  type ZentuiLoader,
  type ZentuiModules,
} from "../.pi/extensions/review/ui/zentui-frame.ts";

const REPOSITORY_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
/** The fork this repository pins, after it was renamed from `pi-zentui`. */
const PINNED_MANIFEST = resolvePath(REPOSITORY_ROOT, ".pi/packages/choco-pi-ui/package.json");

function compileZentui(): string | undefined {
  // The pinned fork is the copy the session loads; the adapter's lookup still
  // covers an installed package or a fork pinned elsewhere.
  const manifest = existsSync(PINNED_MANIFEST)
    ? PINNED_MANIFEST
    : resolveZentuiFile("package.json");
  if (!manifest) return undefined;
  const sourceDirectory = resolvePath(dirname(manifest), "extensions/zentui");
  const compiler = resolvePath(REPOSITORY_ROOT, "node_modules/.bin/tsc");
  if (!existsSync(compiler)) return undefined;
  let sources: string[];
  try {
    sources = readdirSync(sourceDirectory)
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => resolvePath(sourceDirectory, entry));
  } catch {
    return undefined;
  }
  if (sources.length === 0) return undefined;
  const outDir = resolvePath(REPOSITORY_ROOT, "node_modules/.cache/choco-pi-zentui");
  try {
    execFileSync(
      compiler,
      [
        "--ignoreConfig",
        ...sources,
        "--outDir",
        outDir,
        "--target",
        "esnext",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--noCheck",
        "--skipLibCheck",
      ],
      { cwd: REPOSITORY_ROOT, stdio: "pipe" },
    );
  } catch {
    return undefined;
  }
  return existsSync(resolvePath(outDir, "ui.js")) ? outDir : undefined;
}

export const ZENTUI_BUILD = compileZentui();
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
        if (!existsSync(target) && existsSync(`${target}.js`)) {
          return { url: pathToFileURL(`${target}.js`).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
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
export function withEditorStyle(loader: ZentuiLoader, style: string): ZentuiLoader {
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
          components: { ...components, editor: { ...editor, style } },
        };
      },
    };
  };
}

/** zentui as it draws the box: the style the polished renderer never handles. */
export const realBoxZentuiLoader: ZentuiLoader = withEditorStyle(realZentuiLoader, "minimalist");

export const unavailableZentuiLoader: ZentuiLoader = async () => undefined;
