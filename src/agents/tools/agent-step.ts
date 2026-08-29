/**
 * Nested agent-step executor.
 *
 * Sends annotated inter-session messages through in-process or Gateway execution and reads the assistant reply.
 */
import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { dispatchAgentHandoffInProcess } from "../../gateway/internal-agent-handoff.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { retireSessionMcpRuntimeForSessionKey } from "../agent-bundle-mcp-tools.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunAndReadUpdatedAssistantReply } from "../run-wait.js";
import { loadSessionEntryByKey } from "../subagent-announce-delivery.js";

type GatewayCaller = typeof callGateway;
type AgentHandoffDispatcher = typeof dispatchAgentHandoffInProcess;
type TestAgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;

const defaultAgentStepDeps = {
  dispatchAgentHandoff: dispatchAgentHandoffInProcess,
  callGateway,
  agentCommandFromIngress: undefined as TestAgentCommandRunner | undefined,
};

let agentStepDeps: {
  dispatchAgentHandoff: AgentHandoffDispatcher;
  callGateway: GatewayCaller;
  /** Test-only compatibility seam; production defaults to the dispatcher above. */
  agentCommandFromIngress?: TestAgentCommandRunner;
} = defaultAgentStepDeps;

function extractAgentCommandReply(result: unknown): string | undefined {
  const candidate = result as { meta?: { error?: unknown }; payloads?: unknown } | null | undefined;
  const error =
    candidate?.meta?.error &&
    typeof candidate.meta.error === "object" &&
    !Array.isArray(candidate.meta.error)
      ? (candidate.meta.error as { kind?: unknown; terminalPresentation?: unknown })
      : undefined;
  if (error?.kind === "incomplete_turn" && error.terminalPresentation !== true) {
    return undefined;
  }
  const payloads = candidate?.payloads;
  if (!Array.isArray(payloads)) {
    return undefined;
  }
  const texts = payloads
    .map((payload) =>
      payload &&
      typeof payload === "object" &&
      typeof (payload as { text?: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "",
    )
    .filter((text) => text.trim().length > 0);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/** Sends one annotated message to a target session and returns the resulting assistant text. */
export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  transcriptMessage?: string;
  /** Host-derived source identity; protected handoffs never infer this from the target. */
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceChannel?: string;
  sourceTool?: string;
}): Promise<string | undefined> {
  const stepIdem = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool ?? "sessions_send",
  };
  // Mark inter-session prompts so downstream transcripts can distinguish tool-routed text.
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  const lane = params.lane ?? resolveNestedAgentLaneForSession(params.sessionKey);
  const channel = params.channel ?? INTERNAL_MESSAGE_CHANNEL;
  if (params.transcriptMessage !== undefined && agentStepDeps.agentCommandFromIngress) {
    // Kept only for unit-test doubles that explicitly install the legacy
    // callback. Production never populates this field and always uses the
    // capability-bearing dispatcher below.
    const result = await agentStepDeps.agentCommandFromIngress({
      message,
      transcriptMessage: params.transcriptMessage,
      sessionKey: params.sessionKey,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      runId: stepIdem,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance,
      allowModelOverride: false,
    });
    await retireSessionMcpRuntimeForSessionKey({
      sessionKey: params.sessionKey,
      reason: "nested-agent-step-complete",
    });
    return extractAgentCommandReply(result);
  }
  // All A2A branches, including transcript bookkeeping turns, use the same
  // host dispatcher. `transcriptMessage` remains part of the caller contract
  // for compatibility, but is intentionally not accepted as Gateway authority.
  const targetSessionId = loadSessionEntryByKey(params.sessionKey)?.sessionId?.trim();
  const currentSourceSessionId = loadSessionEntryByKey(params.sourceSessionKey)?.sessionId?.trim();
  if (!currentSourceSessionId || currentSourceSessionId !== params.sourceSessionId.trim()) {
    throw new Error("Host-derived source session incarnation is unavailable or changed");
  }
  if (!targetSessionId) {
    throw new Error("Host-derived target session identity is required");
  }
  const response = await agentStepDeps.dispatchAgentHandoff<{ runId: string }>({
    sourceSessionKey: params.sourceSessionKey,
    sourceSessionId: currentSourceSessionId,
    sourceChannel: params.sourceChannel,
    targetSessionKey: params.sessionKey,
    targetSessionId,
    requestId: stepIdem,
    request: {
      message,
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      extraSystemPrompt: params.extraSystemPrompt,
    },
    timeoutMs: 10_000,
  });

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  // Gateway agent calls can return before the assistant reply is persisted.
  const result = await waitForAgentRunAndReadUpdatedAssistantReply({
    runId: resolvedRunId,
    sessionKey: params.sessionKey,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
  });
  if (result.status === "ok" || result.status === "error") {
    await retireSessionMcpRuntimeForSessionKey({
      sessionKey: params.sessionKey,
      reason: "nested-agent-step-complete",
    });
  }
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}

/** Test-only dependency overrides for gateway and in-process command execution. */
const testing = {
  setDepsForTest(
    overrides?: Partial<{
      agentCommandFromIngress: TestAgentCommandRunner;
      callGateway: GatewayCaller;
      dispatchAgentHandoff: AgentHandoffDispatcher;
    }>,
  ) {
    agentStepDeps = overrides
      ? {
          ...defaultAgentStepDeps,
          ...overrides,
        }
      : defaultAgentStepDeps;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.agentStepTestApi")] = {
    testing,
  };
}
