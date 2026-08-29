import { describe, expect, it } from "vitest";
import {
  consumeInternalAgentHandoffCapability,
  issueInternalAgentHandoffCapability,
} from "../gateway/internal-agent-handoff.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  closeHostPluginToolExecutionContext,
  createHostPluginToolExecutionContext,
  isHostPluginToolExecutionContext,
} from "./plugin-tool-execution-context.js";

function admit(requestId: string) {
  const targetSessionKey = "agent:postman:tony-email-lookup";
  const targetSessionId = "target-session-1";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const capability = issueInternalAgentHandoffCapability({
    sourceSessionKey: "agent:clawy:operator",
    targetSessionKey,
    targetSessionId,
    requestId,
    lifecycleGeneration,
  });
  const authority = consumeInternalAgentHandoffCapability({
    capability,
    targetSessionKey,
    targetSessionId,
    requestId,
    lifecycleGeneration,
  });
  if (!authority) {
    throw new Error("expected test handoff authority");
  }
  return authority;
}

function contextFor(
  authority: ReturnType<typeof admit>,
  canonicalParams: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof createHostPluginToolExecutionContext>[0]> = {},
) {
  return createHostPluginToolExecutionContext({
    pluginId: "tony-postman-a2a",
    agentId: "postman",
    sessionKey: authority.targetSessionKey,
    sessionId: authority.targetSessionId,
    runId: authority.requestId,
    modelProviderId: "local",
    modelId: "dgx-active",
    inputProvenance: authority.provenance,
    admittedSessionDeliveryKind: "none",
    admittedInternalHandoff: authority,
    toolName: "postman_lookup",
    toolCallId: "tool-call-1",
    canonicalParams,
    ...overrides,
  });
}

describe("host plugin tool execution context", () => {
  it("is branded, deeply frozen, identity-bound, and closes after one invocation", () => {
    const authority = admit("run-1");
    const params: Record<string, unknown> = { nested: { value: "immutable" } };
    const context = contextFor(authority, params);

    expect(context).toBeDefined();
    expect(isHostPluginToolExecutionContext(context)).toBe(true);
    expect(context?.canonicalParams).toBe(params);
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.isFrozen(params.nested)).toBe(true);
    expect(isHostPluginToolExecutionContext({ ...context })).toBe(false);
    expect(
      isHostPluginToolExecutionContext({
        ...context,
        canonicalParams: Object.freeze({ nested: { value: "immutable" } }),
      }),
    ).toBe(false);

    closeHostPluginToolExecutionContext(context);
    expect(isHostPluginToolExecutionContext(context)).toBe(false);
    expect(contextFor(authority)).toBeUndefined();
  });

  it("requires the exact admitted provenance and explicit route-null snapshot", () => {
    const authority = admit("run-2");
    expect(
      contextFor(
        authority,
        {},
        {
          inputProvenance: { ...authority.provenance },
        },
      ),
    ).toBeUndefined();

    const missingRouteAuthority = admit("run-3");
    expect(
      contextFor(missingRouteAuthority, {}, { admittedSessionDeliveryKind: undefined }),
    ).toBeUndefined();

    const nonNullRouteAuthority = admit("run-4");
    expect(
      contextFor(nonNullRouteAuthority, {}, { admittedSessionDeliveryKind: "internal" }),
    ).toBeUndefined();
  });
});
