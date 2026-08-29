import { describe, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";

const gatewayDispatch = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ runId: "accepted-run" })),
);
vi.mock("./server-plugins.js", () => ({
  dispatchGatewayMethodInProcess: gatewayDispatch,
}));
import {
  consumeAdmittedInternalAgentHandoffForPluginTool,
  consumeInternalAgentHandoffCapability,
  issueInternalAgentHandoffCapability,
} from "./internal-agent-handoff.js";

function issue(overrides: Partial<Parameters<typeof issueInternalAgentHandoffCapability>[0]> = {}) {
  return issueInternalAgentHandoffCapability({
    sourceSessionKey: "agent:source:main",
    sourceSessionId: "source-session-1",
    targetSessionKey: "agent:target:main",
    targetSessionId: "target-session-1",
    requestId: "handoff-1",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    ...overrides,
  });
}

function consume(capability: unknown, overrides: Record<string, unknown> = {}) {
  return consumeInternalAgentHandoffCapability({
    capability,
    sourceSessionKey: "agent:source:main",
    sourceSessionId: "source-session-1",
    targetSessionKey: "agent:target:main",
    targetSessionId: "target-session-1",
    requestId: "handoff-1",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    ...overrides,
  });
}

describe("internal agent handoff capability", () => {
  it("requires the exact source key and source incarnation at admission", () => {
    const capability = issue({ sourceSessionId: "source-session-1" });

    expect(consume(capability, { sourceSessionId: "" })).toBeUndefined();
  });

  it("does not accept clones and is one-shot at admission", () => {
    const capability = issue();
    expect(consume({ ...(capability as object) })).toBeUndefined();

    const authority = consume(capability);
    expect(authority).toBeDefined();
    expect(authority?.provenance).toEqual({
      kind: "inter_session",
      sourceSessionKey: "agent:source:main",
      sourceTool: "sessions_send",
    });
    expect(authority?.provenance).not.toHaveProperty("originSessionId");
    expect(
      consume(capability),
      "the consumed object capability must not be replayable",
    ).toBeUndefined();
  });

  it("burns capabilities on wrong-target and stale-generation attempts", () => {
    const wrongTarget = issue({ requestId: "wrong-target" });
    expect(
      consume(wrongTarget, { targetSessionKey: "agent:other:main", requestId: "wrong-target" }),
    ).toBeUndefined();
    expect(
      consume(wrongTarget, { targetSessionKey: "agent:target:main", requestId: "wrong-target" }),
    ).toBeUndefined();

    const stale = issue({ lifecycleGeneration: "old-generation", requestId: "stale" });
    expect(consume(stale, { requestId: "stale" })).toBeUndefined();
  });

  it("rejects expiry and binds plugin execution to one admitted authority", () => {
    const expired = issue({ nowMs: 100, deadlineMs: 200, requestId: "expired" });
    expect(consume(expired, { requestId: "expired", nowMs: 201 })).toBeUndefined();

    const capability = issue({ requestId: "plugin-run" });
    const authority = consume(capability, { requestId: "plugin-run" });
    expect(authority).toBeDefined();
    const canonicalParams = Object.freeze({});
    expect(
      consumeAdmittedInternalAgentHandoffForPluginTool({
        authority,
        pluginId: "postman",
        toolName: "postman_lookup",
        toolCallId: "call-1",
        runId: "plugin-run",
        sessionKey: "agent:target:main",
        sessionId: "target-session-1",
        canonicalParams,
        admittedSessionDeliveryKind: "none",
      }),
    ).toBe(true);
    expect(
      consumeAdmittedInternalAgentHandoffForPluginTool({
        authority,
        pluginId: "postman",
        toolName: "postman_lookup",
        toolCallId: "call-1",
        runId: "plugin-run",
        sessionKey: "agent:target:main",
        sessionId: "target-session-1",
        canonicalParams,
        admittedSessionDeliveryKind: "none",
      }),
    ).toBe(false);
  });

  it("rejects plugin consumption after the Gateway lifecycle rotates", () => {
    const capability = issue({ requestId: "rotated-plugin-run" });
    const authority = consume(capability, { requestId: "rotated-plugin-run" });
    expect(authority).toBeDefined();
    rotateAgentEventLifecycleGeneration();

    expect(
      consumeAdmittedInternalAgentHandoffForPluginTool({
        authority,
        pluginId: "tony-postman-a2a",
        toolName: "postman_lookup",
        toolCallId: "call-after-rotation",
        runId: "rotated-plugin-run",
        sessionKey: "agent:target:main",
        sessionId: "target-session-1",
        canonicalParams: Object.freeze({}),
        admittedSessionDeliveryKind: "none",
      }),
    ).toBe(false);
  });

  it("dispatches only through the in-process Gateway seam and strips public provenance", async () => {
    gatewayDispatch.mockClear();
    const request = {
      message: "lookup",
      sessionKey: "forged-display-key",
      idempotencyKey: "forged-idempotency",
      inputProvenance: { kind: "inter_session", sourceTool: "forged" },
    };
    await expect(
      // The Gateway mock captures the object-capability option without opening
      // a network client or permitting a public fallback.
      import("./internal-agent-handoff.js").then(({ dispatchAgentHandoffInProcess }) =>
        dispatchAgentHandoffInProcess({
          sourceSessionKey: "agent:source:main",
          sourceSessionId: "source-session-1",
          targetSessionKey: "agent:target:main",
          targetSessionId: "target-session-1",
          requestId: "handoff-dispatch",
          request,
        }),
      ),
    ).resolves.toEqual({ runId: "accepted-run" });
    expect(request.inputProvenance).toBeDefined();
    expect(gatewayDispatch).toHaveBeenCalledOnce();
    const [method, dispatchedParams, options] = gatewayDispatch.mock.calls[0] ?? [];
    expect(method).toBe("agent");
    expect(dispatchedParams).toMatchObject({
      sessionKey: "agent:target:main",
      expectedExistingSessionId: "target-session-1",
      idempotencyKey: "handoff-dispatch",
    });
    expect(dispatchedParams).not.toHaveProperty("inputProvenance");
    expect(options).toMatchObject({ forceSyntheticClient: true });
    expect(options).toHaveProperty("agentHandoffCapability");
    expect(options).toMatchObject({
      agentHandoffSource: {
        sourceSessionKey: "agent:source:main",
        sourceSessionId: "source-session-1",
      },
    });
  });
});
