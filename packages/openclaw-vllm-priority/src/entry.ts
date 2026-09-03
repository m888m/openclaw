/**
 * vLLM priority plugin entry. Registers a `ProviderPlugin` whose
 * `prepareExtraParams` hook injects vLLM request-scheduling priority for
 * private, `openai-completions`-compatible endpoints - see
 * `vllm-priority.ts` for the ported classification/injection logic and
 * `docs/gateway/local-models.md` (openclaw core, "One shared vLLM engine
 * with priority lanes") for the feature this plugin implements.
 */
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VLLM_PRIORITY_JSON_CONFIG_SCHEMA, type VllmPriorityConfig } from "./config.js";
import {
  DEFAULT_VLLM_PRIORITY_MAP,
  prepareVllmPriorityExtraParams,
  type VllmPriorityMap,
} from "./vllm-priority.js";

const PLUGIN_ID = "openclaw-vllm-priority";

function resolvePriorityMap(config: VllmPriorityConfig): VllmPriorityMap {
  return {
    foreground: config.priorities?.foreground ?? DEFAULT_VLLM_PRIORITY_MAP.foreground,
    normal: config.priorities?.normal ?? DEFAULT_VLLM_PRIORITY_MAP.normal,
    background: config.priorities?.background ?? DEFAULT_VLLM_PRIORITY_MAP.background,
  } as VllmPriorityMap;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "vLLM Priority",
  description:
    "Prioritizes shared local/private vLLM requests by run-provenance urgency (foreground/normal/background), so one vLLM engine with --scheduling-policy priority can serve interactive and background agent traffic without separate model copies.",
  configSchema: buildJsonPluginConfigSchema(VLLM_PRIORITY_JSON_CONFIG_SCHEMA),
  register(api) {
    const config = ((api.pluginConfig as { vllmPriority?: VllmPriorityConfig } | undefined)
      ?.vllmPriority ?? {}) as VllmPriorityConfig;
    if (config.enabled === false) {
      return;
    }
    const providers = config.providers ?? [];
    const priorityMap = resolvePriorityMap(config);
    api.registerProvider({
      id: PLUGIN_ID,
      label: "vLLM Priority",
      // Internal-only routing aliases: OpenClaw resolves at most one
      // provider plugin per provider id, so this plugin only intercepts
      // `prepareExtraParams` for the provider ids the operator lists in
      // config - it does not participate in auth/setup surfaces for them.
      hookAliases: providers,
      auth: [],
      prepareExtraParams: (ctx) => prepareVllmPriorityExtraParams(ctx, { providers, priorityMap }),
    });
  },
});
