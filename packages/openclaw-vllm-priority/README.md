# @openclaw/vllm-priority

OpenClaw provider plugin that prioritizes shared local/private vLLM requests by
run-provenance urgency, so one vLLM engine running `--scheduling-policy
priority` can serve interactive (foreground) and background (cron/heartbeat)
agent traffic without loading separate model copies.

This is the plugin half of a de-forked feature. The core half is a small,
generic `runProvenance` field on `ProviderPrepareExtraParamsContext`
(`openclaw/plugin-sdk/plugin-entry`) — see the openclaw PR that introduced it
for the core-side rationale. This README is self-contained: it does not
assume any other doc page exists, since this plugin can be installed into any
OpenClaw host independently of that core PR landing upstream (the interim
state is: upstream OpenClaw + this plugin, once the small core hook patch is
applied — see "Requirements" below).

## Requirements

- An OpenClaw build that exposes `runProvenance` on
  `ProviderPrepareExtraParamsContext` (`openclaw/plugin-sdk/plugin-entry`).
  Until that lands in a released `openclaw` version, this plugin still loads
  and runs on a stock OpenClaw build, but `ctx.runProvenance` is always
  `undefined`, so every call classifies as `"normal"` (priority `0`) — a safe,
  inert default, never a crash. See `package.json`'s `peerDependencies.openclaw`
  for the version floor this was validated against.
- A vLLM engine started with `--scheduling-policy priority` (see "Server
  setup" below). Nonzero request priorities are rejected by a server running
  the default FCFS scheduler.

## Install

This package currently ships as an in-tree workspace package
(`packages/openclaw-vllm-priority`) in the `openclaw` monorepo, not yet a
published npm/ClawHub artifact. Until it is published, install it as a local
development checkout (see OpenClaw's
[Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins) guide for
the full `openclaw plugins install` command reference):

```bash
# From your OpenClaw checkout/build:
npm run build --workspace @openclaw/vllm-priority   # or: pnpm --filter @openclaw/vllm-priority build
openclaw plugins install --link /path/to/openclaw/packages/openclaw-vllm-priority
```

`--link` points OpenClaw at the built `dist/` in place (no copy), which is
convenient while iterating. For a normal (non-linked) install once this is
published, it will be `openclaw plugins install npm:@openclaw/vllm-priority`
or `openclaw plugins install clawhub:@openclaw/vllm-priority`.

If OpenClaw records the install but leaves the plugin disabled (this happens
when required configuration — the `providers` list below — is not present
yet), configure it (see "Config" below) and then enable it:

```bash
openclaw plugins enable openclaw-vllm-priority
```

A running managed Gateway with config reload enabled restarts automatically
after install; otherwise run `openclaw gateway restart`. Verify it actually
registered:

```bash
openclaw plugins inspect openclaw-vllm-priority --runtime --json
```

## Config

Plugin config lives under `plugins.entries.<id>.config` (the "entries" segment
is the OpenClaw plugin config convention, not this plugin's own invention):

```json5
{
  plugins: {
    entries: {
      "openclaw-vllm-priority": {
        enabled: true,
        config: {
          vllmPriority: {
            enabled: true, // default true
            providers: ["local"], // provider ids (models.providers.<id>) this plugin claims
            priorities: { foreground: -100, normal: 0, background: 100 }, // optional overrides
          },
        },
      },
    },
  },
}
```

Then, on the model itself, opt in with the neutral marker (this is the
_per-model_ switch — the `providers` list above only makes the plugin
eligible to run for that provider id at all):

```json5
{
  agents: {
    defaults: {
      models: {
        "local/my-local-model": {
          params: {
            extraBody: { priority: 0 },
          },
        },
      },
    },
  },
}
```

## How it works

1. A private (loopback/LAN), `openai-completions`-compatible model opts in by
   setting the neutral marker `params.extraBody: { priority: 0 }` (or
   `extra_body`) on its **model config** (`agents.defaults.models.<ref>.params`
   or `models.providers.<id>.models[].params`) — not on a request override.
2. This plugin must be listed as the handler for that provider id via
   `providers` in its own config (above) — OpenClaw resolves at most one
   provider plugin per provider id, so listing it here is what makes this
   plugin's `prepareExtraParams` hook run for that provider at all.
3. On each call, the plugin reads `ctx.runProvenance` (trigger,
   `bootstrapContextRunKind`, `inputProvenance`, `currentInboundEventKind`,
   `spawnedBy`, `trustedInternalHandoff`), classifies the call as
   `foreground` / `normal` / `background`, and — **only if the model's
   configured params carry the opt-in marker** — rewrites it to the
   corresponding priority (`-100` / `0` / `100` by default, configurable).
   The opt-in check reads the model's _configured_ params
   (`ctx.model.params`), never the merged/request-scoped `ctx.extraParams`,
   so a request override that happens to carry `priority: 0` cannot activate
   injection on a model the operator never opted in.
4. For every other model (no configured opt-in marker, or not a private
   vLLM-compatible endpoint), the plugin leaves `extraParams` unchanged -
   except it strips a stray `priority` field so a vLLM-only field never
   leaks to a hosted or unrelated provider (e.g. a configured local model
   falling back to a cloud model).

`providers` should only list provider ids that are genuinely private vLLM
endpoints running `--scheduling-policy priority`. Do not list a built-in
provider id (e.g. `openai`) here — OpenClaw resolves at most one provider
plugin per provider id, so doing so would displace that provider's own
`prepareExtraParams` handling.

## Server setup

vLLM must start with priority scheduling:

```bash
vllm serve <model-id> \
  --served-model-name <canonical-name> <stable-alias> \
  --scheduling-policy priority \
  --enable-prefix-caching
```

Keep every alias immediately after `--served-model-name` and before the next
option. Priority does not replace the normal capacity controls — size
`--max-num-seqs`, `--max-num-batched-tokens`, the context limit, and GPU
memory utilization for the one shared engine. See the
[vLLM scheduler reference](https://docs.vllm.ai/en/stable/api/vllm/config/scheduler/)
and [automatic prefix caching design](https://docs.vllm.ai/en/stable/design/prefix_caching/).

## Priority lanes

| Lane       | vLLM priority | OpenClaw provenance                                                                   |
| ---------- | ------------: | ------------------------------------------------------------------------------------- |
| Foreground |        `-100` | A current inbound `user_request`, `external_user` input, or direct user-triggered run |
| Normal     |           `0` | Spawned work, trusted handoffs, inter-session/internal input, or unclassified work    |
| Background |         `100` | Cron, heartbeat, or memory-triggered work                                             |

Lower numbers are handled earlier when requests contend. A background
classification wins if a run also carries foreground-looking metadata, so
scheduler/maintenance work cannot accidentally enter the foreground lane.

## Verification

1. Confirm the running server command has one engine with
   `--scheduling-policy priority` and `--enable-prefix-caching`.
2. `openclaw plugins inspect openclaw-vllm-priority --runtime --json` to
   confirm the plugin registered.
3. Run this package's own test suite:
   ```bash
   node scripts/run-vitest.mjs packages/openclaw-vllm-priority
   ```
4. Submit a synchronized burst of long requests classified at different
   urgencies (a cron run vs. an interactive message, say), then inspect
   server request logs/metrics for priority ordering. Repeat the burst —
   wall-clock order from a single short request is not reliable evidence of
   scheduler behavior.
5. Exercise one hosted fallback and confirm its outgoing request body
   contains no `priority` while sibling `extra_body` fields remain present.

## Classification (ported from the fork)

`resolveModelCallUrgency` and the `extra_body`/`extraBody` rewrite helpers in
`vllm-priority.ts` are ported verbatim from openclaw core commit
`9564aa4d5a6a56e5a51ca28ac78ac76549d1b1ad`
(`src/agents/embedded-agent-runner/vllm-priority.ts`), the working
implementation this plugin de-forks. `vllm-priority.test.ts` reproduces that
commit's own test vectors and asserts identical output, including the
per-model config-only opt-in invariant (a request-scoped-only marker does not
activate injection).

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
