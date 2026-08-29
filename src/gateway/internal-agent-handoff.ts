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
  readonly lifecycleGeneration: string;
  readonly issuedAtMs: number;
  readonly deadlineMs: number;
  readonly provenance: Readonly<InputProvenance>;
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
  readonly lifecycleGeneration: string;
  readonly issuedAtMs: number;
  readonly deadlineMs: number;
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
  deadlineMs?: number;
  lifecycleGeneration?: string;
  nowMs?: number;
}): InternalAgentHandoffCapability {
  const nowMs = params.nowMs ?? Date.now();
  const purposeProvenance = resolvePurposeProvenance(params);
  const sourceSessionKey = normalizeRequired(params.sourceSessionKey, "sourceSessionKey");
  const sourceSessionId = normalizeRequired(params.sourceSessionId, "sourceSessionId");
  const targetSessionKey = normalizeRequired(params.targetSessionKey, "targetSessionKey");
  const targetSessionId = normalizeRequired(params.targetSessionId, "targetSessionId");
  const requestId = normalizeRequired(params.requestId, "requestId");
  const deadlineMs = params.deadlineMs ?? nowMs + 60_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
    throw new Error("internal agent handoff deadline must be in the future.");
  }
  const lifecycleGeneration =
    normalizeOptional(params.lifecycleGeneration) ?? getAgentEventLifecycleGeneration();
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
    lifecycleGeneration,
    issuedAtMs: nowMs,
    deadlineMs,
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
  lifecycleGeneration?: string;
  nowMs?: number;
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
  const lifecycleGeneration =
    normalizeOptional(params.lifecycleGeneration) ?? getAgentEventLifecycleGeneration();
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
    lifecycleGeneration !== issued.lifecycleGeneration ||
    nowMs > issued.deadlineMs
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
    lifecycleGeneration: issued.lifecycleGeneration,
    issuedAtMs: issued.issuedAtMs,
    deadlineMs: issued.deadlineMs,
    provenance: freezeProvenance(issued),
  }) as AdmittedInternalHandoff;
  admittedHandoffs.set(authority, { authority, state: "admitted" });
  return authority;
}

export function isAdmittedInternalAgentHandoff(value: unknown): value is AdmittedInternalHandoff {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const state = admittedHandoffs.get(value as object);
  return state?.state !== "closed";
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
    !pluginId ||
    !toolName ||
    !runId ||
    !sessionKey ||
    runId !== state.authority.requestId ||
    sessionKey !== state.authority.targetSessionKey ||
    (state.authority.targetSessionId !== undefined &&
      sessionId !== state.authority.targetSessionId) ||
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
  allowSyntheticCronRunContinuation?: boolean;
  delegatedToolPolicyHandoff?: boolean;
  expectFinal?: boolean;
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  onAccepted?: (payload: unknown) => void;
  timeoutMs?: number;
};

export function prepareInternalAgentHandoffDispatch(params: InternalAgentHandoffDispatchParams): {
  capability: InternalAgentHandoffCapability;
  source: InternalAgentHandoffSourceBinding;
  request: Record<string, unknown>;
} {
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
    lifecycleGeneration,
    deadlineMs: Date.now() + Math.max(5_000, params.timeoutMs ?? 10_000),
  });
  const request = { ...params.request };
  // Provenance is derived by preflight from the consumed capability. It must
  // never be carried as a caller-authored AgentParams field.
  delete request.inputProvenance;
  request.sessionKey = params.targetSessionKey;
  request.idempotencyKey = params.requestId;
  request.expectedExistingSessionId = params.targetSessionId;
  return {
    capability,
    source: Object.freeze({
      sourceSessionKey: normalizeRequired(params.sourceSessionKey, "sourceSessionKey"),
      sourceSessionId: normalizeRequired(params.sourceSessionId, "sourceSessionId"),
    }),
    request,
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
    allowSyntheticCronRunContinuation: params.allowSyntheticCronRunContinuation,
    delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
    expectFinal: params.expectFinal,
    internalDeliveryMediaUrls: params.internalDeliveryMediaUrls,
    internalDeliverySuppressText: params.internalDeliverySuppressText,
    onAccepted: params.onAccepted,
    timeoutMs: params.timeoutMs ?? 10_000,
  });
}
