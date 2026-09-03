// Parity tests: vectors ported from the de-forked core implementation's own
// suite (openclaw commit 9564aa4d5a6a56e5a51ca28ac78ac76549d1b1ad,
// `src/agents/embedded-agent-runner/vllm-priority.test.ts`). Each `it.each`
// table below reproduces the fork's inputs and expected outputs verbatim.
//
// The opt-in check reads `ctx.model?.params` (the model's own CONFIGURED
// params), matching the fork's `configuredExtraParams` argument exactly -
// see the class-level comment in `vllm-priority.ts`. `ctx.extraParams` (the
// merged config+request-override view the stock hook exposes) is only ever
// used as the injection TARGET, never as the opt-in source, so a
// request-scoped-only `priority: 0` cannot activate injection - the "rejects
// a request-scoped neutral marker without configured opt-in" fork case
// reproduces exactly (see below), and the dedicated
// "non-vLLM private endpoint" test proves the same invariant from the angle
// the review flagged: a private, listed, `openai-completions` endpoint with
// no CONFIGURED opt-in must not fire even when a request carries
// `priority: 0`.
import type {
  ProviderPrepareExtraParamsContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VLLM_PRIORITY_MAP,
  prepareVllmPriorityExtraParams,
  resolveModelCallUrgency,
} from "./vllm-priority.js";

// Configured (model-config) opt-in marker - the fork's `configuredExtraParams`.
const localModel: ProviderRuntimeModel = {
  provider: "local",
  id: "qwen",
  api: "openai-completions",
  baseUrl: "http://192.168.100.11:8000/v1",
  input: ["text"],
  params: { extraBody: { priority: 0 } },
} as unknown as ProviderRuntimeModel;

function ctx(
  overrides: Partial<ProviderPrepareExtraParamsContext>,
): ProviderPrepareExtraParamsContext {
  return {
    provider: "local",
    modelId: "qwen",
    ...overrides,
  };
}

describe("resolveModelCallUrgency (parity with fork vllm-priority.test.ts)", () => {
  it.each([
    ["channel request", { currentInboundEventKind: "user_request" as const }],
    ["external user", { inputProvenance: { kind: "external_user" as const } }],
    ["direct CLI or gateway user", { trigger: "user" as const }],
  ])("classifies %s as foreground", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("foreground");
  });

  it.each([
    ["inter-session input", { inputProvenance: { kind: "inter_session" as const } }],
    ["internal input", { inputProvenance: { kind: "internal_system" as const } }],
    ["spawned work", { trigger: "user" as const, spawnedBy: "agent:parent:main" }],
    ["trusted handoff", { trigger: "user" as const, trustedInternalHandoff: true }],
  ])("classifies %s as normal", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("normal");
  });

  it.each([
    ["cron trigger", { trigger: "cron" as const }],
    ["heartbeat run", { bootstrapContextRunKind: "heartbeat" as const }],
    ["memory run", { trigger: "memory" as const }],
  ])("classifies %s as background", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("background");
  });

  it("keeps heartbeat precedence over external-user and spawned signals", () => {
    expect(
      resolveModelCallUrgency({
        trigger: "heartbeat",
        currentInboundEventKind: "user_request",
        inputProvenance: { kind: "external_user" },
        spawnedBy: "agent:parent:main",
      }),
    ).toBe("background");
  });
});

// Fork-vs-plugin parity table for the priority-injection path.
//
// The fork's `prepareVllmPriorityExtraParams` operated on two independent
// tracks (`effectiveExtraParams` and `extraParamsOverride`) because it ran
// inside core, ahead of the standard plugin hook. This plugin uses the
// stock `prepareExtraParams(ctx)` hook - the same one every OpenClaw
// provider plugin uses - which exposes a single, already-merged
// `ctx.extraParams` as the injection target. Each row below feeds this
// plugin the fork's own `effectiveExtraParams` value as `ctx.extraParams`,
// and the fork's own `configuredExtraParams` value as `ctx.model.params`
// (the opt-in source), and asserts an identical result.
describe("prepareVllmPriorityExtraParams (parity with fork prepareVllmPriorityExtraParams)", () => {
  it("rewrites a camel-case neutral marker and preserves body siblings [fork case: 'rewrites a camel-case neutral marker and preserves body siblings']", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        model: localModel, // configured: extraBody.priority === 0
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" }, // -> foreground
        extraParams: {
          temperature: 0.2,
          extraBody: { priority: 0, guided_decoding_backend: "outlines" },
        },
      }),
      { providers: ["local"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({
      temperature: 0.2,
      extraBody: { priority: -100, guided_decoding_backend: "outlines" },
    });
  });

  it("supports a snake-case neutral marker [fork case: 'supports a snake-case neutral marker and request body override']", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        model: { ...localModel, params: { extra_body: { priority: 0 } } }, // configured, snake_case
        runProvenance: { trigger: "cron" }, // -> background
        extraParams: { extra_body: { priority: 0, service_tier: "auto" } },
      }),
      { providers: ["local"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { priority: 100, service_tier: "auto" } });
  });

  it("accepts an arbitrary provider id for an opted-in private endpoint [fork case: same name]", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        provider: "spark2",
        model: { ...localModel, provider: "spark2" }, // configured opt-in carries over
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" }, // -> foreground
        extraParams: { extraBody: { priority: 0, service_tier: "auto" } },
      }),
      { providers: ["spark2"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { priority: -100, service_tier: "auto" } });
  });

  it("does not treat a legacy nonzero priority as opt-in [fork case: same name]", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        model: { ...localModel, params: { extraBody: { priority: -100 } } }, // configured nonzero, not neutral
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" },
        extraParams: { extraBody: { priority: -100, service_tier: "auto" } },
      }),
      { providers: ["local"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { service_tier: "auto" } });
  });

  it("strips the private-endpoint priority marker from cloud fallback without dropping siblings [fork case: same name]", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        provider: "kilo",
        model: {
          provider: "kilo",
          id: "cloud-model",
          api: "openai-completions",
          baseUrl: "https://api.kilo.ai/v1",
          input: ["text"],
          params: { extraBody: { priority: 0 } }, // inherited configured marker, but not private
        } as unknown as ProviderRuntimeModel,
        runProvenance: { trigger: "cron" },
        extraParams: { extraBody: { priority: 0, service_tier: "auto" } },
      }),
      { providers: ["local", "kilo"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { service_tier: "auto" } });
  });

  it("is a no-op for a hosted provider with no priority field at all", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        provider: "openai",
        model: {
          provider: "openai",
          id: "gpt-5",
          api: "openai-responses",
        } as unknown as ProviderRuntimeModel,
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" },
        extraParams: { temperature: 0.5 },
      }),
      { providers: ["openai"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ temperature: 0.5 });
  });

  it("rejects a request-scoped neutral marker without configured opt-in [fork case: same name]", () => {
    // The fork rejected a `priority: 0` present ONLY in the request-scoped
    // override (never configured): expected output strips `priority`
    // entirely while preserving siblings. Now that the opt-in check reads
    // `ctx.model.params` (configured) instead of `ctx.extraParams` (merged
    // request view), this plugin reproduces that exactly: no configured
    // marker on the model here, only a request-scoped one in extraParams.
    const result = prepareVllmPriorityExtraParams(
      ctx({
        model: { ...localModel, params: undefined }, // NOT opted in via config
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" }, // -> foreground
        extraParams: { extraBody: { priority: 0, request_field: true } }, // request-scoped only
      }),
      { providers: ["local"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { request_field: true } });
  });

  it("does not inject on a private, listed openai-completions endpoint that was never opted in via config, even when a request carries priority:0 (injection-safety regression test)", () => {
    // Regression test for the review finding: a private/loopback
    // `openai-completions` endpoint that the operator listed in
    // `vllmPriority.providers` (so the plugin's prepareExtraParams hook
    // does run for it), but for which the model was never configured with
    // the `extraBody: { priority: 0 }` opt-in marker - only a request
    // happens to carry one. This must be a strict no-op (bare strip, no
    // injection), regardless of urgency, exactly like a hosted provider.
    const notOptedInPrivateModel: ProviderRuntimeModel = {
      provider: "llamacpp-local",
      id: "some-local-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1", // private/loopback -> isVllmCompatibleModel would be true
      input: ["text"],
      // no `params` at all: never opted in via config
    } as unknown as ProviderRuntimeModel;

    const result = prepareVllmPriorityExtraParams(
      ctx({
        provider: "llamacpp-local",
        model: notOptedInPrivateModel,
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" }, // -> foreground
        extraParams: { extraBody: { priority: 0, some_field: true } }, // request-scoped only
      }),
      { providers: ["llamacpp-local"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { some_field: true } });
    expect(result).not.toHaveProperty("extraBody.priority");
  });
});
