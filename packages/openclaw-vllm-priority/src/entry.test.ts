import { describe, expect, it, vi } from "vitest";
import entry from "./entry.js";

function createFakeApi(pluginConfig: Record<string, unknown> | undefined) {
  return {
    id: "openclaw-vllm-priority",
    name: "vLLM Priority",
    source: "test",
    registrationMode: "native",
    config: {},
    pluginConfig,
    registerProvider: vi.fn(),
  } as unknown as Parameters<typeof entry.register>[0] & {
    registerProvider: ReturnType<typeof vi.fn>;
  };
}

describe("openclaw-vllm-priority entry", () => {
  it("registers a provider with hookAliases from the configured providers list", () => {
    const api = createFakeApi({ vllmPriority: { providers: ["local", "spark2"] } });

    entry.register(api);

    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    const registered = api.registerProvider.mock.calls[0]?.[0];
    expect(registered.id).toBe("openclaw-vllm-priority");
    expect(registered.hookAliases).toEqual(["local", "spark2"]);
    expect(registered.auth).toEqual([]);
    expect(typeof registered.prepareExtraParams).toBe("function");
  });

  it("does not register when explicitly disabled", () => {
    const api = createFakeApi({ vllmPriority: { enabled: false, providers: ["local"] } });

    entry.register(api);

    expect(api.registerProvider).not.toHaveBeenCalled();
  });

  it("registers with empty hookAliases (never matches a real provider) when no providers are configured", () => {
    const api = createFakeApi(undefined);

    entry.register(api);

    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    const registered = api.registerProvider.mock.calls[0]?.[0];
    expect(registered.hookAliases).toEqual([]);
  });

  it("applies configured priority overrides through the registered prepareExtraParams hook", () => {
    const api = createFakeApi({
      vllmPriority: { providers: ["local"], priorities: { foreground: -50 } },
    });

    entry.register(api);

    const registered = api.registerProvider.mock.calls[0]?.[0];
    const result = registered.prepareExtraParams({
      provider: "local",
      modelId: "qwen",
      model: {
        provider: "local",
        id: "qwen",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8000/v1",
        input: ["text"],
      },
      runProvenance: { trigger: "user", currentInboundEventKind: "user_request" },
      extraParams: { extraBody: { priority: 0 } },
    });

    expect(result).toEqual({ extraBody: { priority: -50 } });
  });
});
