import { beforeEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { issueInternalAgentHandoffCapability } from "../internal-agent-handoff.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";

function runPreflight(
  swarmOutputSchema?: Record<string, unknown>,
  swarmCollector = true,
  options?: {
    enabled?: boolean;
    requesterOnlyEnabled?: boolean;
    backend?: boolean;
    register?: boolean;
    requesterAgentId?: string;
    requesterSessionKey?: string;
    idempotencyKey?: string;
    includeCollectorFields?: boolean;
    launchPending?: boolean;
    cached?: boolean;
    completed?: boolean;
    ended?: boolean;
    inputProvenance?: Record<string, unknown>;
  },
) {
  const sessionKey = "agent:worker:subagent:collector";
  if (options?.register) {
    subagentRuns.set("collector-run", {
      runId: "collector-run",
      childSessionKey: sessionKey,
      requesterSessionKey: options.requesterSessionKey ?? "agent:main:main",
      requesterDisplayKey: "main",
      requesterAgentId: options.requesterAgentId,
      task: "collect",
      cleanup: "keep",
      createdAt: 1,
      collect: true,
      outputSchema: swarmOutputSchema,
      swarmLaunchIdempotencyKey: "collector-run",
      swarmLaunchPending: options?.launchPending ?? true,
      execution: { status: options?.launchPending === false ? "running" : "queued" },
      collectorCompletion: options?.completed ? { status: "done" } : undefined,
      endedAt: options?.ended ? 2 : undefined,
    });
  }
  const respond = vi.fn();
  const result = prepareAgentRequestPreflight({
    params: {
      message: "collect",
      sessionKey,
      idempotencyKey: options?.idempotencyKey ?? "collector-run",
      lane: "subagent",
      ...(options?.inputProvenance ? { inputProvenance: options.inputProvenance } : {}),
      ...(options?.includeCollectorFields === false ? {} : { swarmCollector, swarmOutputSchema }),
    },
    respond,
    context: {
      getRuntimeConfig: () =>
        options?.requesterOnlyEnabled
          ? {
              agents: {
                list: [{ id: "main", tools: { swarm: true } }, { id: "worker" }],
              },
            }
          : options?.enabled
            ? { tools: { swarm: true } }
            : {},
      dedupe: options?.cached
        ? new Map([
            [
              "agent:collector-run",
              {
                ts: 1,
                ok: true,
                payload: { status: "accepted", runId: "gateway-run", sessionKey },
              },
            ],
          ])
        : new Map(),
    },
    client: options?.backend
      ? {
          connect: { client: { mode: "backend" }, scopes: ["operator.write"] },
          internal: { syntheticClient: true },
        }
      : undefined,
  } as never);
  return { respond, result };
}

describe("agent request Swarm preflight", () => {
  beforeEach(() => {
    subagentRuns.clear();
    vi.spyOn(sessionAccessor, "loadSessionEntry").mockReturnValue(undefined);
  });

  it("rejects malformed and non-object structured output schemas", () => {
    for (const schema of [
      { type: "array", items: { type: "string" } },
      { type: "object", properties: "invalid" },
    ]) {
      const { respond, result } = runPreflight(schema);
      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });

  it("rejects a structured schema outside collector mode", () => {
    const { respond, result } = runPreflight({ type: "object" }, false);
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "active swarm collector sessions require swarmCollector=true",
      }),
    );
  });

  it("rejects collector flags while Swarm is disabled", () => {
    const { respond, result } = runPreflight(undefined, true, {
      backend: true,
      register: true,
    });

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "swarm collector fields require an enabled, host-registered collector run",
      }),
    );
  });

  it("rejects unregistered or non-backend collector requests", () => {
    const schema = { type: "object" };
    for (const options of [
      { enabled: true, backend: true, register: false },
      { enabled: true, backend: false, register: true },
    ]) {
      const { respond, result } = runPreflight(schema, true, options);
      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      subagentRuns.clear();
    }
  });

  it("accepts an enabled backend request for a registered collector", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects ordinary turns and mismatched launch identities for an active collector", () => {
    for (const options of [
      { includeCollectorFields: false },
      { idempotencyKey: "different-launch" },
    ]) {
      const { respond, result } = runPreflight({ type: "object" }, true, {
        enabled: true,
        backend: true,
        register: true,
        ...options,
      });

      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      subagentRuns.clear();
    }
  });

  it("keeps a retained collector session reserved from its persisted marker", () => {
    vi.mocked(sessionAccessor.loadSessionEntry).mockReturnValue({
      sessionId: "collector-session",
      updatedAt: 1,
      swarmCollector: true,
    });
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      includeCollectorFields: false,
    });
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps a provisionally ended collector session reserved until completion", () => {
    const run = subagentRuns.get("collector-run");
    expect(run).toBeUndefined();
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      includeCollectorFields: false,
    });
    const registered = subagentRuns.get("collector-run");
    if (!registered) {
      throw new Error("expected collector registration");
    }
    registered.endedAt = 2;

    const retry = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      includeCollectorFields: false,
    });
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalled();
    expect(retry.result).toBeUndefined();
    expect(retry.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("allows an accepted collector launch identity to replay only from Gateway dedupe", () => {
    const rejected = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      launchPending: false,
    });
    expect(rejected.result).toBeUndefined();
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    subagentRuns.clear();
    const replayed = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      launchPending: false,
      cached: true,
    });
    expect(replayed.result).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("allows an exact cached collector replay after Swarm is disabled", () => {
    const replayed = runPreflight({ type: "object" }, true, {
      backend: true,
      register: true,
      launchPending: false,
      cached: true,
    });
    expect(replayed.result).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("rejects a terminal collector even when its pending launch flag remains set", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      ended: true,
    });
    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps completed collector sessions closed while allowing their exact cached replay", () => {
    const ordinary = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      includeCollectorFields: false,
      launchPending: false,
      completed: true,
    });
    expect(ordinary.result).toBeUndefined();
    expect(ordinary.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    subagentRuns.clear();
    const replayed = runPreflight({ type: "object" }, true, {
      enabled: true,
      backend: true,
      register: true,
      launchPending: false,
      completed: true,
      cached: true,
    });
    expect(replayed.result).toBeUndefined();
    expect(replayed.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "gateway-run", status: "in_flight" }),
      undefined,
      expect.objectContaining({ cached: true, runId: "gateway-run" }),
    );
  });

  it("uses the registered requester per-agent gate for a cross-agent collector", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      requesterOnlyEnabled: true,
      backend: true,
      register: true,
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("uses the effective requester override when its session key names another agent", () => {
    const { respond, result } = runPreflight({ type: "object" }, true, {
      requesterOnlyEnabled: true,
      backend: true,
      register: true,
      requesterAgentId: "main",
      requesterSessionKey: "agent:cron:main",
    });

    expect(result).toBeDefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied provenance outside an authenticated backend handoff", () => {
    const { respond, result } = runPreflight(undefined, true, {
      includeCollectorFields: false,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:clawy:attacker-selected",
        sourceTool: "sessions_send",
      },
    });

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "inputProvenance is host-derived and cannot be supplied in agent params.",
      }),
    );
  });

  it("rejects provenance from a synthetic backend marker without a purpose capability", () => {
    const { respond, result } = runPreflight(undefined, true, {
      backend: true,
      includeCollectorFields: false,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:clawy:operator",
        sourceChannel: "internal",
        sourceTool: "sessions_send",
      },
    });

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "inputProvenance is host-derived and cannot be supplied in agent params.",
      }),
    );
  });

  it.each(["external_user", "internal_system"] as const)(
    "rejects caller-supplied %s provenance from a synthetic client",
    (kind) => {
      const { respond, result } = runPreflight(undefined, true, {
        backend: true,
        includeCollectorFields: false,
        inputProvenance: {
          kind,
          sourceTool: "caller-declared",
        },
      });

      expect(result).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );

  it("does not let a sessions_send capability grant broad internal controls", () => {
    const targetSessionKey = "agent:worker:subagent:target";
    const targetSessionId = "target-session-1";
    const idempotencyKey = "purpose-isolation";
    const capability = issueInternalAgentHandoffCapability({
      sourceSessionKey: "agent:clawy:operator",
      sourceSessionId: "source-session-1",
      targetSessionKey,
      targetSessionId,
      requestId: idempotencyKey,
    });
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: {
        message: "lookup",
        sessionKey: targetSessionKey,
        expectedExistingSessionId: targetSessionId,
        idempotencyKey,
        sessionEffects: "internal",
        suppressPromptPersistence: true,
      },
      respond,
      context: { getRuntimeConfig: () => ({}), dedupe: new Map() },
      client: {
        internal: {
          agentHandoffCapability: capability,
          agentHandoffSource: {
            sourceSessionKey: "agent:clawy:operator",
            sourceSessionId: "source-session-1",
          },
        },
      },
    } as never);

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each([
    { label: "caller-declared backend mode", client: { connect: { client: { mode: "backend" } } } },
    {
      label: "verified agent runtime identity",
      client: {
        connect: { client: { mode: "backend" } },
        internal: { agentRuntimeIdentity: { kind: "agentRuntime" } },
      },
    },
  ])("does not let $label authorize inter-session provenance", ({ client }) => {
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: {
        message: "lookup",
        idempotencyKey: "forged-provenance",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:clawy:forged",
          sourceTool: "sessions_send",
        },
      },
      respond,
      context: { getRuntimeConfig: () => ({}), dedupe: new Map() },
      client,
    } as never);

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("derives provenance only after consuming the private capability", () => {
    const targetSessionKey = "agent:worker:subagent:target";
    const targetSessionId = "target-session-1";
    const idempotencyKey = "admitted-handoff";
    const capability = issueInternalAgentHandoffCapability({
      sourceSessionKey: "agent:clawy:operator",
      sourceSessionId: "source-session-1",
      sourceChannel: "internal",
      targetSessionKey,
      targetSessionId,
      requestId: idempotencyKey,
    });
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: {
        message: "lookup",
        sessionKey: targetSessionKey,
        expectedExistingSessionId: targetSessionId,
        idempotencyKey,
      },
      respond,
      context: { getRuntimeConfig: () => ({}), dedupe: new Map() },
      client: {
        internal: {
          agentHandoffCapability: capability,
          agentHandoffSource: {
            sourceSessionKey: "agent:clawy:operator",
            sourceSessionId: "source-session-1",
          },
        },
      },
    } as never);

    expect(respond).not.toHaveBeenCalled();
    expect(result?.inputProvenance).toEqual({
      kind: "inter_session",
      sourceSessionKey: "agent:clawy:operator",
      sourceChannel: "internal",
      sourceTool: "sessions_send",
    });
    expect(result?.admittedInternalHandoff).toBeDefined();
    expect(Object.isFrozen(result?.inputProvenance)).toBe(true);
  });

  it("does not treat caller-declared backend mode as internal provenance authority", () => {
    const respond = vi.fn();
    const result = prepareAgentRequestPreflight({
      params: {
        message: "lookup",
        idempotencyKey: "forged-mode",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:clawy:forged",
          sourceTool: "sessions_send",
        },
      },
      respond,
      context: { getRuntimeConfig: () => ({}), dedupe: new Map() },
      client: {
        connect: { client: { mode: "backend" }, scopes: ["operator.write"] },
      },
    } as never);

    expect(result).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "inputProvenance is host-derived and cannot be supplied in agent params.",
      }),
    );
  });
});
