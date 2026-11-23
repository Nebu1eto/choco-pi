import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpConnection } from "../src/acp/session.ts";
import type {
  PiPromptDisposition,
  PiPromptHooks,
  PiRpcEvent,
  PiRpcProcessLike,
} from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiExtensionUiResponse,
  PiMessages,
  PiPromptImage,
  PiState,
} from "../src/pi-rpc/protocol.ts";

export type AcpConnectionLike = AcpConnection;

type RecordedPrompt = {
  message: string;
  attachments: PiPromptImage[];
  respondFrame: () => void;
};

export class FakeAgentSideConnection implements AcpConnectionLike {
  readonly updates: SessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  nextPermissionResponse: RequestPermissionResponse = {
    outcome: { outcome: "selected", optionId: "allow" },
  };

  async sessionUpdate(msg: SessionNotification): Promise<void> {
    this.updates.push(msg);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    return this.nextPermissionResponse;
  }
}

export class FakePiRpcProcess implements PiRpcProcessLike {
  private handlers: Array<(ev: PiRpcEvent) => void> = [];

  readonly prompts: RecordedPrompt[] = [];
  readonly extensionUiResponses: PiExtensionUiResponse[] = [];
  abortCount = 0;
  promptResponder: (message: string) => Promise<PiPromptDisposition> = async () => "started";
  acknowledgeImmediately = true;

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(ev: PiRpcEvent): void {
    for (const h of this.handlers) h(ev);
  }

  async prompt(
    message: string,
    attachments: PiPromptImage[] = [],
    hooks: PiPromptHooks = {},
  ): Promise<PiPromptDisposition> {
    const respondFrame = (): void => hooks.onResponseFrame?.();
    this.prompts.push({ message, attachments, respondFrame });
    if (this.acknowledgeImmediately) respondFrame();
    const disposition = await this.promptResponder(message);
    respondFrame();
    return disposition;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    this.extensionUiResponses.push(response);
  }

  async getState(): Promise<PiState> {
    return {};
  }

  async getAvailableModels(): Promise<PiAvailableModels> {
    return { models: [{ provider: "test", id: "model", name: "model" }] };
  }

  async getMessages(): Promise<PiMessages> {
    return { messages: [] };
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AcpConnectionLike {
  return conn;
}
