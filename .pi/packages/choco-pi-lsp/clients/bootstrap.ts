import { logExtension } from "./extension-log.js";
import type { AgentBehaviorClient } from "./agent-behavior-client.js";
import type { BiomeClient } from "./biome-client.js";
import type { ComplexityClient } from "./complexity-client.js";
import type { GoClient } from "./go-client.js";
import type { MetricsClient } from "./metrics-client.js";
import type { OpengrepClient } from "./opengrep-client.js";
import type { RuffClient } from "./ruff-client.js";
import type { RustClient } from "./rust-client.js";
import type { TestRunnerClient } from "./test-runner-client.js";
import type { TodoScanner } from "./todo-scanner.js";

// choco-pi fork: the heavyweight project analyzers (knip, jscpd, madge/
// dependency-checker, gitleaks, govulncheck, trivy, dead-code/vulture) are
// removed. The bootstrap seam and its fail-soft shape are preserved for the
// remaining clients — see VENDORED.md.
export interface BootstrapClients {
  ruffClient: RuffClient;
  biomeClient: BiomeClient;
  todoScanner: TodoScanner;
  testRunnerClient: TestRunnerClient;
  metricsClient: MetricsClient;
  complexityClient: ComplexityClient;
  goClient: GoClient;
  opengrepClient: OpengrepClient;
  rustClient: RustClient;
  agentBehaviorClient: AgentBehaviorClient;
}

let bootstrapPromise: Promise<BootstrapClients> | null = null;

/**
 * A stand-in for an analysis client whose module failed to load (an unresolved
 * runtime dependency under a package-manager layout the resolver can't traverse
 * — #285/#335). Every method call no-ops to `undefined`, which every analyzer
 * consumer already treats as "nothing to report", so a single failed analyzer
 * degrades to silence instead of taking down the whole extension. This keeps the
 * fail-soft in ONE seam (the bootstrap) so consumers never special-case it —
 * the same single-seam principle as the clients/deps/* accessors.
 */
export function degradedClient<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      // Not thenable (so `await stub` / Promise.resolve(stub) won't treat it
      // as a promise), not iterable, no surprising coercion.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return () => undefined;
    },
  });
}

/**
 * One or more client modules failed to load — almost always an unresolved
 * runtime dependency under a package-manager layout the runtime's resolver can't
 * traverse (#285/#335). Name each disabled analyzer, then emit ONE paste-able
 * environment fingerprint so a reporter can tell us exactly what failed and
 * where. Best-effort: never let the diagnostic itself mask the failure.
 */
async function logBootstrapFailures(failures: { name: string; err: unknown }[]): Promise<void> {
  for (const { name, err } of failures) {
    logExtension({
      subsystem: "bootstrap",
      message: `analyzer "${name}" disabled (degraded mode): ${
        (err as Error)?.message ?? String(err)
      }`,
      metadata: { analyzer: name },
    });
  }
  try {
    const { collectInstallDiagnostics, formatInstallDiagnostics } =
      await import("./install-diagnostics.js");
    logExtension({
      subsystem: "bootstrap",
      message: formatInstallDiagnostics(collectInstallDiagnostics(), failures[0]?.err),
      metadata: { kind: "install_diagnostics" },
    });
  } catch {
    // the per-analyzer lines above already named the failures
  }
}

/**
 * Every per-client load below is individually fail-soft (`load`
 * degrades to a stub instead of throwing), so this promise is not expected to
 * reject in practice. It is still memoized with eviction-on-rejection —
 * consistent with the other lazy-import memos (#1570) — so a genuinely
 * unexpected throw (e.g. `logBootstrapFailures`) cannot latch a permanently
 * rejected bootstrap for the rest of the process.
 */
export function loadBootstrapClients(): Promise<BootstrapClients> {
  bootstrapPromise ??= (async () => {
    const failures: { name: string; err: unknown }[] = [];
    // Load + construct one client in isolation; on failure record it and
    // substitute a degraded no-op stub so the others still load — single-seam
    // fail-soft, consumers never special-case it.
    async function load<T extends object>(name: string, make: () => Promise<T>): Promise<T> {
      try {
        return await make();
      } catch (err) {
        failures.push({ name, err });
        return degradedClient<T>();
      }
    }

    const [
      ruffClient,
      biomeClient,
      todoScanner,
      testRunnerClient,
      metricsClient,
      complexityClient,
      goClient,
      opengrepClient,
      rustClient,
      agentBehaviorClient,
    ] = await Promise.all([
      load("ruff", async () => new (await import("./ruff-client.js")).RuffClient()),
      load("biome", async () => new (await import("./biome-client.js")).BiomeClient()),
      load("todo", async () => new (await import("./todo-scanner.js")).TodoScanner()),
      load(
        "test-runner",
        async () => new (await import("./test-runner-client.js")).TestRunnerClient(),
      ),
      load("metrics", async () => new (await import("./metrics-client.js")).MetricsClient()),
      load(
        "complexity",
        async () => new (await import("./complexity-client.js")).ComplexityClient(),
      ),
      load("go", async () => new (await import("./go-client.js")).GoClient()),
      load("opengrep", async () => new (await import("./opengrep-client.js")).OpengrepClient()),
      load("rust", async () => new (await import("./rust-client.js")).RustClient()),
      load(
        "agent-behavior",
        async () => new (await import("./agent-behavior-client.js")).AgentBehaviorClient(),
      ),
    ]);

    if (failures.length > 0) await logBootstrapFailures(failures);

    return {
      ruffClient,
      biomeClient,
      todoScanner,
      testRunnerClient,
      metricsClient,
      complexityClient,
      goClient,
      opengrepClient,
      rustClient,
      agentBehaviorClient,
    };
  })().catch((err: unknown) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}
