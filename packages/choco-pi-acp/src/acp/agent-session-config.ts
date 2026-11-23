/**
 * Session configuration: the model and thinking-level options advertised to ACP clients and applied through Pi RPC.
 */
import { type SessionConfigOption, RequestError } from "@agentclientprotocol/sdk";
import type { PiState, PiAvailableModels } from "../pi-rpc/protocol.ts";
import type { PiRpcProcessLike } from "../pi-rpc/process.ts";
import { missingPiCapability } from "./agent-rpc.ts";
import type { AcpConnection } from "./session.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AdvertisedModel = {
  modelId: string;
  name: string;
  description?: string | null;
};

/** One selectable reasoning-effort entry advertised to the client. */
export type SessionModeDescriptor = {
  id: string;
  name: string;
  description?: string | null;
};

/** Reasoning-effort options plus the level Pi currently applies. */
export type ThinkingState = {
  availableModes: SessionModeDescriptor[];
  currentModeId: string;
};

/** Advertised models plus the model Pi currently applies. */
export type ModelState = {
  availableModels: AdvertisedModel[];
  currentModelId: string;
};

/** The model and reasoning selections a config-option list is rendered from. */
export type SessionConfigState = {
  models: ModelState | null;
  modes: ThinkingState;
};

/** A full session configuration snapshot returned to the client. */
export type SessionConfiguration = SessionConfigState & {
  configOptions: SessionConfigOption[];
};

/** Pi RPC answers already fetched by the caller, so configuration does not re-probe. */
export type PiPreloadedState = {
  state?: PiState | null;
  availableModels?: PiAvailableModels | null;
};

export const MODEL_CONFIG_ID = "model";

export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

export function isThinkingLevel(x: string): x is ThinkingLevel {
  return (
    x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh"
  );
}

export async function getThinkingState(
  proc: PiRpcProcessLike,
  pre?: Pick<PiPreloadedState, "state">,
): Promise<ThinkingState> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = "medium";

  const state =
    pre?.state ??
    (await (async () => {
      try {
        const getState = proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        return await getState.call(proc);
      } catch {
        return null;
      }
    })());

  const tl = state?.thinkingLevel ?? null;
  if (tl && isThinkingLevel(tl)) current = tl;

  const available: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null,
    })),
  };
}

export async function getSessionConfiguration(
  proc: PiRpcProcessLike,
  pre?: PiPreloadedState,
): Promise<SessionConfiguration> {
  const [models, modes] = await Promise.all([
    getModelState(proc, pre),
    getThinkingState(proc, { state: pre?.state }),
  ]);

  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes,
  };
}

export function buildConfigOptions(state: SessionConfigState): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: "select",
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
      name: "Thinking",
      description: "Set the reasoning effort for this session",
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null,
      })),
    },
  ];

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: "select",
      id: MODEL_CONFIG_ID,
      category: "model",
      name: "Model",
      description: "Select the model for this session",
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null,
      })),
    });
  }

  return configOptions;
}

export async function getModelState(
  proc: PiRpcProcessLike,
  pre?: PiPreloadedState,
): Promise<ModelState | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = [];

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        const getAvailableModels = proc.getAvailableModels;
        if (!getAvailableModels) throw missingPiCapability("get_available_models");
        return await getAvailableModels.call(proc);
      } catch {
        return null;
      }
    })());

  const models = data?.models ?? [];
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) continue;

    const name = String(model.name ?? id);
    availableModels.push({
      modelId: `${provider}/${id}`,
      name: `${provider}/${name}`,
      description: null,
    });
  }

  // Ask pi what model is currently active.
  let currentModelId: string | null = null;

  const state =
    pre?.state ??
    (await (async () => {
      try {
        const getState = proc.getState;
        if (!getState) throw missingPiCapability("get_state");
        return await getState.call(proc);
      } catch {
        return null;
      }
    })());

  const model = state?.model;
  if (model) {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }

  if (!availableModels.length && !currentModelId) return null;

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default",
  };
}

export async function emitConfigOptionsUpdate(
  conn: AcpConnection,
  sessionId: string,
  proc: PiRpcProcessLike,
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc);

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions,
    },
  });

  return configOptions;
}

export async function setSessionModel(
  proc: PiRpcProcessLike,
  requestedModelId: string,
): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null;
  let modelId: string | null = null;

  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }

  if (!provider) {
    const getAvailableModels = proc.getAvailableModels;
    if (!getAvailableModels) throw missingPiCapability("get_available_models");
    const data = await getAvailableModels.call(proc);
    const found = data.models.find((model) => String(model.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }

  const setModel = proc.setModel;
  if (!setModel) throw missingPiCapability("set_model");
  await setModel.call(proc, provider, modelId);
}
