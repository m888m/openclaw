/**
 * Generic run-provenance extraction, split into its own dependency-free
 * module so importing it does not pull in `extra-params.ts`'s heavier
 * provider-runtime module surface (that surface references
 * `../../plugins/provider-hook-runtime.js` at module scope, which several
 * existing unit tests mock only partially).
 */
import type { ProviderRunProvenance } from "../../plugin-sdk/plugin-entry.js";
import type { TrustedSubagentCompletionHandoff } from "../subagents/announce/subagent-announce-handoff.js";

/**
 * Run/attempt-shaped source accepted by `extractProviderRunProvenance`.
 *
 * Every field except `trustedInternalHandoff` matches `ProviderRunProvenance`
 * directly. `trustedInternalHandoff` is wider here because the internal
 * run/attempt types (e.g. `RunEmbeddedAgentParams`) carry the full internal
 * `TrustedSubagentCompletionHandoff` object (session ids and all) - the
 * public `ProviderRunProvenance.trustedInternalHandoff` is a plain boolean,
 * so the extraction coerces it below rather than forwarding the object.
 */
type ProviderRunProvenanceSource = Omit<
  Partial<ProviderRunProvenance>,
  "trustedInternalHandoff"
> & {
  trustedInternalHandoff?: boolean | TrustedSubagentCompletionHandoff | null;
};

/**
 * Extracts the generic run-provenance signals from a run/attempt-shaped
 * object for forwarding to a provider plugin's `prepareExtraParams` hook via
 * `resolvePreparedExtraParams`/`applyExtraParamsToAgent`. Accepts any object
 * exposing (a subset of) the same field names, so callers can pass an
 * `EmbeddedRunAttemptParams` or `RunEmbeddedAgentParams`-shaped value
 * directly without an intermediate cast.
 */
export function extractProviderRunProvenance(
  source: ProviderRunProvenanceSource,
): ProviderRunProvenance {
  return {
    trigger: source.trigger,
    bootstrapContextRunKind: source.bootstrapContextRunKind,
    inputProvenance: source.inputProvenance,
    currentInboundEventKind: source.currentInboundEventKind,
    spawnedBy: source.spawnedBy,
    // Coerce to a plain boolean for the public SDK surface - never forward
    // the internal handoff object (it carries session ids). Preserve
    // `undefined` (vs. `false`) when the source doesn't have the field at
    // all, matching every other field's "absent means undefined" contract.
    trustedInternalHandoff:
      source.trustedInternalHandoff === undefined || source.trustedInternalHandoff === null
        ? undefined
        : Boolean(source.trustedInternalHandoff),
  };
}
