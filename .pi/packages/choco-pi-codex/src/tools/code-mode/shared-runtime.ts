import type { BoundaryValue } from "../boundary.js";
import { ensureCodeModeHostBinary } from "./binary.js";
import { CodeModeHostClient } from "./host-client.js";
import type {
  CodeModeToolDefinition,
  NotebookControlRequest,
  NotebookControlResult,
  RuntimeResponse,
  ToolExecutionContext,
} from "./types.js";

export type CodeModeExecutionKind = "code" | "notebook";

export interface NotebookRuntimeOptions {
  maxHeapMiB: number;
  agentDir: string;
  profile?: string | undefined;
}

export interface CodeModeExecutionClient {
  execute(
    source: string,
    context: ToolExecutionContext,
    signal?: AbortSignal,
    tools?: CodeModeToolDefinition[],
  ): Promise<RuntimeResponse>;
  wait(
    cellId: string,
    yieldTimeMs: number,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<RuntimeResponse>;
  terminate(
    cellId: string,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<RuntimeResponse>;
  checkpoint?(): Promise<void>;
  controlNotebook?(
    request: NotebookControlRequest,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<NotebookControlResult>;
  shutdown(): Promise<void>;
}

export interface CodeModeToolProvider {
  getTools(ctx?: BoundaryValue): CodeModeToolDefinition[];
  documentationPath?: string | undefined;
  isActive?(ctx: BoundaryValue): boolean;
  providesRenderers?: boolean | undefined;
  richRendering?(): boolean;
  executionKind?(ctx: BoundaryValue): CodeModeExecutionKind;
  notebookOptions?(ctx: BoundaryValue): NotebookRuntimeOptions;
}

export class CodeModeProviderId {}

export class SharedCodeModeRuntime {
  readonly providers = new Map<CodeModeProviderId, CodeModeToolProvider>();
  private clientPromise: Promise<CodeModeHostClient> | undefined;
  private clientStartupAbort: AbortController | undefined;
  private customPromptToolsSnapshot: CodeModeToolDefinition[] | undefined;
  private promptSectionSnapshot: string | undefined;

  addProvider(provider: CodeModeToolProvider): CodeModeProviderId {
    const id = new CodeModeProviderId();
    this.providers.set(id, provider);
    return id;
  }

  removeProvider(id: CodeModeProviderId): void {
    this.providers.delete(id);
  }

  activeProviders(ctx?: BoundaryValue): CodeModeToolProvider[] {
    return [...this.providers.values()].filter(
      (provider) => !provider.isActive || provider.isActive(ctx),
    );
  }

  collectTools(ctx?: BoundaryValue): CodeModeToolDefinition[] {
    const tools = this.collectProviderTools(ctx);
    return this.customPromptToolsSnapshot
      ? applyCustomPromptState(tools, this.customPromptToolsSnapshot)
      : tools;
  }

  refreshPromptTools(ctx?: BoundaryValue): CodeModeToolDefinition[] {
    const tools = this.collectProviderTools(ctx);
    this.customPromptToolsSnapshot = tools.filter(isCustomTool);
    return tools;
  }

  resetPromptTools(ctx?: BoundaryValue): CodeModeToolDefinition[] {
    this.promptSectionSnapshot = undefined;
    return this.refreshPromptTools(ctx);
  }

  collectPromptTools(ctx?: BoundaryValue): CodeModeToolDefinition[] {
    if (!this.customPromptToolsSnapshot) return this.refreshPromptTools(ctx);
    const liveProgrammaticTools = this.collectProviderTools(ctx).filter(
      (tool) => !isCustomTool(tool),
    );
    return [...liveProgrammaticTools, ...this.customPromptToolsSnapshot];
  }

  setPromptSection(section: string): void {
    this.promptSectionSnapshot = section;
  }

  getPromptSection(): string | undefined {
    return this.promptSectionSnapshot;
  }

  collectRenderTools(): CodeModeToolDefinition[] {
    return collectUniqueTools(
      [...this.providers.values()].filter((provider) => provider.providesRenderers),
    );
  }

  useRichRendering(): boolean {
    return (
      [...this.providers.values()].find((provider) => provider.richRendering)?.richRendering?.() ??
      true
    );
  }

  executionKind(ctx?: BoundaryValue): CodeModeExecutionKind {
    const explicit = new Set(
      this.activeProviders(ctx)
        .map((provider) => provider.executionKind?.(ctx))
        .filter((kind): kind is CodeModeExecutionKind => Boolean(kind)),
    );
    if (explicit.size > 1) throw new Error("Conflicting code-mode execution runtimes are active");
    return explicit.values().next().value ?? "code";
  }

  async getClient(ctx?: BoundaryValue): Promise<CodeModeExecutionClient> {
    if (this.executionKind(ctx) === "notebook") {
      return Promise.reject(new Error("Notebook Mode is not included in choco-pi-codex"));
    }
    if (!this.clientPromise) {
      const startupAbort = new AbortController();
      const pending = ensureCodeModeHostBinary(startupAbort.signal).then(
        (binary) => new CodeModeHostClient({ binary, tools: [] }),
      );
      this.clientPromise = pending;
      this.clientStartupAbort = startupAbort;
      void pending.then(
        () => {
          if (this.clientPromise === pending) this.clientStartupAbort = undefined;
        },
        () => {
          if (this.clientPromise !== pending) return;
          this.clientPromise = undefined;
          this.clientStartupAbort = undefined;
        },
      );
    }
    return this.clientPromise;
  }

  prepare(ctx?: BoundaryValue): Promise<void> | undefined {
    if (this.activeProviders(ctx).length === 0) return undefined;
    return this.getClient(ctx).then(() => undefined);
  }

  async checkpointNotebook(): Promise<void> {
    // Notebook Mode was removed from this fork; nothing to checkpoint.
  }

  async shutdownHost(): Promise<void> {
    while (this.clientPromise) {
      const pending = this.clientPromise;
      this.clientPromise = undefined;
      this.clientStartupAbort?.abort();
      this.clientStartupAbort = undefined;
      try {
        await (await pending).shutdown();
      } catch {
        // Startup failure already reached the caller.
      }
    }
  }

  private collectProviderTools(ctx?: BoundaryValue): CodeModeToolDefinition[] {
    return collectUniqueTools(this.activeProviders(ctx), ctx);
  }
}

function isCustomTool(tool: CodeModeToolDefinition): boolean {
  return "command" in tool;
}

function applyCustomPromptState(
  tools: CodeModeToolDefinition[],
  customPromptTools: CodeModeToolDefinition[],
): CodeModeToolDefinition[] {
  const customPromptState = new Map(
    customPromptTools.map((tool) => [tool.name, tool.deferLoading]),
  );
  return tools.map((tool) =>
    isCustomTool(tool)
      ? {
          ...tool,
          deferLoading: customPromptState.get(tool.name) ?? true,
        }
      : tool,
  );
}

function collectUniqueTools(
  providers: CodeModeToolProvider[],
  ctx?: BoundaryValue,
): CodeModeToolDefinition[] {
  const tools = providers.flatMap((provider) => provider.getTools(ctx));
  const byName = new Map<string, CodeModeToolDefinition>();
  const unique: CodeModeToolDefinition[] = [];
  for (const tool of tools) {
    const previous = byName.get(tool.name);
    if (previous) {
      if (
        "sourcePath" in previous &&
        "sourcePath" in tool &&
        previous.sourcePath === tool.sourcePath
      )
        continue;
      throw new Error(`Duplicate code-mode tool: ${tool.name}`);
    }
    byName.set(tool.name, tool);
    unique.push(tool);
  }
  return unique;
}
