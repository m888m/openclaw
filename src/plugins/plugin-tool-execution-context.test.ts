import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeInternalAgentHandoffCapability,
  issueInternalAgentHandoffCapability,
} from "../gateway/internal-agent-handoff.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  closeHostPluginToolExecutionContext,
  consumeHostPluginToolExecutionContext,
  createHostPluginToolExecutionContext,
  isIssuedHostPluginToolExecutionContext,
  type PluginToolExecutionContext,
} from "./plugin-tool-execution-context.js";

const PLUGIN_ID = "tony-postman-a2a";
const TOOL_NAME = "postman_lookup";

function admit(requestId: string) {
  const targetSessionKey = "agent:postman:tony-email-lookup";
  const targetSessionId = "target-session-1";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const capability = issueInternalAgentHandoffCapability({
    sourceSessionKey: "agent:clawy:operator",
    sourceSessionId: "source-session-1",
    targetSessionKey,
    targetSessionId,
    requestId,
    lifecycleGeneration,
  });
  const authority = consumeInternalAgentHandoffCapability({
    capability,
    sourceSessionKey: "agent:clawy:operator",
    sourceSessionId: "source-session-1",
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
    pluginId: PLUGIN_ID,
    agentId: "postman",
    sessionKey: authority.targetSessionKey,
    sessionId: authority.targetSessionId,
    runId: authority.requestId,
    modelProviderId: "local",
    modelId: "dgx-active",
    inputProvenance: authority.provenance,
    admittedSessionDeliveryKind: "none",
    admittedInternalHandoff: authority,
    toolName: TOOL_NAME,
    toolCallId: "tool-call-1",
    canonicalParams,
    ...overrides,
  });
}

function consume(
  context: PluginToolExecutionContext | undefined,
  overrides: Partial<Parameters<typeof consumeHostPluginToolExecutionContext>[1]> = {},
) {
  return consumeHostPluginToolExecutionContext(context, {
    pluginId: PLUGIN_ID,
    toolName: TOOL_NAME,
    toolCallId: "tool-call-1",
    canonicalParams: context?.canonicalParams,
    ...overrides,
  });
}

describe("host plugin tool execution context", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  it("atomically consumes one exact deeply frozen host invocation", () => {
    const authority = admit("run-1");
    const params: Record<string, unknown> = { nested: { value: "immutable" } };
    const context = contextFor(authority, params);

    expect(context).toBeDefined();
    expect(isIssuedHostPluginToolExecutionContext(context)).toBe(true);
    expect(context?.canonicalParams).toBe(params);
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.isFrozen(params.nested)).toBe(true);
    expect(
      consumeHostPluginToolExecutionContext(
        { ...context },
        {
          pluginId: PLUGIN_ID,
          toolName: TOOL_NAME,
          toolCallId: "tool-call-1",
          canonicalParams: params,
        },
      ),
    ).toBe(false);

    expect(consume(context)).toBe(true);
    expect(consume(context)).toBe(false);
    expect(isIssuedHostPluginToolExecutionContext(context)).toBe(false);
  });

  it("allows exactly one winner under concurrent consumption", async () => {
    const context = contextFor(admit("run-concurrent"));
    const results = await Promise.all([
      Promise.resolve().then(() => consume(context)),
      Promise.resolve().then(() => consume(context)),
      Promise.resolve().then(() => consume(context)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ["owner", { pluginId: "other-plugin" }],
    ["tool", { toolName: "same_name_other_tool" }],
    ["call", { toolCallId: "other-call" }],
    ["params", { canonicalParams: Object.freeze({}) }],
  ] as const)("burns the context before a wrong %s binding check", (_label, override) => {
    const context = contextFor(admit(`run-wrong-${_label}`));

    expect(consume(context, override)).toBe(false);
    expect(consume(context)).toBe(false);
  });

  it("prebinds the protected plugin owner and tool", () => {
    const wrongOwnerAuthority = admit("run-wrong-owner-context");
    expect(contextFor(wrongOwnerAuthority, {}, { pluginId: "other-plugin" })).toBeUndefined();

    const wrongToolAuthority = admit("run-wrong-tool-context");
    expect(contextFor(wrongToolAuthority, {}, { toolName: "postman_lookup_copy" })).toBeUndefined();
  });

  it("requires exact provenance, run, session incarnation, and explicit route-none", () => {
    const provenanceAuthority = admit("run-provenance");
    expect(
      contextFor(
        provenanceAuthority,
        {},
        { inputProvenance: { ...provenanceAuthority.provenance } },
      ),
    ).toBeUndefined();

    const wrongRun = contextFor(admit("run-wrong-run"), {}, { runId: "other-run" });
    expect(consume(wrongRun)).toBe(false);

    const wrongSession = contextFor(admit("run-wrong-session"), {}, { sessionId: "rotated" });
    expect(consume(wrongSession)).toBe(false);

    const missingRoute = contextFor(
      admit("run-missing-route"),
      {},
      {
        admittedSessionDeliveryKind: undefined,
      },
    );
    expect(missingRoute).toBeDefined();
    expect(consume(missingRoute)).toBe(false);

    for (const route of ["internal", "external"] as const) {
      const context = contextFor(
        admit(`run-${route}-route`),
        {},
        {
          admittedSessionDeliveryKind: route,
        },
      );
      expect(consume(context)).toBe(false);
    }
  });

  it("rechecks lifecycle generation at handler entry and closes on mismatch", () => {
    const context = contextFor(admit("run-lifecycle-rotation"));
    rotateAgentEventLifecycleGeneration();

    expect(consume(context)).toBe(false);
    expect(consume(context)).toBe(false);
  });

  it("closes both invocation and admitted authority on every host close path", () => {
    const authority = admit("run-close");
    const context = contextFor(authority);

    closeHostPluginToolExecutionContext(context);

    expect(consume(context)).toBe(false);
    expect(contextFor(authority)).toBeUndefined();
  });
});
