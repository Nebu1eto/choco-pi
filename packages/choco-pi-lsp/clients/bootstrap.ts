import { logExtension } from "./extension-log.ts";
import { isSymbol } from "./runtime-guards.ts";
import type { AgentBehaviorClient } from "./agent-behavior-client.ts";
import type { BiomeClient } from "./biome-client.ts";
import type { ComplexityClient } from "./complexity-client.ts";
import type { GoClient } from "./go-client.ts";
import type { MetricsClient } from "./metrics-client.ts";
import type { OpengrepClient } from "./opengrep-client.ts";
import type { RuffClient } from "./ruff-client.ts";
import type { RustClient } from "./rust-client.ts";
import type { TestRunnerClient } from "./test-runner-client.ts";
import type { TodoScanner } from "./todo-scanner.ts";

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

export function degradedClient<T extends object>(): T {
  // SAFETY: The proxy implements the degraded-client invariant for every property: callable members
  return new Proxy({} as T, {
    get(_target, prop) {
      if (isSymbol(prop) || prop === "then") return undefined;
      return () => undefined;
    },
  });
}

async function logBootstrapFailures(failures: { name: string; err: unknown }[]): Promise<void> {
  for (const { name, err } of failures) {
    logExtension({
      subsystem: "bootstrap",
      message: `analyzer "${name}" disabled (degraded mode): ${
        err instanceof Error ? err.message : String(err)
      }`,
      metadata: { analyzer: name },
    });
  }
  try {
    const { collectInstallDiagnostics, formatInstallDiagnostics } =
      await import("./install-diagnostics.ts");
    logExtension({
      subsystem: "bootstrap",
      message: formatInstallDiagnostics(collectInstallDiagnostics(), failures[0]?.err),
      metadata: { kind: "install_diagnostics" },
    });
  } catch {}
}

export function loadBootstrapClients(): Promise<BootstrapClients> {
  bootstrapPromise ??= (async () => {
    const failures: { name: string; err: unknown }[] = [];
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
      load("ruff", async () => new (await import("./ruff-client.ts")).RuffClient()),
      load("biome", async () => new (await import("./biome-client.ts")).BiomeClient()),
      load("todo", async () => new (await import("./todo-scanner.ts")).TodoScanner()),
      load(
        "test-runner",
        async () => new (await import("./test-runner-client.ts")).TestRunnerClient(),
      ),
      load("metrics", async () => new (await import("./metrics-client.ts")).MetricsClient()),
      load(
        "complexity",
        async () => new (await import("./complexity-client.ts")).ComplexityClient(),
      ),
      load("go", async () => new (await import("./go-client.ts")).GoClient()),
      load("opengrep", async () => new (await import("./opengrep-client.ts")).OpengrepClient()),
      load("rust", async () => new (await import("./rust-client.ts")).RustClient()),
      load(
        "agent-behavior",
        async () => new (await import("./agent-behavior-client.ts")).AgentBehaviorClient(),
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
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}
