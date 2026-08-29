import {
  closeAdmittedInternalAgentHandoff,
  consumeAdmittedInternalAgentHandoffForPluginTool,
  INTERNAL_AGENT_HANDOFF_PROTECTED_PLUGIN_ID,
  INTERNAL_AGENT_HANDOFF_PROTECTED_TOOL_NAME,
  isAdmittedInternalAgentHandoff,
  type AdmittedInternalHandoff,
} from "../gateway/internal-agent-handoff.js";
import type { InputProvenance } from "../sessions/input-provenance.js";

/**
 * The delivery route admitted by the Gateway before an agent run started.
 *
 * This is deliberately a small closed set. In particular, an absent value is
 * different from the explicit `none` route: callers must not manufacture a
 * route snapshot after admission.
 */
export type PluginAdmittedSessionDeliveryKind = "none" | "internal" | "external";

/** Immutable, host-issued context for one plugin-tool invocation. */
export interface PluginToolExecutionContext {
  readonly pluginId: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly modelProviderId?: string;
  readonly modelId?: string;
  readonly inputProvenance?: InputProvenance;
  readonly admittedSessionDeliveryKind?: PluginAdmittedSessionDeliveryKind;
  /** Opaque host authority retained only for this invocation. */
  readonly admittedInternalHandoff?: AdmittedInternalHandoff;
  readonly toolName: string;
  readonly toolCallId?: string;
  /** The exact final params object passed to the plugin handler. */
  readonly canonicalParams: Readonly<Record<string, unknown>>;
}

/** Exact handler-entry binding required to atomically consume a host context. */
export type PluginToolExecutionContextConsumerBinding = Readonly<{
  pluginId: string;
  toolName: string;
  toolCallId: string;
  canonicalParams: unknown;
}>;

// Context identity and one-shot phase are held only in this module-private
// WeakMap. A copied, deserialized, or wrapper-created object therefore never
// has host authority.
type HostContextState = {
  readonly pluginId: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly modelProviderId?: string;
  readonly modelId?: string;
  readonly inputProvenance?: InputProvenance;
  readonly admittedSessionDeliveryKind?: PluginAdmittedSessionDeliveryKind;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly canonicalParams: Record<string, unknown>;
  readonly protectedAuthority?: AdmittedInternalHandoff;
  phase: "issued" | "consumed" | "closed";
};

const hostContexts = new WeakMap<object, HostContextState>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function isFrozenObject(value: unknown, seen = new WeakSet<object>()): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return true;
  }
  const object = value as object;
  if (seen.has(object)) {
    return true;
  }
  if (!Object.isFrozen(object)) {
    return false;
  }
  seen.add(object);
  return Object.values(object as Record<string, unknown>).every((child) =>
    isFrozenObject(child, seen),
  );
}

function matchesHostContextSnapshot(
  candidate: Partial<PluginToolExecutionContext>,
  state: HostContextState,
): boolean {
  return (
    candidate.pluginId === state.pluginId &&
    candidate.agentId === state.agentId &&
    candidate.sessionKey === state.sessionKey &&
    candidate.sessionId === state.sessionId &&
    candidate.runId === state.runId &&
    candidate.modelProviderId === state.modelProviderId &&
    candidate.modelId === state.modelId &&
    candidate.inputProvenance === state.inputProvenance &&
    candidate.admittedSessionDeliveryKind === state.admittedSessionDeliveryKind &&
    candidate.admittedInternalHandoff === state.protectedAuthority &&
    candidate.toolName === state.toolName &&
    candidate.toolCallId === state.toolCallId &&
    candidate.canonicalParams === state.canonicalParams
  );
}

/**
 * Internal host constructor. Keep this out of the public SDK barrel: only the
 * runtime finalization boundary may issue the registered object identity.
 */
export function createHostPluginToolExecutionContext(params: {
  pluginId: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  modelProviderId?: string;
  modelId?: string;
  inputProvenance?: InputProvenance;
  admittedSessionDeliveryKind?: PluginAdmittedSessionDeliveryKind;
  admittedInternalHandoff?: AdmittedInternalHandoff;
  toolName: string;
  toolCallId?: string;
  canonicalParams: Record<string, unknown>;
}): PluginToolExecutionContext | undefined {
  const pluginId = params.pluginId.trim();
  const toolName = params.toolName.trim();
  const toolCallId = params.toolCallId?.trim();
  if (!pluginId || !toolName || !toolCallId) {
    return undefined;
  }
  const protectedAuthority = params.admittedInternalHandoff;
  if (
    (params.inputProvenance?.kind === "inter_session" || protectedAuthority) &&
    (!protectedAuthority ||
      !isAdmittedInternalAgentHandoff(protectedAuthority) ||
      params.inputProvenance !== protectedAuthority.provenance ||
      protectedAuthority.purpose !== "sessions_send" ||
      pluginId !== INTERNAL_AGENT_HANDOFF_PROTECTED_PLUGIN_ID ||
      toolName !== INTERNAL_AGENT_HANDOFF_PROTECTED_TOOL_NAME)
  ) {
    return undefined;
  }
  if (protectedAuthority) {
    deepFreeze(params.canonicalParams);
  }
  const context = {
    pluginId,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    ...(params.modelProviderId !== undefined ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
    ...(params.inputProvenance !== undefined ? { inputProvenance: params.inputProvenance } : {}),
    ...(params.admittedSessionDeliveryKind !== undefined
      ? { admittedSessionDeliveryKind: params.admittedSessionDeliveryKind }
      : {}),
    ...(protectedAuthority ? { admittedInternalHandoff: protectedAuthority } : {}),
    toolName,
    toolCallId,
    canonicalParams: params.canonicalParams,
  } satisfies PluginToolExecutionContext;
  const frozenContext = Object.freeze(context);
  hostContexts.set(frozenContext, {
    pluginId,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    ...(params.modelProviderId !== undefined ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
    ...(params.inputProvenance !== undefined ? { inputProvenance: params.inputProvenance } : {}),
    ...(params.admittedSessionDeliveryKind !== undefined
      ? { admittedSessionDeliveryKind: params.admittedSessionDeliveryKind }
      : {}),
    toolName,
    toolCallId,
    canonicalParams: params.canonicalParams,
    ...(protectedAuthority ? { protectedAuthority } : {}),
    phase: "issued",
  });
  return frozenContext;
}

/** Internal non-authorizing check used only to carry an issued context through wrappers. */
export function isIssuedHostPluginToolExecutionContext(
  value: unknown,
): value is PluginToolExecutionContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = hostContexts.get(value);
  const candidate = value as Partial<PluginToolExecutionContext>;
  if (
    !state ||
    state.phase !== "issued" ||
    !matchesHostContextSnapshot(candidate, state) ||
    (state.protectedAuthority && !isAdmittedInternalAgentHandoff(state.protectedAuthority))
  ) {
    return false;
  }
  if (state.protectedAuthority && !isFrozenObject(state.canonicalParams)) {
    return false;
  }
  return Object.isFrozen(value);
}

/**
 * Public SDK authorization boundary. Private state is burned before any
 * handler-supplied binding is checked, so wrong probes and concurrent replay
 * cannot leave a usable invocation behind.
 */
export function consumeHostPluginToolExecutionContext(
  value: unknown,
  binding: PluginToolExecutionContextConsumerBinding,
): value is PluginToolExecutionContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = hostContexts.get(value);
  if (!state || state.phase !== "issued") {
    return false;
  }
  state.phase = "closed";
  const candidate = value as Partial<PluginToolExecutionContext>;
  const pluginId = typeof binding.pluginId === "string" ? binding.pluginId.trim() : "";
  const toolName = typeof binding.toolName === "string" ? binding.toolName.trim() : "";
  const toolCallId = typeof binding.toolCallId === "string" ? binding.toolCallId.trim() : "";
  const validSnapshot =
    Object.isFrozen(value) &&
    matchesHostContextSnapshot(candidate, state) &&
    pluginId === state.pluginId &&
    toolName === state.toolName &&
    toolCallId === state.toolCallId &&
    binding.canonicalParams === state.canonicalParams &&
    (!state.protectedAuthority || isFrozenObject(state.canonicalParams));
  if (!validSnapshot) {
    closeAdmittedInternalAgentHandoff(state.protectedAuthority);
    return false;
  }
  if (
    state.protectedAuthority &&
    !consumeAdmittedInternalAgentHandoffForPluginTool({
      authority: state.protectedAuthority,
      pluginId: state.pluginId,
      toolName: state.toolName,
      toolCallId: state.toolCallId,
      runId: state.runId ?? "",
      sessionKey: state.sessionKey ?? "",
      sessionId: state.sessionId,
      canonicalParams: state.canonicalParams,
      admittedSessionDeliveryKind: state.admittedSessionDeliveryKind,
    })
  ) {
    closeAdmittedInternalAgentHandoff(state.protectedAuthority);
    return false;
  }
  state.phase = "consumed";
  return true;
}

/** Host-only lifecycle close; retained contexts fail consumption after return. */
export function closeHostPluginToolExecutionContext(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const state = hostContexts.get(value);
  if (state) {
    state.phase = "closed";
    closeAdmittedInternalAgentHandoff(state.protectedAuthority);
  }
}
