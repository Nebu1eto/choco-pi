import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  resolveSyntheticClientOptions,
  SyntheticClient,
  type SyntheticUtilityApiConfig,
} from "../../src/client/index.ts";
import { ensureSyntheticConfig } from "../../src/config-state.ts";
import type { QuotasResult } from "../../src/types/quotas.ts";
import { QuotasComponent } from "./components/quotas-display.ts";

const MISSING_AUTH_MESSAGE =
  "Synthetic quotas requires a Synthetic subscription or an unauthenticated proxy. Add credentials to ~/.pi/agent/auth.json, set SYNTHETIC_API_KEY, or disable proxy auth in /synthetic:settings.";

async function buildQuotasClient(
  config: SyntheticUtilityApiConfig,
  getApiKey: () => Promise<string | undefined>,
): Promise<SyntheticClient | undefined> {
  const options = await resolveSyntheticClientOptions(config, getApiKey);
  if (!options) return undefined;

  return new SyntheticClient(options);
}

interface QuotasClient {
  quotas(options?: { signal?: AbortSignal }): Promise<QuotasResult>;
}

export interface QuotasCommandDependencies {
  ensureConfig: typeof ensureSyntheticConfig;
  buildClient: (
    config: SyntheticUtilityApiConfig,
    getApiKey: () => Promise<string | undefined>,
  ) => Promise<QuotasClient | undefined>;
}

const DEFAULT_DEPENDENCIES: QuotasCommandDependencies = {
  ensureConfig: ensureSyntheticConfig,
  buildClient: buildQuotasClient,
};

export async function handleQuotasCommand(
  _args: string,
  ctx: ExtensionCommandContext,
  isCurrent: () => boolean,
  dependencies: QuotasCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (!isCurrent()) return;
  const config = await dependencies.ensureConfig();
  if (!isCurrent()) return;
  if (!config.quotasCommand) {
    if (!isCurrent()) return;
    ctx.ui.notify(
      "Synthetic quotas command is disabled. Restart Pi to unload the command after re-enabling or disabling it.",
      "warning",
    );
    return;
  }

  const client = await dependencies.buildClient(config, async () => {
    if (!isCurrent()) return undefined;
    return ctx.modelRegistry.getApiKeyForProvider("synthetic");
  });
  if (!isCurrent()) return;
  if (!client) {
    if (!isCurrent()) return;
    ctx.ui.notify(MISSING_AUTH_MESSAGE, "warning");
    return;
  }
  const quotasClient = client;

  if (!isCurrent()) return;
  const ui = ctx.ui;
  const custom = ui.custom.bind(ui);
  const result = await custom<null>((tui, theme, _kb, done) => {
    const controller = new AbortController();
    const component = new QuotasComponent(
      theme,
      tui,
      () => {
        controller.abort();
        done(null);
      },
      () => {
        component.setState({ type: "loading" });
        tui.requestRender();
        void loadQuotas();
      },
    );

    async function loadQuotas(): Promise<void> {
      const fetchResult = await quotasClient.quotas({
        signal: controller.signal,
      });
      if (!isCurrent() || controller.signal.aborted) return;
      if (fetchResult.success) {
        component.setState({
          type: "loaded",
          quotas: fetchResult.data.quotas,
        });
      } else {
        component.setState({
          type: "error",
          message: fetchResult.error.message,
        });
      }
      tui.requestRender();
    }

    void loadQuotas();

    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => component.handleInput(data),
      dispose: () => {
        controller.abort();
        component.destroy();
      },
    };
  });
  if (!isCurrent()) return;

  // Non-interactive fallback (RPC, print, JSON modes)
  if (result === undefined) {
    const fetchResult = await quotasClient.quotas();
    if (!isCurrent()) return;
    if (!fetchResult.success) {
      if (!isCurrent()) return;
      ctx.ui.notify(JSON.stringify({ error: fetchResult.error.message }), "error");
      return;
    }
    if (!isCurrent()) return;
    ctx.ui.notify(JSON.stringify(fetchResult.data.quotas), "info");
  }
}
