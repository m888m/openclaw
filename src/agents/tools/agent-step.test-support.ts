import type { callGateway } from "../../gateway/call.js";
import type { dispatchAgentHandoffInProcess } from "../../gateway/internal-agent-handoff.js";
import "./agent-step.js";

type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;
type AgentStepTesting = {
  setDepsForTest(
    overrides?: Partial<{
      agentCommandFromIngress: AgentCommandRunner;
      callGateway: typeof callGateway;
      dispatchAgentHandoff: typeof dispatchAgentHandoffInProcess;
    }>,
  ): void;
};
type AgentStepTestApi = {
  testing: AgentStepTesting;
};

function getTestApi(): AgentStepTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentStepTestApi")
  ] as AgentStepTestApi;
}

export const testing = getTestApi().testing;
