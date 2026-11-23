import type { BoundaryValue } from "../boundary.ts";
import { isFunctionValue, isObjectValue, isStringValue } from "../boundary.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CustomToolDiscoveryError,
  discoverCustomToolsFromDirectories,
  getCustomToolsDir,
  getProjectCustomToolsDir,
} from "./custom-tools.ts";
import { replaceCodeModeToolsPrompt } from "./custom-tool-prompt.ts";
import { registerPublicCodeModeTools } from "./public-tools.ts";
import { SharedCodeModeRuntime, type CodeModeToolProvider } from "./shared-runtime.ts";
import { registerCodeModeEvents } from "./tool-events.ts";

// Providers in one extension instance share a process-lifetime host runtime.
// Pi replaces ExtensionAPI registrations on reload, so each API binds its own surface.
const REGISTRATION_KEY = Symbol.for("@howaboua/pi-codex-conversion.code-mode");

interface CodeModeProcessState {
  runtime: SharedCodeModeRuntime;
  boundApis: WeakSet<object>;
}

export interface RegisterCodeModeToolsOptions extends CodeModeToolProvider {}

export interface CodeModeRegistration {
  prepare(ctx?: BoundaryValue): Promise<void> | undefined;
  refreshPromptTools(systemPrompt: string, ctx?: BoundaryValue): string;
  checkpointNotebook(): Promise<void>;
  shutdownHost(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function registerCustomTools(
  pi: ExtensionAPI,
  toolsDir?: string | readonly string[],
  options: { isActive?(ctx: BoundaryValue): boolean } = {},
): Promise<CodeModeRegistration> {
  const usesDefaultDirs = toolsDir === undefined;
  const toolsDirs =
    toolsDir === undefined
      ? [getCustomToolsDir()]
      : isStringValue(toolsDir)
        ? [toolsDir]
        : [...toolsDir];
  let previousErrors = new Map<string, string>();
  return registerCodeModeTools(pi, {
    getTools: (ctx) => {
      const activeDirs =
        usesDefaultDirs && isTrustedProjectContext(ctx)
          ? [...toolsDirs, getProjectCustomToolsDir(ctx.cwd)]
          : toolsDirs;
      const discovery = discoverCustomToolsFromDirectories(activeDirs);
      previousErrors = reportCustomToolErrors(ctx, discovery.errors, previousErrors);
      return discovery.tools;
    },
    documentationPath: customToolsDocumentationPath(),
    ...options,
  });
}

function reportCustomToolErrors(
  ctx: BoundaryValue,
  errors: CustomToolDiscoveryError[],
  previous: Map<string, string>,
): Map<string, string> {
  if (!isExtensionContext(ctx)) return previous;
  const current = new Map(errors.map((error) => [error.path, error.message]));
  for (const error of errors) {
    if (previous.get(error.path) === error.message) continue;
    ctx.ui.notify(`Code Mode custom tool disabled: ${error.message}`, "error");
  }
  return current;
}

function isExtensionContext(value: BoundaryValue): value is ExtensionContext {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "ui" in value &&
    value.ui &&
    isObjectValue(value.ui) &&
    "notify" in value.ui &&
    isFunctionValue(value.ui.notify),
  );
}

function isTrustedProjectContext(value: BoundaryValue): value is ExtensionContext {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "isProjectTrusted" in value &&
    isFunctionValue(value.isProjectTrusted) &&
    value.isProjectTrusted(),
  );
}

export async function registerCodeModeTools(
  pi: ExtensionAPI,
  options: RegisterCodeModeToolsOptions,
): Promise<CodeModeRegistration> {
  const runtime = await getOrCreateRuntime(pi);
  const providerId = runtime.addProvider(options);
  let active = true;
  return {
    prepare: (ctx) => runtime.prepare(ctx),
    refreshPromptTools(systemPrompt, ctx) {
      const activeProviders = runtime.activeProviders(ctx);
      const documentationPath = activeProviders.find(
        (provider) => provider.documentationPath,
      )?.documentationPath;
      const previousSection = runtime.getPromptSection();
      const nextTools = runtime.refreshPromptTools(ctx);
      const replacement = replaceCodeModeToolsPrompt(
        systemPrompt,
        previousSection,
        nextTools,
        documentationPath,
      );
      runtime.setPromptSection(replacement.section);
      return replacement.systemPrompt;
    },
    checkpointNotebook: () => runtime.checkpointNotebook(),
    shutdownHost: () => runtime.shutdownHost(),
    async shutdown() {
      if (!active) return;
      active = false;
      runtime.removeProvider(providerId);
      if (runtime.providers.size === 0) await runtime.shutdownHost();
    },
  };
}

async function getOrCreateRuntime(pi: ExtensionAPI): Promise<SharedCodeModeRuntime> {
  // SAFETY: REGISTRATION_KEY is a module-private symbol; this module is the sole writer and validates stored legacy/runtime values before use.
  const state = pi.events as typeof pi.events & {
    [REGISTRATION_KEY]?: CodeModeProcessState | SharedCodeModeRuntime;
  };
  const existing = state[REGISTRATION_KEY];
  const processState = isProcessState(existing) ? existing : await replaceLegacyState(existing);
  state[REGISTRATION_KEY] = processState;
  if (!processState.boundApis.has(pi)) {
    processState.boundApis.add(pi);
    registerCodeModeEvents(pi, processState.runtime);
    registerPublicCodeModeTools(pi, processState.runtime);
  }
  return processState.runtime;
}

function isProcessState(value: BoundaryValue): value is CodeModeProcessState {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "runtime" in value &&
    isSharedRuntime(value.runtime) &&
    "boundApis" in value &&
    value.boundApis instanceof WeakSet,
  );
}

async function replaceLegacyState(legacy: BoundaryValue): Promise<CodeModeProcessState> {
  // 2.2.0 stored the runtime directly and retained stale providers across reloads.
  if (isSharedRuntime(legacy)) await legacy.shutdownHost();
  return { runtime: new SharedCodeModeRuntime(), boundApis: new WeakSet() };
}

function isSharedRuntime(value: BoundaryValue): value is SharedCodeModeRuntime {
  return Boolean(
    value &&
    isObjectValue(value) &&
    "providers" in value &&
    value.providers instanceof Map &&
    "shutdownHost" in value &&
    isFunctionValue(value.shutdownHost),
  );
}

function customToolsDocumentationPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const packageRoot = dirname(dirname(dirname(dirname(modulePath))));
  return join(packageRoot, "src", "tools", "code-mode", "CUSTOM-TOOLS.md");
}
