import { createLazyImport } from "../lazy-import.ts";

type DispatchIntegration = typeof import("./integration.ts");

const lazyIntegration = createLazyImport<DispatchIntegration>(() => import("./integration.ts"));

export function warmDispatchIntegration(): Promise<DispatchIntegration> {
  return lazyIntegration.get();
}

export function loadDispatchIntegration(): Promise<DispatchIntegration> {
  return warmDispatchIntegration();
}

export function resetDispatchIntegrationForTests(): void {
  lazyIntegration.resetForTests();
}
