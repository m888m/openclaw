/**
 * Generic run-provenance extraction, split into its own dependency-free
 * module so importing it does not pull in `extra-params.ts`'s heavier
 * provider-runtime module surface (that surface references
 * `../../plugins/provider-hook-runtime.js` at module scope, which several
 * existing unit tests mock only partially).
 */
import type { ProviderRunProvenance } from "../../plugin-sdk/plugin-entry.js";

/**
 * Extracts the generic run-provenance signals from a run/attempt-shaped
 * object for forwarding to a provider plugin's `prepareExtraParams` hook via
 * `resolvePreparedExtraParams`/`applyExtraParamsToAgent`. Accepts any object
 * exposing (a subset of) the same field names, so callers can pass an
 * `EmbeddedRunAttemptParams` or `RunEmbeddedAgentParams`-shaped value
 * directly without an intermediate cast.
 */
export function extractProviderRunProvenance(
  source: Partial<ProviderRunProvenance>,
): ProviderRunProvenance {
  return {
    trigger: source.trigger,
    bootstrapContextRunKind: source.bootstrapContextRunKind,
    inputProvenance: source.inputProvenance,
    currentInboundEventKind: source.currentInboundEventKind,
    spawnedBy: source.spawnedBy,
    trustedInternalHandoff: source.trustedInternalHandoff,
  };
}
