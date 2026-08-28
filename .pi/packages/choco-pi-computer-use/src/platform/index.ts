import { macosBackend } from "./macos/backend.ts";
import {
  isBrowserApp,
  isChromeFamilyApp,
  openBrowserLocationWithAppleScript,
} from "./macos/browser.ts";
import { ensureMacosReady } from "./macos/permissions.ts";
import type {
  ComputerUsePlatformBackend,
  HelperActResult,
  PlatformActRequest,
  PlatformName,
} from "./types.ts";
import { linuxBackend } from "./linux/backend.ts";
import { windowsBackend } from "./windows/backend.ts";

const macosPlatformBackend: ComputerUsePlatformBackend = {
  name: "macos",
  ensureReady: ensureMacosReady,
  listApps: macosBackend.listApps,
  listRoots: macosBackend.listRoots,
  getFrontmost: macosBackend.getFrontmost,
  focusWindow: macosBackend.focusWindow,
  observe: macosBackend.observe,
  act: macosBackend.act,
  actBatch: macosBackend.actBatch,
  readText: macosBackend.readText,
  waitFor: macosBackend.waitFor,
  isBrowserApp,
  isChromeFamilyApp,
  openBrowserLocation: openBrowserLocationWithAppleScript,
};

class UnsupportedPlatformBackend implements ComputerUsePlatformBackend {
  readonly name: PlatformName;
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
    this.name = platform === "win32" ? "windows" : "linux";
  }

  private unsupported(): never {
    throw new Error(`pi-computer-use does not support platform '${this.platform}' yet.`);
  }

  async ensureReady(): Promise<never> {
    this.unsupported();
  }
  async listApps(): Promise<never> {
    this.unsupported();
  }
  async listRoots(): Promise<never> {
    this.unsupported();
  }
  async getFrontmost(): Promise<never> {
    this.unsupported();
  }
  async focusWindow(): Promise<never> {
    this.unsupported();
  }
  async observe(): Promise<never> {
    this.unsupported();
  }
  async act(): Promise<never> {
    this.unsupported();
  }
  async readText(): Promise<never> {
    this.unsupported();
  }
  async waitFor(): Promise<never> {
    this.unsupported();
  }
  isBrowserApp(): never {
    this.unsupported();
  }
  isChromeFamilyApp(): never {
    this.unsupported();
  }
  async openBrowserLocation(): Promise<boolean> {
    this.unsupported();
  }
}

export function platformBackendForRuntime(
  platform: NodeJS.Platform = process.platform,
): ComputerUsePlatformBackend {
  if (platform === "darwin") return macosPlatformBackend;
  if (platform === "win32") return windowsBackend;
  if (platform === "linux") return linuxBackend;
  return new UnsupportedPlatformBackend(platform);
}

let activePlatformBackend = platformBackendForRuntime();

export const currentPlatformBackend: ComputerUsePlatformBackend = {
  get name() {
    return activePlatformBackend.name;
  },
  shutdown() {
    return activePlatformBackend.shutdown?.();
  },
  ensureReady(ctx, state, signal) {
    return activePlatformBackend.ensureReady(ctx, state, signal);
  },
  listApps(signal) {
    return activePlatformBackend.listApps(signal);
  },
  listRoots(query, signal) {
    return activePlatformBackend.listRoots(query, signal);
  },
  getFrontmost(signal) {
    return activePlatformBackend.getFrontmost(signal);
  },
  focusWindow(target, signal) {
    return activePlatformBackend.focusWindow(target, signal);
  },
  observe(request, options) {
    return activePlatformBackend.observe(request, options);
  },
  act(request, options) {
    return activePlatformBackend.act(request, options);
  },
  get actBatch() {
    const actBatch = activePlatformBackend.actBatch;
    return actBatch
      ? (
          requests: PlatformActRequest[],
          options?: { timeoutMs?: number; signal?: AbortSignal },
        ): Promise<HelperActResult> => actBatch.call(activePlatformBackend, requests, options)
      : undefined;
  },
  readText(args, options) {
    return activePlatformBackend.readText(args, options);
  },
  waitFor(args, options) {
    return activePlatformBackend.waitFor(args, options);
  },
  isBrowserApp(appName, bundleId) {
    return activePlatformBackend.isBrowserApp(appName, bundleId);
  },
  isChromeFamilyApp(appName, bundleId) {
    return activePlatformBackend.isChromeFamilyApp(appName, bundleId);
  },
  openBrowserLocation(target, url, signal) {
    return activePlatformBackend.openBrowserLocation(target, url, signal);
  },
};

/** Test-only backend substitution for exercising bridge state transitions without native UI access. */
export function replacePlatformBackendForTest(backend: ComputerUsePlatformBackend): () => void {
  const previous = activePlatformBackend;
  activePlatformBackend = backend;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    activePlatformBackend = previous;
  };
}
