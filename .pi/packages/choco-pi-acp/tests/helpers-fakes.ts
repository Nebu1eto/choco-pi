import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpConnection } from "../src/acp/session.ts";
import type { PiRpcEvent, PiRpcProcessLike } from "../src/pi-rpc/process.ts";
import type {
  PiAvailableModels,
  PiExtensionUiResponse,
  PiMessages,
  PiPromptImage,
  PiState,
} from "../src/pi-rpc/protocol.ts";

/** The structural client contract `PiAcpSession` and `PiAcpAgent` call into. */
export type AcpConnectionLike = AcpConnection;

/** One recorded `session/prompt` call, kept for assertions. */
type RecordedPrompt = {
  message: string;
  attachments: PiPromptImage[];
};

/**
 * A client connection fake implementing only the ACP methods this adapter calls.
 *
 * `AgentSideConnection` holds private state, so no fake can be assignable to it;
 * `AcpConnection` is the structural contract both it and this fake satisfy.
 */
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

/** An in-process stand-in for `PiRpcProcess` that records calls and replays events. */
export class FakePiRpcProcess implements PiRpcProcessLike {
  private handlers: Array<(ev: PiRpcEvent) => void> = [];

  // spies
  readonly prompts: RecordedPrompt[] = [];
  readonly extensionUiResponses: PiExtensionUiResponse[] = [];
  abortCount = 0;

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(ev: PiRpcEvent): void {
    for (const h of this.handlers) h(ev);
  }

  async prompt(message: string, attachments: PiPromptImage[] = []): Promise<void> {
    this.prompts.push({ message, attachments });
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

/** Narrow a client fake to the structural connection contract the adapter consumes. */
export function asAgentConn(conn: FakeAgentSideConnection): AcpConnectionLike {
  return conn;
}
