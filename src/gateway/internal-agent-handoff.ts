/**
 * Host-only authority for an agent-to-agent handoff.
 *
 * The values in this module are deliberately not serializable credentials. The
 * authority is the object identity held in the module-private WeakMaps. A
 * public Gateway frame, a spread/JSON clone, or a synthetic client without the
 * object cannot manufacture or replay a handoff.
 */
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import type { InputProvenance } from "../sessions/input-provenance.js";

export type InternalAgentHandoffPurpose =
  | "sessions_send"
  | "subagent_announce"
  | "subagent_interrupted_resume"
  | "main_session_restart_recovery"
  | "agent_mediated_completion";

export type InternalAgentHandoffSourceBinding = Readonly<{
  sourceSessionKey: string;
  sourceSessionId: string;
}>;

const AGENT_MEDIATED_COMPLETION_SOURCE_TOOLS = new Set([
  "agent_harness_task",
  "image_generate",
  "music_generate",
  "video_generate",
]);

const GENERATED_MEDIA_COMPLETION_SOURCE_TOOLS = new Set([
  "image_generate",
  "music_generate",
  "video_generate",
]);

export type InternalAgentHandoffGeneratedMediaDelivery = Readonly<{
  /** Exact host-owned task text whose completion is being delivered. */
  task: string;
  cronRunContinuation?: boolean;
  mediaUrls?: readonly string[];
  suppressTextDelivery?: boolean;
}>;

export type BoundGeneratedMediaDelivery = Readonly<{
  task: string;
  cronRunContinuation: boolean;
  mediaUrls?: readonly string[];
  suppressTextDelivery: boolean;
}>;

/** Exact installed owner/tool allowed to consume a sessions_send run authority. */
export const INTERNAL_AGENT_HANDOFF_PROTECTED_PLUGIN_ID = "tony-postman-a2a";
export const INTERNAL_AGENT_HANDOFF_PROTECTED_TOOL_NAME = "postman_lookup";

// These declarations are exported only so generated boundary declarations can
// name the opaque types.  The symbols have no runtime value; authority still
// comes exclusively from the module-private WeakMaps below.
export declare const internalAgentHandoffCapabilityBrand: unique symbol;
export declare const admittedInternalHandoffBrand: unique symbol;

export type InternalAgentHandoffCapability = Readonly<{
  readonly [internalAgentHandoffCapabilityBrand]: true;
}>;

export type AdmittedInternalHandoff = Readonly<{
  readonly [admittedInternalHandoffBrand]: true;
  readonly purpose: InternalAgentHandoffPurpose;
  readonly sourceTool: string;
  readonly sourceSessionKey: string;
  readonly sourceSessionId: string;
  readonly sourceChannel?: string;
  readonly targetSessionKey: string;
  readonly targetSessionId: string;
  readonly requestId: string;
  readonly sessionWorkAdmissionHandoffId?: string;
  readonly lifecycleGeneration: string;
  readonly issuedAtMs: number;
  readonly deadlineMs: number;
  readonly provenance: Readonly<InputProvenance>;
  readonly generatedMediaDelivery?: BoundGeneratedMediaDelivery;
}>;

type IssuedHandoff = {
  readonly purpose: InternalAgentHandoffPurpose;
  readonly provenanceKind: "inter_session" | "internal_system";
  readonly sourceTool: string;
  readonly sourceSessionKey: string;
  readonly sourceSessionId: string;
  readonly sourceChannel?: string;
  readonly targetSessionKey: string;
  readonly targetSessionId: string;
  readonly requestId: string;
  readonly sessionWorkAdmissionHandoffId?: string;
  readonly lifecycleGeneration: string;
  readonly issuedAtMs: number;
  readonly deadlineMs: number;
  readonly generatedMediaDelivery?: BoundGeneratedMediaDelivery;
};

type AdmittedHandoffState = {
  readonly authority: AdmittedInternalHandoff;
  state: "admitted" | "plugin_consumed" | "closed";
  pluginId?: string;
  toolName?: string;
  toolCallId?: string;
  canonicalParams?: unknown;
};

const issuedHandoffs = new WeakMap<object, IssuedHandoff>();
const admittedHandoffs = new WeakMap<object, AdmittedHandoffState>();

function normalizeRequired(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required for an internal agent handoff.`);
  }
  return value.trim();
}

function normalizeOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeGeneratedMediaDelivery(params: {
  purpose: InternalAgentHandoffPurpose;
  sourceTool: string;
  delivery?: InternalAgentHandoffGeneratedMediaDelivery;
}): BoundGeneratedMediaDelivery | undefined {
  if (!params.delivery) {
    return undefined;
  }
  if (
    params.purpose !== "agent_mediated_completion" ||
    !GENERATED_MEDIA_COMPLETION_SOURCE_TOOLS.has(params.sourceTool)
  ) {
    throw new Error(
      "generated-media delivery controls require an allowlisted agent-mediated completion.",
    );
  }
  if (typeof params.delivery.task !== "string" || !params.delivery.task.trim()) {
    throw new Error("generated-media delivery task is required.");
  }
  let mediaUrls: readonly string[] | undefined;
  if (params.delivery.mediaUrls !== undefined) {
    if (!Array.isArray(params.delivery.mediaUrls)) {
      throw new Error("generated-media delivery mediaUrls must be an array.");
    }
    const normalizedMediaUrls = Array.from(params.delivery.mediaUrls, (value) => {
      if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
        throw new Error("generated-media delivery mediaUrls must contain normalized strings.");
      }
      return value;
    });
    if (new Set(normalizedMediaUrls).size !== normalizedMediaUrls.length) {
      throw new Error("generated-media delivery mediaUrls must not contain duplicates.");
    }
    mediaUrls = Object.freeze(normalizedMediaUrls);
  }
  const cronRunContinuation = params.delivery.cronRunContinuation === true;
  const suppressTextDelivery = params.delivery.suppressTextDelivery === true;
  if (!cronRunContinuation && mediaUrls === undefined && !suppressTextDelivery) {
    throw new Error("generated-media delivery must bind at least one out-of-band control.");
  }
  if (suppressTextDelivery && (!mediaUrls || mediaUrls.length === 0)) {
    throw new Error("generated-media text suppression requires at least one bound media URL.");
  }
  return Object.freeze({
    task: params.delivery.task,
    cronRunContinuation,
    ...(mediaUrls ? { mediaUrls } : {}),
    suppressTextDelivery,
  });
}

function exactStringArrayMatches(
  actual: unknown,
  expected: readonly string[] | undefined,
): boolean {
  if (expected === undefined) {
    return actual === undefined;
  }
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function freezeProvenance(params: IssuedHandoff): Readonly<InputProvenance> {
  return Object.freeze({
    kind: params.provenanceKind,
    sourceSessionKey: params.sourceSessionKey,
    ...(params.sourceChannel ? { sourceChannel: params.sourceChannel } : {}),
    sourceTool: params.sourceTool,
  });
}

function resolvePurposeProvenance(params: {
  purpose?: InternalAgentHandoffPurpose;
  sourceTool?: string;
}): {
  purpose: InternalAgentHandoffPurpose;
  provenanceKind: "inter_session" | "internal_system";
  sourceTool: string;
} {
  const purpose = params.purpose ?? "sessions_send";
  switch (purpose) {
    case "sessions_send":
    case "subagent_announce":
    case "subagent_interrupted_resume":
      return { purpose, provenanceKind: "inter_session", sourceTool: purpose };
    case "main_session_restart_recovery":
      return { purpose, provenanceKind: "internal_system", sourceTool: purpose };
    case "agent_mediated_completion": {
      const sourceTool = normalizeRequired(params.sourceTool, "sourceTool").toLowerCase();
      if (!AGENT_MEDIATED_COMPLETION_SOURCE_TOOLS.has(sourceTool)) {
        throw new Error("sourceTool is not valid for an agent-mediated completion handoff.");
      }
      return { purpose, provenanceKind: "inter_session", sourceTool };
    }
    default: {
      const exhaustivePurpose: never = purpose;
      void exhaustivePurpose;
      throw new Error("Unsupported internal agent handoff purpose.");
    }
  }
}

/** Issue a fresh, non-transferable capability from a trusted in-process caller. */
export function issueInternalAgentHandoffCapability(params: {
  purpose?: InternalAgentHandoffPurpose;
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetSessionKey: string;
  targetSessionId: string;
  requestId: string;
  sessionWorkAdmissionHandoffId?: string;
  deadlineMs?: number;
  lifecycleGeneration?: string;
  nowMs?: number;
  generatedMediaDelivery?: InternalAgentHandoffGeneratedMediaDelivery;
}): InternalAgentHandoffCapability {
  const nowMs = params.nowMs ?? Date.now();
  const purposeProvenance = resolvePurposeProvenance(params);
  const sourceSessionKey = normalizeRequired(params.sourceSessionKey, "sourceSessionKey");
  const sourceSessionId = normalizeRequired(params.sourceSessionId, "sourceSessionId");
  const targetSessionKey = normalizeRequired(params.targetSessionKey, "targetSessionKey");
  const targetSessionId = normalizeRequired(params.targetSessionId, "targetSessionId");
  const requestId = normalizeRequired(params.requestId, "requestId");
  const sessionWorkAdmissionHandoffId = normalizeOptional(params.sessionWorkAdmissionHandoffId);
  if (
    sessionWorkAdmissionHandoffId &&
    purposeProvenance.purpose !== "main_session_restart_recovery"
  ) {
    throw new Error("sessionWorkAdmissionHandoffId is reserved for main-session restart recovery.");
  }
  const deadlineMs = params.deadlineMs ?? nowMs + 60_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
    throw new Error("internal agent handoff deadline must be in the future.");
  }
  const lifecycleGeneration =
    normalizeOptional(params.lifecycleGeneration) ?? getAgentEventLifecycleGeneration();
  const generatedMediaDelivery = normalizeGeneratedMediaDelivery({
    purpose: purposeProvenance.purpose,
    sourceTool: purposeProvenance.sourceTool,
    delivery: params.generatedMediaDelivery,
  });
  const issued: IssuedHandoff = Object.freeze({
    ...purposeProvenance,
    sourceSessionKey,
    sourceSessionId,
    ...(normalizeOptional(params.sourceChannel)
      ? { sourceChannel: normalizeOptional(params.sourceChannel) }
      : {}),
    targetSessionKey,
    targetSessionId,
    requestId,
    ...(sessionWorkAdmissionHandoffId ? { sessionWorkAdmissionHandoffId } : {}),
    lifecycleGeneration,
    issuedAtMs: nowMs,
    deadlineMs,
    ...(generatedMediaDelivery ? { generatedMediaDelivery } : {}),
  });
  const capability = Object.freeze({}) as InternalAgentHandoffCapability;
  issuedHandoffs.set(capability, issued);
  return capability;
}

/**
 * Atomically consume an issued capability at Gateway admission and mint a
 * distinct run authority. Any failed binding attempt burns the capability.
 */
export function consumeInternalAgentHandoffCapability(params: {
  capability: unknown;
  sourceSessionKey: string;
  sourceSessionId: string;
  targetSessionKey: string;
  targetSessionId: string;
  requestId: string;
  sessionWorkAdmissionHandoffId?: string;
  lifecycleGeneration?: string;
  nowMs?: number;
  requestMessage?: unknown;
  cronRunContinuation?: unknown;
  internalDeliveryMediaUrls?: unknown;
  internalDeliverySuppressText?: unknown;
}): AdmittedInternalHandoff | undefined {
  if (
    !params.capability ||
    (typeof params.capability !== "object" && typeof params.capability !== "function")
  ) {
    return undefined;
  }
  const capability = params.capability as object;
  const issued = issuedHandoffs.get(capability);
  if (!issued) {
    return undefined;
  }
  // Delete before checking the binding: wrong-target probes must not leave a
  // live capability that can be replayed with a guessed binding.
  issuedHandoffs.delete(capability);
  const nowMs = params.nowMs ?? Date.now();
  const sourceSessionKey = normalizeOptional(params.sourceSessionKey);
  const sourceSessionId = normalizeOptional(params.sourceSessionId);
  const targetSessionKey = normalizeOptional(params.targetSessionKey);
  const targetSessionId = normalizeOptional(params.targetSessionId);
  const requestId = normalizeOptional(params.requestId);
  const sessionWorkAdmissionHandoffId = normalizeOptional(params.sessionWorkAdmissionHandoffId);
  const lifecycleGeneration =
    normalizeOptional(params.lifecycleGeneration) ?? getAgentEventLifecycleGeneration();
  const generatedMediaDelivery = issued.generatedMediaDelivery;
  if (
    !sourceSessionKey ||
    sourceSessionKey !== issued.sourceSessionKey ||
    !sourceSessionId ||
    sourceSessionId !== issued.sourceSessionId ||
    !targetSessionKey ||
    targetSessionKey !== issued.targetSessionKey ||
    !targetSessionId ||
    targetSessionId !== issued.targetSessionId ||
    !requestId ||
    requestId !== issued.requestId ||
    sessionWorkAdmissionHandoffId !== issued.sessionWorkAdmissionHandoffId ||
    lifecycleGeneration !== issued.lifecycleGeneration ||
    nowMs > issued.deadlineMs ||
    (params.cronRunContinuation === true) !==
      (generatedMediaDelivery?.cronRunContinuation === true) ||
    !exactStringArrayMatches(params.internalDeliveryMediaUrls, generatedMediaDelivery?.mediaUrls) ||
    (params.internalDeliverySuppressText === true) !==
      (generatedMediaDelivery?.suppressTextDelivery === true) ||
    (generatedMediaDelivery !== undefined && params.requestMessage !== generatedMediaDelivery.task)
  ) {
    return undefined;
  }
  const authority = Object.freeze({
    purpose: issued.purpose,
    sourceTool: issued.sourceTool,
    sourceSessionKey: issued.sourceSessionKey,
    sourceSessionId: issued.sourceSessionId,
    ...(issued.sourceChannel ? { sourceChannel: issued.sourceChannel } : {}),
    targetSessionKey: issued.targetSessionKey,
    targetSessionId: issued.targetSessionId,
    requestId: issued.requestId,
    ...(issued.sessionWorkAdmissionHandoffId
      ? { sessionWorkAdmissionHandoffId: issued.sessionWorkAdmissionHandoffId }
      : {}),
    lifecycleGeneration: issued.lifecycleGeneration,
    issuedAtMs: issued.issuedAtMs,
    deadlineMs: issued.deadlineMs,
    provenance: freezeProvenance(issued),
    ...(generatedMediaDelivery ? { generatedMediaDelivery } : {}),
  }) as AdmittedInternalHandoff;
  admittedHandoffs.set(authority, { authority, state: "admitted" });
  return authority;
}

export function isAdmittedInternalAgentHandoff(value: unknown): value is AdmittedInternalHandoff {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const state = admittedHandoffs.get(value as object);
  return state?.state === "admitted";
}

/** Consume the run authority once for one exact plugin invocation. */
export function consumeAdmittedInternalAgentHandoffForPluginTool(params: {
  authority: unknown;
  pluginId: string;
  toolName: string;
  toolCallId?: string;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  canonicalParams: unknown;
  admittedSessionDeliveryKind?: "none" | "internal" | "external";
  nowMs?: number;
}): boolean {
  if (
    !params.authority ||
    (typeof params.authority !== "object" && typeof params.authority !== "function")
  ) {
    return false;
  }
  const state = admittedHandoffs.get(params.authority as object);
  if (!state || state.state !== "admitted") {
    return false;
  }
  // Burn before checking any caller-supplied binding. Failed owner/tool/call,
  // lifecycle, or params probes must not leave a reusable run authority.
  state.state = "closed";
  const nowMs = params.nowMs ?? Date.now();
  const pluginId = normalizeOptional(params.pluginId);
  const toolName = normalizeOptional(params.toolName);
  const toolCallId = normalizeOptional(params.toolCallId);
  const runId = normalizeOptional(params.runId);
  const sessionKey = normalizeOptional(params.sessionKey);
  const sessionId = normalizeOptional(params.sessionId);
  if (
    pluginId !== INTERNAL_AGENT_HANDOFF_PROTECTED_PLUGIN_ID ||
    toolName !== INTERNAL_AGENT_HANDOFF_PROTECTED_TOOL_NAME ||
    !runId ||
    !sessionKey ||
    state.authority.purpose !== "sessions_send" ||
    runId !== state.authority.requestId ||
    sessionKey !== state.authority.targetSessionKey ||
    sessionId !== state.authority.targetSessionId ||
    toolCallId === undefined ||
    params.admittedSessionDeliveryKind !== "none" ||
    getAgentEventLifecycleGeneration() !== state.authority.lifecycleGeneration ||
    nowMs > state.authority.deadlineMs ||
    params.canonicalParams === undefined
  ) {
    return false;
  }
  state.pluginId = pluginId;
  state.toolName = toolName;
  state.toolCallId = toolCallId;
  state.canonicalParams = params.canonicalParams;
  // This is intentionally a synchronous state transition. Two concurrent
  // handlers cannot both consume the same authority on the event loop.
  state.state = "plugin_consumed";
  return true;
}

export function closeAdmittedInternalAgentHandoff(value: unknown): void {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  const state = admittedHandoffs.get(value as object);
  if (state) {
    state.state = "closed";
  }
}

/**
 * Dispatch an agent handoff through the in-process Gateway router. This is the
 * only production sender for sessions_send/agent-step; callers cannot fall back
 * to a public WebSocket request because the capability never crosses that
 * boundary.
 */
export type InternalAgentHandoffDispatchParams = {
  purpose?: InternalAgentHandoffPurpose;
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetSessionKey: string;
  targetSessionId: string;
  requestId: string;
  request: Record<string, unknown>;
  generatedMediaDelivery?: InternalAgentHandoffGeneratedMediaDelivery;
  delegatedToolPolicyHandoff?: boolean;
  expectFinal?: boolean;
  onAccepted?: (payload: unknown) => void;
  timeoutMs?: number;
};

export function prepareInternalAgentHandoffDispatch(params: InternalAgentHandoffDispatchParams): {
  capability: InternalAgentHandoffCapability;
  source: InternalAgentHandoffSourceBinding;
  request: Record<string, unknown>;
  clientControls: Readonly<{
    cronRunContinuation?: true;
    internalDeliveryMediaUrls?: readonly string[];
    internalDeliverySuppressText?: true;
  }>;
} {
  const generatedMediaDelivery = params.generatedMediaDelivery;
  if (generatedMediaDelivery) {
    if (params.request.message !== generatedMediaDelivery.task) {
      throw new Error("generated-media handoff task does not match the dispatched request.");
    }
    if (
      generatedMediaDelivery.cronRunContinuation === true &&
      (typeof params.request.sessionId !== "string" || !params.request.sessionId.trim())
    ) {
      throw new Error("generated-media cron continuation requires an exact session id.");
    }
    if (
      generatedMediaDelivery.mediaUrls !== undefined ||
      generatedMediaDelivery.suppressTextDelivery === true
    ) {
      if (
        params.request.sourceReplyDeliveryMode !== "automatic" ||
        params.request.disableMessageTool !== true ||
        params.request.forceRestartSafeTools !== true
      ) {
        throw new Error("generated-media delivery controls require the safe delivery lifecycle.");
      }
    }
    if (
      generatedMediaDelivery.cronRunContinuation === true &&
      generatedMediaDelivery.mediaUrls === undefined
    ) {
      const expectedEventSource =
        params.sourceTool === "image_generate"
          ? "image_generation"
          : params.sourceTool === "music_generate"
            ? "music_generation"
            : params.sourceTool === "video_generate"
              ? "video_generation"
              : undefined;
      const internalEvents = Array.isArray(params.request.internalEvents)
        ? params.request.internalEvents
        : [];
      if (
        !expectedEventSource ||
        !internalEvents.some(
          (event) =>
            event !== null &&
            typeof event === "object" &&
            (event as { type?: unknown }).type === "task_completion" &&
            (event as { source?: unknown }).source === expectedEventSource,
        )
      ) {
        throw new Error(
          "generated-media cron continuation requires its exact completion event lifecycle.",
        );
      }
    }
  }
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const capability = issueInternalAgentHandoffCapability({
    purpose: params.purpose,
    sourceSessionKey: params.sourceSessionKey,
    sourceSessionId: params.sourceSessionId,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool,
    targetSessionKey: params.targetSessionKey,
    targetSessionId: params.targetSessionId,
    requestId: params.requestId,
    ...(params.purpose === "main_session_restart_recovery" &&
    typeof params.request.internalRuntimeHandoffId === "string" &&
    params.request.internalRuntimeHandoffId.trim()
      ? { sessionWorkAdmissionHandoffId: params.request.internalRuntimeHandoffId.trim() }
      : {}),
    lifecycleGeneration,
    deadlineMs: Date.now() + Math.max(5_000, params.timeoutMs ?? 10_000),
    generatedMediaDelivery,
  });
  const request = { ...params.request };
  // Provenance is derived by preflight from the consumed capability. It must
  // never be carried as a caller-authored AgentParams field.
  delete request.inputProvenance;
  request.sessionKey = params.targetSessionKey;
  request.idempotencyKey = params.requestId;
  request.expectedExistingSessionId = params.targetSessionId;
  const issuedGeneratedMediaDelivery = issuedHandoffs.get(capability)?.generatedMediaDelivery;
  const clientControls = Object.freeze({
    ...(issuedGeneratedMediaDelivery?.cronRunContinuation
      ? { cronRunContinuation: true as const }
      : {}),
    ...(issuedGeneratedMediaDelivery?.mediaUrls
      ? { internalDeliveryMediaUrls: issuedGeneratedMediaDelivery.mediaUrls }
      : {}),
    ...(issuedGeneratedMediaDelivery?.suppressTextDelivery
      ? { internalDeliverySuppressText: true as const }
      : {}),
  });
  return {
    capability,
    source: Object.freeze({
      sourceSessionKey: normalizeRequired(params.sourceSessionKey, "sourceSessionKey"),
      sourceSessionId: normalizeRequired(params.sourceSessionId, "sourceSessionId"),
    }),
    request,
    clientControls,
  };
}

export async function dispatchAgentHandoffInProcess<T = { runId?: string }>(
  params: InternalAgentHandoffDispatchParams,
): Promise<T> {
  const prepared = prepareInternalAgentHandoffDispatch(params);
  const { dispatchGatewayMethodInProcess } = await import("./server-plugins.js");
  return await dispatchGatewayMethodInProcess<T>("agent", prepared.request, {
    forceSyntheticClient: true,
    agentHandoffCapability: prepared.capability,
    agentHandoffSource: prepared.source,
    allowSyntheticCronRunContinuation: prepared.clientControls.cronRunContinuation,
    delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
    expectFinal: params.expectFinal,
    internalDeliveryMediaUrls: prepared.clientControls.internalDeliveryMediaUrls
      ? [...prepared.clientControls.internalDeliveryMediaUrls]
      : undefined,
    internalDeliverySuppressText: prepared.clientControls.internalDeliverySuppressText,
    onAccepted: params.onAccepted,
    timeoutMs: params.timeoutMs ?? 10_000,
  });
}
