import { arr, bool, compile, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { postV1Internal, type FetchLike } from "../client/http.ts";
import {
  AntigravityError,
  RpcErrorSchema,
  acceptedValidationUrl,
  antigravityErrorFromRpc,
  antigravityMalformedResponse,
} from "../errors.ts";

/** The only client metadata agy 1.5.14 sends to loadCodeAssist and onboardUser. */
const CLIENT_METADATA = { ideType: "ANTIGRAVITY" } as const;

const CreditSchema = obj(
  {
    creditType: opt(str()),
    creditAmount: opt(union([str(), num()])),
    minimumCreditAmountForUsage: opt(union([str(), num()])),
  },
  { open: true },
);

const UserTierSchema = obj(
  {
    id: opt(str()),
    name: opt(str()),
    description: opt(str()),
    isDefault: opt(bool()),
    userDefinedCloudaicompanionProject: opt(bool()),
    availableCredits: opt(arr(CreditSchema)),
  },
  { open: true },
);

const ProjectRefSchema = union([str(), obj({ id: opt(str()), name: opt(str()) }, { open: true })]);

const IneligibleTierSchema = obj(
  {
    reasonCode: opt(union([str(), num()])),
    reasonMessage: opt(str()),
    tierId: opt(str()),
    tierName: opt(str()),
    validationUrl: opt(str()),
  },
  { open: true },
);

export const LoadCodeAssistResponseSchema = obj(
  {
    currentTier: opt(UserTierSchema),
    allowedTiers: opt(arr(UserTierSchema)),
    paidTier: opt(UserTierSchema),
    cloudaicompanionProject: opt(ProjectRefSchema),
    ineligibleTiers: opt(arr(IneligibleTierSchema)),
  },
  { open: true },
);
export type LoadCodeAssistResponse = Static<typeof LoadCodeAssistResponseSchema>;
export type AntigravityUserTier = Static<typeof UserTierSchema>;
const loadCodeAssistValidator = compile(LoadCodeAssistResponseSchema);

const OnboardOperationSchema = obj(
  {
    name: opt(str()),
    done: opt(bool()),
    response: opt(obj({ cloudaicompanionProject: opt(ProjectRefSchema) }, { open: true })),
    error: opt(RpcErrorSchema),
  },
  { open: true },
);
const onboardValidator = compile(OnboardOperationSchema);

/** Project and tier facts persisted inside the Pi OAuth credential. */
export interface AntigravityProjectInfo {
  projectId: string;
  tierId?: string | undefined;
  tierName?: string | undefined;
  paidTierId?: string | undefined;
  paidTierName?: string | undefined;
}

export interface CodeAssistRequestOptions {
  token: string;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  endpoints?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

export interface DiscoverProjectOptions extends CodeAssistRequestOptions {
  /** A user-configured Cloud project (config file `project_id`). Never invented. */
  configuredProjectId?: string | undefined;
  onboardPollIntervalMs?: number | undefined;
  onboardMaxAttempts?: number | undefined;
}

type LoadCodeAssistRequest = {
  metadata: typeof CLIENT_METADATA;
  cloudaicompanionProject?: string;
};

type OnboardUserRequest = {
  tierId: string;
  metadata: typeof CLIENT_METADATA;
  cloudaicompanionProject?: string;
};

export async function loadCodeAssist(
  options: CodeAssistRequestOptions,
  configuredProjectId?: string,
): Promise<LoadCodeAssistResponse> {
  const body: LoadCodeAssistRequest = { metadata: CLIENT_METADATA };
  if (configuredProjectId) body.cloudaicompanionProject = configuredProjectId;
  return postV1Internal("loadCodeAssist", body, {
    token: options.token,
    validator: loadCodeAssistValidator,
    signal: options.signal,
    fetch: options.fetch,
    endpoints: options.endpoints,
    timeoutMs: options.timeoutMs,
  });
}

function projectIdOf(ref: Static<typeof ProjectRefSchema> | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const id = compile(str()).check(ref) ? ref : ref.id;
  return id?.trim() ? id.trim() : undefined;
}

const UNSUPPORTED_CLIENT_CODES = new Set([
  "UNSUPPORTED_CLIENT",
  "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT",
  "11",
  "12",
]);
const VALIDATION_REQUIRED_CODES = new Set(["VALIDATION_REQUIRED", "10"]);

function reasonName(code: string | number | undefined): string {
  const value = String(code ?? "");
  if (value === "10") return "VALIDATION_REQUIRED";
  if (value === "11") return "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT";
  if (value === "12") return "UNSUPPORTED_CLIENT";
  return value;
}

/** Throws the typed refusal when the backend reports this client or account as ineligible. */
function assertEligible(response: LoadCodeAssistResponse): void {
  for (const tier of response.ineligibleTiers ?? []) {
    const code = String(tier.reasonCode ?? "");
    if (UNSUPPORTED_CLIENT_CODES.has(code)) {
      throw new AntigravityError({
        kind: "unsupported_client",
        reason: reasonName(tier.reasonCode),
        detail: tier.reasonMessage,
      });
    }
    if (VALIDATION_REQUIRED_CODES.has(code)) {
      throw new AntigravityError({
        kind: "validation_required",
        reason: "VALIDATION_REQUIRED",
        detail: tier.reasonMessage,
        validationUrl: acceptedValidationUrl(tier.validationUrl),
      });
    }
  }
}

function infoFrom(
  response: LoadCodeAssistResponse,
  projectId: string,
  tier: AntigravityUserTier | undefined,
): AntigravityProjectInfo {
  return {
    projectId,
    tierId: tier?.id,
    tierName: tier?.name,
    paidTierId: response.paidTier?.id,
    paidTierName: response.paidTier?.name,
  };
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function onboard(
  options: DiscoverProjectOptions,
  response: LoadCodeAssistResponse,
): Promise<AntigravityProjectInfo> {
  const allowed = response.allowedTiers ?? [];
  const tier = allowed.find((candidate) => candidate.isDefault) ?? allowed[0];
  if (!tier?.id) {
    throw new AntigravityError({
      kind: "permission",
      detail: "this Google account has no Antigravity tier it can be onboarded to",
    });
  }
  if (tier.userDefinedCloudaicompanionProject && !options.configuredProjectId) {
    throw new AntigravityError({
      kind: "invalid_request",
      detail: `tier ${tier.id} requires your own Google Cloud project; set project_id in google-antigravity.json`,
    });
  }
  const body: OnboardUserRequest = { tierId: tier.id, metadata: CLIENT_METADATA };
  if (options.configuredProjectId) body.cloudaicompanionProject = options.configuredProjectId;
  const maxAttempts = options.onboardMaxAttempts ?? 10;
  const interval = options.onboardPollIntervalMs ?? 3000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const operation = await postV1Internal("onboardUser", body, {
      token: options.token,
      validator: onboardValidator,
      signal: options.signal,
      fetch: options.fetch,
      endpoints: options.endpoints,
      timeoutMs: options.timeoutMs,
    });
    if (operation.error) throw antigravityErrorFromRpc(operation.error);
    if (operation.done) {
      const projectId =
        projectIdOf(operation.response?.cloudaicompanionProject) ?? options.configuredProjectId;
      if (!projectId) {
        throw antigravityMalformedResponse("onboardUser completed without a project");
      }
      return infoFrom(response, projectId, tier);
    }
    if (attempt < maxAttempts) await delay(interval, options.signal);
  }
  throw new AntigravityError({
    kind: "server",
    detail: `onboarding did not complete after ${maxAttempts} attempts; try /login again later`,
  });
}

/**
 * Finds the Cloud Code Assist project for this account: loadCodeAssist first, onboardUser (a
 * bounded long-running-operation poll) only when no tier is onboarded yet. A project id is
 * never invented: without one from the backend or the user's config, this throws.
 */
export async function discoverAntigravityProject(
  options: DiscoverProjectOptions,
): Promise<AntigravityProjectInfo> {
  const response = await loadCodeAssist(options, options.configuredProjectId);
  const projectId = projectIdOf(response.cloudaicompanionProject) ?? options.configuredProjectId;
  if (response.currentTier) {
    if (projectId) return infoFrom(response, projectId, response.currentTier);
    assertEligible(response);
    throw antigravityMalformedResponse(
      "loadCodeAssist returned a tier but no project; set project_id in google-antigravity.json",
    );
  }
  assertEligible(response);
  return onboard(options, response);
}
