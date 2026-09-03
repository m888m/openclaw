/**
 * vLLM request-priority classification and extra_body injection.
 *
 * `resolveModelCallUrgency` and the extra_body helpers below are ported
 * verbatim from the de-forked core implementation
 * (`src/agents/embedded-agent-runner/vllm-priority.ts` at commit
 * `9564aa4d5a6a56e5a51ca28ac78ac76549d1b1ad` in openclaw) - see the parity
 * tests in `vllm-priority.test.ts`, which assert identical classification
 * against the fork's own test vectors.
 *
 * `prepareVllmPriorityExtraParams` (the `ProviderPlugin.prepareExtraParams`
 * adapter below) is new glue, not a port: the fork ran inside core and read
 * two independent extra-params tracks (a cached "effective" value and a
 * raw per-request "override"), because it bypassed the plugin hook system
 * entirely. The stock `prepareExtraParams(ctx)` hook this plugin uses -
 * the same hook every other OpenClaw provider plugin uses - only exposes
 * one already-merged `ctx.extraParams`, not the fork's separate
 * `configuredExtraParams` (model config only) view. To preserve the fork's
 * actual invariant - the neutral `priority: 0` marker only opts a call in
 * when an OPERATOR configured it on that model, never when a request-scoped
 * override merely happens to carry it - the opt-in check below reads
 * `ctx.model?.params` (the model's own configured params, independent of
 * any request override) instead of the merged `ctx.extraParams`. A
 * request-scoped-only `priority: 0` therefore does NOT opt a call in, same
 * as the fork.
 */
import type {
  ProviderPrepareExtraParamsContext,
  ProviderRunProvenance,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { isPrivateModelEndpoint } from "./private-endpoint.js";

export type ModelCallUrgency = "foreground" | "normal" | "background";

export type VllmPriority = -100 | 0 | 100;

/** Per-urgency priority values. Defaults match the fork's `-100|0|100` lanes. */
export type VllmPriorityMap = {
  foreground: VllmPriority;
  normal: VllmPriority;
  background: VllmPriority;
};

export const DEFAULT_VLLM_PRIORITY_MAP: VllmPriorityMap = {
  foreground: -100,
  normal: 0,
  background: 100,
};

/** True for an `openai-completions` model whose baseUrl is a private/loopback endpoint. */
export function isVllmCompatibleModel(model: ProviderRuntimeModel | undefined): boolean {
  return model?.api === "openai-completions" && isPrivateModelEndpoint(model.baseUrl);
}

/**
 * Classifies a model call's urgency from run-provenance signals. Ported
 * verbatim from the fork's `resolveModelCallUrgency` - see
 * `vllm-priority.test.ts` for the parity vectors against the fork's own
 * `resolveModelCallUrgency` test cases.
 */
export function resolveModelCallUrgency(provenance: ProviderRunProvenance): ModelCallUrgency {
  const backgroundRunKind =
    provenance.bootstrapContextRunKind === "cron" ||
    provenance.bootstrapContextRunKind === "heartbeat";
  const backgroundTrigger =
    provenance.trigger === "cron" ||
    provenance.trigger === "heartbeat" ||
    provenance.trigger === "memory";
  if (backgroundRunKind || backgroundTrigger) {
    return "background";
  }
  if (
    provenance.spawnedBy ||
    Boolean(provenance.trustedInternalHandoff) ||
    provenance.inputProvenance?.kind === "inter_session" ||
    provenance.inputProvenance?.kind === "internal_system"
  ) {
    return "normal";
  }
  if (
    provenance.currentInboundEventKind === "user_request" ||
    provenance.inputProvenance?.kind === "external_user" ||
    provenance.trigger === "user"
  ) {
    return "foreground";
  }
  return "normal";
}

function priorityForUrgency(urgency: ModelCallUrgency, priorityMap: VllmPriorityMap): VllmPriority {
  return priorityMap[urgency];
}

function readExtraBody(extraParams: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extraParams) {
    return {};
  }
  const value = Object.hasOwn(extraParams, "extra_body")
    ? extraParams.extra_body
    : extraParams.extraBody;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withPriority(
  extraParams: Record<string, unknown>,
  priority: VllmPriority,
): Record<string, unknown> {
  const { extra_body: _extraBodySnake, extraBody: _extraBodyCamel, ...rest } = extraParams;
  return {
    ...rest,
    extraBody: {
      ...readExtraBody(extraParams),
      priority,
    },
  };
}

function withoutPriority(extraParams: Record<string, unknown>): Record<string, unknown> {
  const extraBody = readExtraBody(extraParams);
  if (!Object.hasOwn(extraBody, "priority")) {
    return extraParams;
  }
  const { priority: _priority, ...extraBodyWithoutPriority } = extraBody;
  const { extra_body: _extraBodySnake, extraBody: _extraBodyCamel, ...rest } = extraParams;
  return Object.keys(extraBodyWithoutPriority).length > 0
    ? { ...rest, extraBody: extraBodyWithoutPriority }
    : rest;
}

export type VllmPriorityPluginOptions = {
  /** Provider ids this plugin claims for `prepareExtraParams`. Empty means it never matches a real provider. */
  providers: string[];
  priorityMap: VllmPriorityMap;
};

/**
 * `ProviderPlugin.prepareExtraParams` implementation. Reads `ctx.runProvenance`
 * (from the core hook in Unit A), classifies urgency, and rewrites the
 * neutral `priority: 0` marker configured under the model's `extraBody`/
 * `extra_body` params into the per-attempt priority - but only for a private,
 * vLLM-compatible (`openai-completions`) endpoint. Returns the extraParams
 * unchanged (or with a stray `priority` field stripped) for every other
 * model, so a vLLM-only field never reaches a hosted or unrelated provider.
 */
export function prepareVllmPriorityExtraParams(
  ctx: ProviderPrepareExtraParamsContext,
  options: VllmPriorityPluginOptions,
): Record<string, unknown> | undefined {
  if (!ctx.extraParams) {
    return undefined;
  }
  // Opt-in is read from the model's OWN configured params (`ctx.model.params`,
  // sourced from `models.providers.<id>.models[].params` /
  // `agents.defaults.models.<ref>.params`), never from the merged
  // `ctx.extraParams` the request actually sends. This matches the fork's
  // `configuredExtraParams`-only check: a request-scoped override that
  // merely happens to carry `priority: 0` must NOT activate injection on a
  // private endpoint the operator never opted in via config.
  const optedIn =
    isVllmCompatibleModel(ctx.model) && readExtraBody(ctx.model?.params).priority === 0;
  if (!optedIn) {
    return withoutPriority(ctx.extraParams);
  }
  const urgency = resolveModelCallUrgency(ctx.runProvenance ?? {});
  return withPriority(ctx.extraParams, priorityForUrgency(urgency, options.priorityMap));
}
