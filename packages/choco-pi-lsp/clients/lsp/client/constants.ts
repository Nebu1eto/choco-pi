import { ADVERTISED_POSITION_ENCODINGS } from "../position-encoding.ts";

export const INITIALIZE_TIMEOUT_MS = positiveIntFromEnv("CHOCO_PI_LSP_LSP_INIT_TIMEOUT_MS", 15_000);

export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ADVERTISED_POSITION_ENCODINGS },
  window: {},
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: true,
    },
    completion: {
      dynamicRegistration: false,
      completionItem: { snippetSupport: false },
    },
    hover: { dynamicRegistration: false },
    signatureHelp: { dynamicRegistration: false },
    definition: { dynamicRegistration: false },
    typeDefinition: { dynamicRegistration: false },
    implementation: { dynamicRegistration: false },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false },
    codeAction: { dynamicRegistration: false },
    rename: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
    },
  },
} as const;
export const NAV_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_NAV_REQUEST_TIMEOUT_MS",
  10_000,
);
export const DIAGNOSTICS_WAIT_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_DIAGNOSTICS_WAIT_MS",
  10_000,
);
export const PULL_DIAGNOSTICS_RETRY_INTERVAL_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_PULL_RETRY_INTERVAL_MS",
  250,
);
export const PULL_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_PULL_REQUEST_TIMEOUT_MS",
  10_000,
);
export const PULL_MIN_USABLE_BUDGET_MS = 5;
export const SHUTDOWN_REQUEST_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_SHUTDOWN_TIMEOUT_MS",
  1000,
);
export const EXIT_NOTIFY_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_EXIT_NOTIFY_TIMEOUT_MS",
  1000,
);
export const LIVENESS_PING_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_LIVENESS_PING_TIMEOUT_MS",
  300,
);
export const LIVENESS_PING_QUERY = "__pi_lens_liveness_ping__";
export const WORKSPACE_PULL_RESULT_CACHE_MAX = 4096;
export const WORKSPACE_PULL_SCOPE = "*workspace*";
export const REFRESH_REPULL_CONCURRENCY = 4;

export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
export const EXECUTE_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_EXECUTE_COMMAND_TIMEOUT_MS",
  30_000,
);
export const PROBE_COMMAND_TIMEOUT_MS = positiveIntFromEnv(
  "CHOCO_PI_LSP_LSP_PROJECT_IDENTITY_PROBE_TIMEOUT_MS",
  2_500,
);

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
