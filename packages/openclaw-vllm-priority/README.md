# @openclaw/vllm-priority

OpenClaw provider plugin that prioritizes shared local/private vLLM requests by
run-provenance urgency, so one vLLM engine running `--scheduling-policy
priority` can serve interactive (foreground) and background (cron/heartbeat)
agent traffic without loading separate model copies.

This is the plugin half of a de-forked feature. See openclaw core's
`docs/gateway/local-models.md` ("One shared vLLM engine with priority
lanes") for the end-to-end setup (server flags, the model-config opt-in
marker, verification steps). This package implements the classification and
injection side; the core half is a small, generic `runProvenance` field on
`ProviderPrepareExtraParamsContext` (`openclaw/plugin-sdk/plugin-entry`).

## How it works

1. A private (loopback/LAN), `openai-completions`-compatible model opts in by
   setting the neutral marker `params.extraBody: { priority: 0 }` (or
   `extra_body`) on its model config.
2. This plugin must be listed as the handler for that provider id via
   `providers` in its own config (see below) - OpenClaw resolves at most one
   provider plugin per provider id, so listing it here is what makes this
   plugin's `prepareExtraParams` hook run for that provider at all.
3. On each call, the plugin reads `ctx.runProvenance` (trigger,
   `bootstrapContextRunKind`, `inputProvenance`, `currentInboundEventKind`,
   `spawnedBy`, `trustedInternalHandoff`), classifies the call as
   `foreground` / `normal` / `background`, and rewrites the neutral marker to
   the corresponding priority (`-100` / `0` / `100` by default, configurable).
4. For every other model (no opt-in marker, not a private vLLM-compatible
   endpoint), the plugin leaves `extraParams` unchanged - except it strips a
   stray `priority` field so a vLLM-only field never leaks to a hosted or
   unrelated provider (e.g. a configured local model falling back to a cloud
   model).

## Config

```json5
{
  plugins: {
    "openclaw-vllm-priority": {
      config: {
        vllmPriority: {
          enabled: true, // default true
          providers: ["local"], // provider ids (models.providers.<id>) this plugin claims
          priorities: { foreground: -100, normal: 0, background: 100 }, // optional overrides
        },
      },
    },
  },
}
```

## Classification (ported from the fork)

`resolveModelCallUrgency` and the `extra_body`/`extraBody` rewrite helpers in
`vllm-priority.ts` are ported verbatim from openclaw core commit
`9564aa4d5a6a56e5a51ca28ac78ac76549d1b1ad`
(`src/agents/embedded-agent-runner/vllm-priority.ts`), the working
implementation this plugin de-forks. `vllm-priority.test.ts` reproduces that
commit's own test vectors and asserts identical output.

## Known deviation from the fork

The fork ran inside core and read two independent extra-params tracks (a
cached `effectiveExtraParams` and a raw per-request `extraParamsOverride`),
because it bypassed the plugin hook system entirely. This plugin uses the
stock `prepareExtraParams(ctx)` hook - the same hook every OpenClaw provider
plugin uses - which exposes one already-merged `ctx.extraParams`. As a
result, this plugin cannot distinguish "the neutral marker came from model
config" from "the neutral marker came from a request-scoped override" the way
the fork's `configuredExtraParams` check did. One fork test case ("rejects a
request-scoped neutral marker without configured opt-in") does not carry
over for this reason - see the corresponding test in
`vllm-priority.test.ts` for the exact, asserted behavior difference. This
only affects _whether_ a call opts into priority scheduling; it does not
weaken the private/vLLM-compatible-endpoint boundary.

## `isPrivateModelEndpoint`

The fork's private/loopback endpoint guard used OpenClaw core's internal,
SSRF-hardened `@openclaw/net-policy` package. That package is private to the
OpenClaw monorepo - no provider/tool plugin depends on it - and this plugin
is restricted to importing from `openclaw/plugin-sdk/plugin-entry` only, so
`private-endpoint.ts` is a self-contained reimplementation (Node's
`node:net` plus manual CIDR checks) covering the same address classes
(loopback, RFC 1918 private ranges, link-local, carrier-grade NAT, and their
IPv6 equivalents). It is not the SSRF-hardened implementation core uses to
gate what a URL-fetch tool may reach - see the file header for the full
rationale.
