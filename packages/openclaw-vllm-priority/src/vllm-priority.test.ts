// Parity tests: vectors ported from the de-forked core implementation's own
// suite (openclaw commit 9564aa4d5a6a56e5a51ca28ac78ac76549d1b1ad,
// `src/agents/embedded-agent-runner/vllm-priority.test.ts`). Each `it.each`
// table below reproduces the fork's inputs and expected outputs verbatim;
// see the class-level comment in `vllm-priority.ts` for the one fork
// scenario ("rejects a request-scoped neutral marker without configured
// opt-in") that this hook shape cannot reproduce, and why - it is asserted
// separately below as a documented behavior difference, not a pass/fail
// parity case.
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

const localModel: ProviderRuntimeModel = {
  provider: "local",
  id: "qwen",
  api: "openai-completions",
  baseUrl: "http://192.168.100.11:8000/v1",
  input: ["text"],
} as ProviderRuntimeModel;

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
// `ctx.extraParams`. Each row below feeds this plugin the fork's own
// `effectiveExtraParams` value (the cached/config-driven track, which is
// what `ctx.extraParams` represents) and asserts an identical result.
describe("prepareVllmPriorityExtraParams (parity with fork prepareVllmPriorityExtraParams)", () => {
  it("rewrites a camel-case neutral marker and preserves body siblings [fork case: 'rewrites a camel-case neutral marker and preserves body siblings']", () => {
    const result = prepareVllmPriorityExtraParams(
      ctx({
        model: localModel,
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
        model: localModel,
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
        model: { ...localModel, provider: "spark2" },
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
        model: localModel,
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
        } as ProviderRuntimeModel,
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
        } as ProviderRuntimeModel,
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" },
        extraParams: { temperature: 0.5 },
      }),
      { providers: ["openai"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ temperature: 0.5 });
  });

  it("DOCUMENTED DEVIATION: a request-scoped-only marker opts in here, unlike the fork [fork case: 'rejects a request-scoped neutral marker without configured opt-in']", () => {
    // In the fork, `configuredExtraParams` (model config only) and
    // `extraParamsOverride` (request-scoped) were separate arguments, so a
    // `priority: 0` present ONLY in the request-scoped override (never
    // configured) was rejected: the fork's expected output stripped
    // `priority` entirely. This plugin's `ctx.extraParams` is already the
    // single post-merge value the standard `prepareExtraParams` hook
    // exposes - it cannot distinguish "came from config" from "came from a
    // request override" - so a `priority: 0` anywhere in it opts in. This
    // is an accepted, documented consequence of using the stock hook
    // instead of a core-only two-track mechanism; it does not weaken
    // anything outside the already-guarded private/vLLM-compatible-endpoint
    // boundary.
    const result = prepareVllmPriorityExtraParams(
      ctx({
        model: localModel,
        runProvenance: { trigger: "user", currentInboundEventKind: "user_request" }, // -> foreground
        extraParams: { extraBody: { priority: 0, request_field: true } },
      }),
      { providers: ["local"], priorityMap: DEFAULT_VLLM_PRIORITY_MAP },
    );

    expect(result).toEqual({ extraBody: { priority: -100, request_field: true } });
  });
});
