import {
  consumeAdmittedInternalAgentHandoffForPluginTool,
  isAdmittedInternalAgentHandoff,
  type AdmittedInternalHandoff,
} from "../gateway/internal-agent-handoff.js";
import type { InputProvenance } from "../sessions/input-provenance.js";

/**
 * The delivery route admitted by the Gateway before an agent run started.
 *
 * This is deliberately a small closed set.  In particular, an absent value
 * is different from the explicit `none` route: callers must not manufacture a
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
  /** Opaque host authority retained for the lifetime of this invocation. */
  readonly admittedInternalHandoff?: AdmittedInternalHandoff;
  readonly toolName: string;
  readonly toolCallId?: string;
  /** The exact final params object passed to the plugin handler. */
  readonly canonicalParams: Readonly<Record<string, unknown>>;
}

// Context identity is held only in this module-private WeakMap. A copied,
// deserialized, or wrapper-created object is therefore never host-valid.
type HostContextState = {
  readonly canonicalParams: Record<string, unknown>;
  readonly protectedAuthority?: AdmittedInternalHandoff;
  closed: boolean;
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

/**
 * Internal host constructor.  Keep this out of the public SDK barrel: only
 * the runtime finalization boundary may issue the brand.
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
  if (!pluginId || !params.toolName.trim() || !params.toolCallId?.trim()) {
    return undefined;
  }
  const protectedAuthority = params.admittedInternalHandoff;
  if (
    (params.inputProvenance?.kind === "inter_session" || protectedAuthority) &&
    (!protectedAuthority ||
      !isAdmittedInternalAgentHandoff(protectedAuthority) ||
      params.inputProvenance !== protectedAuthority.provenance ||
      !consumeAdmittedInternalAgentHandoffForPluginTool({
        authority: protectedAuthority,
        pluginId,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        runId: params.runId ?? "",
        sessionKey: params.sessionKey ?? "",
        sessionId: params.sessionId,
        canonicalParams: params.canonicalParams,
        admittedSessionDeliveryKind: params.admittedSessionDeliveryKind,
      }))
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
    toolName: params.toolName,
    ...(params.toolCallId !== undefined ? { toolCallId: params.toolCallId } : {}),
    canonicalParams: params.canonicalParams,
  } satisfies PluginToolExecutionContext;
  const frozenContext = Object.freeze(context);
  hostContexts.set(frozenContext, {
    canonicalParams: params.canonicalParams,
    ...(protectedAuthority ? { protectedAuthority } : {}),
    closed: false,
  });
  return frozenContext;
}

/** Public SDK predicate for rejecting forged/copied/mutated contexts. */
export function isHostPluginToolExecutionContext(
  value: unknown,
): value is PluginToolExecutionContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PluginToolExecutionContext>;
  const state = hostContexts.get(value);
  const authorityState = state?.protectedAuthority;
  if (
    !state ||
    state.closed ||
    typeof candidate.pluginId !== "string" ||
    typeof candidate.toolName !== "string" ||
    !candidate.toolName.trim() ||
    candidate.canonicalParams !== state.canonicalParams ||
    (authorityState && !isAdmittedInternalAgentHandoff(authorityState))
  ) {
    return false;
  }
  if (state.protectedAuthority && !isFrozenObject(state.canonicalParams)) {
    return false;
  }
  return Object.isFrozen(value);
}

/** Host-only lifecycle close; retained contexts fail validation after return. */
export function closeHostPluginToolExecutionContext(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const state = hostContexts.get(value);
  if (state) {
    state.closed = true;
  }
}
