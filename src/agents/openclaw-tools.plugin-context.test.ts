import { randomUUID } from "node:crypto";
/**
 * Regression coverage for plugin tool context and delivery metadata.
 * Verifies requester metadata, workspace selection, and delivery routing.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareTodoistTurn,
  mintTodoistTurn,
  revokeTodoistTurn,
  resolveTodoistTurn,
  withTodoistTurn,
  bindTodoistTurnAdmission,
  todoistTurn,
  type VerifiedTurn,
} from "../gateway/todoist-turn-approval.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "./admitted-run-context.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";

describe("openclaw plugin tool context", () => {
  it("forwards trusted requester sender identity", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        requesterSenderId: "trusted-sender",
      },
    });

    expect(result.context.requesterSenderId).toBe("trusted-sender");
  });

  it("forwards the trusted owner bit", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        senderIsOwner: true,
      },
    });

    expect(result.context.senderIsOwner).toBe(true);
  });

  it("forwards the trusted native conversation id", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        nativeChannelId: "oc_native_chat",
      },
    });

    expect(result.context.nativeChannelId).toBe("oc_native_chat");
  });

  it("defaults missing and unknown conversation-read origins to delegated", () => {
    const missing = resolveOpenClawPluginToolInputs({
      options: { config: {} as never },
    });
    const unknown = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        conversationReadOrigin: "forged" as never,
      },
    });

    expect(missing.context.conversationReadOrigin).toBe("delegated");
    expect(unknown.context.conversationReadOrigin).toBe("delegated");
  });

  it("preserves a server-owned direct-operator origin", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        conversationReadOrigin: "direct-operator",
      },
    });

    expect(result.context.conversationReadOrigin).toBe("direct-operator");
  });

  it("forwards fs policy for plugin tool sandbox enforcement", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        fsPolicy: { workspaceOnly: true },
      },
    });

    expect(result.context.fsPolicy).toStrictEqual({ workspaceOnly: true });
  });

  it("forwards ephemeral sessionId", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentSessionKey: "agent:main:telegram:direct:12345",
        sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    });

    expect(result.context.sessionKey).toBe("agent:main:telegram:direct:12345");
    expect(result.context.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("forwards trusted private conversation recall context", () => {
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:direct:owner",
      scope: "same-agent-private" as const,
      corpus: "sessions" as const,
    };
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        conversationRecall,
      },
    });

    expect(result.context.conversationRecall).toEqual(conversationRecall);
  });

  it("forwards host-prepared active project keys", () => {
    const activeProjectKeys = ["github.com/OpenClaw/OpenClaw"];
    const result = resolveOpenClawPluginToolInputs({
      options: { config: {} as never, activeProjectKeys },
    });

    expect(result.context.activeProjectKeys).toBe(activeProjectKeys);
  });

  it("forwards runtime-owned active model metadata", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        modelProvider: " local-provider ",
        modelId: " local-model ",
      },
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "local-provider",
      modelId: "local-model",
      modelRef: "local-provider/local-model",
    });
  });

  it("does not duplicate provider-qualified active model refs", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        modelProvider: "openrouter",
        modelId: "openrouter/auto",
      },
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRef: "openrouter/auto",
    });
  });

  it("infers the default agent workspace when workspaceDir is omitted", () => {
    const workspaceDir = path.join(process.cwd(), "tmp-main-workspace");
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {
          agents: {
            defaults: { workspace: workspaceDir },
            list: [{ id: "main", default: true }],
          },
        } as never,
        agentSessionKey: "main",
      },
      resolvedConfig: {
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", default: true }],
        },
      } as never,
    });

    expect(result.context.agentId).toBe("main");
    expect(result.context.workspaceDir).toBe(workspaceDir);
  });

  it("infers the session agent workspace when workspaceDir is omitted", () => {
    const supportWorkspace = path.join(process.cwd(), "tmp-support-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "support", workspace: supportWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "agent:support:main",
      },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("support");
    expect(result.context.workspaceDir).toBe(supportWorkspace);
  });

  it("uses requester agent override for synthetic embedded session keys", () => {
    const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "recall", workspace: recallWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "explicit:user-session:active-memory:abc123",
        requesterAgentIdOverride: "recall",
      },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("recall");
    expect(result.context.workspaceDir).toBe(recallWorkspace);
  });

  it("forwards browser session wiring", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        sandboxBrowserBridgeUrl: "http://127.0.0.1:9999",
        allowHostBrowserControl: true,
      },
    });

    expect(result.context.browser).toStrictEqual({
      sandboxBridgeUrl: "http://127.0.0.1:9999",
      allowHostControl: true,
    });
  });

  it("forwards gateway subagent binding", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        allowGatewaySubagentBinding: true,
      },
    });

    expect(result.allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards ambient deliveryContext", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentChannel: "slack",
        agentTo: "channel:C123",
        agentAccountId: "work",
        agentThreadId: "1710000000.000100",
      },
    });

    expect(result.context.deliveryContext).toStrictEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "1710000000.000100",
    });
  });

  it("uses the current conversation target when agentTo is unavailable", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentChannel: "discord",
        currentChannelId: "discord:channel:987654321",
        agentAccountId: "molty",
      },
    });

    expect(result.context.deliveryContext).toStrictEqual({
      channel: "discord",
      to: "discord:channel:987654321",
      accountId: "molty",
    });
  });

  it("keeps an explicit agent target ahead of the current conversation target", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentChannel: "discord",
        agentTo: "channel:111",
        currentMessagingTarget: "channel:222",
        currentChannelId: "333",
      },
    });

    expect(result.context.deliveryContext?.to).toBe("channel:111");
  });

  it("keeps the routable conversation target ahead of the native channel id", () => {
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config: {} as never,
        agentChannel: "slack",
        currentMessagingTarget: "user:U123",
        currentChannelId: "D123",
      },
    });

    expect(result.context.deliveryContext?.to).toBe("user:U123");
  });
});

describe("Todoist owner turn capability", () => {
  const turn: VerifiedTurn = {
    agentId: "clawy",
    sessionId: "session",
    sessionKey: "agent:clawy:telegram:direct:123",
    runId: "run",
    messageId: "message",
    senderId: "123",
    channel: "telegram",
    account: "clawdy",
    target: "telegram:123",
    senderIsOwner: true,
  };
  const evidence = {
    turn,
    ownerAllowFrom: ["123"],
    commandBody: "hello",
    commandAuthorized: true,
    chatType: "direct",
  };
  async function runOwner(
    fn: (token: string, verified: VerifiedTurn, close: () => void) => Promise<void> | void,
  ) {
    const token = randomUUID();
    const currentTurn = { ...turn, runId: randomUUID() };
    const verified = prepareTodoistTurn({ ...evidence, turn: currentTurn })!;
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(currentTurn.runId),
      facts: {
        runId: currentTurn.runId,
        agentId: "clawy",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
    });
    mintTodoistTurn(token, verified);
    try {
      expect(withTodoistTurn(token, todoistTurn)).toBeUndefined();
      bindTodoistTurnAdmission(token, await admission.admit("embedded"));
      await withTodoistTurn(token, () => fn(token, verified, admission.close));
    } finally {
      revokeTodoistTurn(token);
      admission.close();
    }
  }

  it.each([
    { isHeartbeat: true },
    { oneShotCliRun: true },
    { lane: "cron" },
    { lane: "subagent" },
    { trustedInternalHandoff: true },
    { inputProvenance: { kind: "inter_session" as const } },
    { ingressProvenance: { kind: "internal_system" as const } },
    { inputProvenance: { kind: "external_user" as const, sourceTool: "todoist_query" } },
    { ownerAllowFrom: ["*"] },
    { ownerAllowFrom: ["456"] },
    { commandAuthorized: false },
    { commandBody: undefined },
    { chatType: "group" },
  ])("refuses ineligible ingress %j", (override) => {
    expect(prepareTodoistTurn({ ...evidence, ...override })).toBeUndefined();
  });

  it.each([
    { agentId: "other" },
    { senderIsOwner: false },
    { target: "telegram:456" },
    { channel: "slack" },
    { account: "other" },
    { messageId: "" },
    { sessionKey: "agent:clawy:cron:job" },
    { sessionKey: "agent:clawy:subagent:child" },
    { approvedProposalId: "forged" },
  ])("refuses ineligible coordinates %j", (override) => {
    expect(
      prepareTodoistTurn({ ...evidence, turn: { ...turn, ...override } as VerifiedTurn }),
    ).toBeUndefined();
  });

  it.each(["clawy", "turing", "cordy"])("accepts contracted agent %s", (agentId) => {
    expect(prepareTodoistTurn({ ...evidence, turn: { ...turn, agentId } })).toBeDefined();
  });

  it.each([
    ["approve p1", "p1"],
    ["/APPROVE p1", "p1"],
    ["please approve p1", undefined],
    ["approve p1 extra", undefined],
    ["approve p1\n", undefined],
    ["approve\tp1", undefined],
  ])("parses only raw approval syntax %j", (commandBody, expected) => {
    expect(prepareTodoistTurn({ ...evidence, commandBody })?.approvedProposalId).toBe(expected);
  });

  it("rejects forged mints, copied tokens, and all mismatched coordinates", async () => {
    expect(() => mintTodoistTurn("forged", turn)).toThrow();
    await runOwner(async (token, verified) => {
      expect(resolveTodoistTurn(token, verified)).toEqual(verified);
      for (const key of Object.keys(turn)) {
        expect(resolveTodoistTurn(token, { ...verified, [key]: "mismatch" })).toBeUndefined();
      }
      expect(
        resolveTodoistTurn(token, { ...verified, approvedProposalId: "forged" }),
      ).toBeUndefined();
      withTodoistTurn(undefined, () => expect(resolveTodoistTurn(token, verified)).toBeUndefined());
      expect(() => mintTodoistTurn(token, verified)).toThrow();
    });
  });

  it("rechecks retained plugin access after await and revocation", async () => {
    await runOwner(async (token, verified) => {
      const { context } = resolveOpenClawPluginToolInputs({
        options: {
          requesterAgentIdOverride: verified.agentId,
          runId: verified.runId,
          sessionId: verified.sessionId,
          agentSessionKey: verified.sessionKey,
          requesterSenderId: verified.senderId,
          senderIsOwner: true,
          agentChannel: verified.channel,
          agentAccountId: verified.account,
          agentTo: verified.target,
        },
      });
      expect(context.todoistTurn()).toEqual(verified);
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      let mutations = 0;
      const child = (async () => {
        await wait;
        if (context.todoistTurn()) {
          mutations++;
        }
      })();
      revokeTodoistTurn(token);
      release();
      await child;
      expect(mutations).toBe(0);
      expect(context.todoistTurn()).toBeUndefined();
    });
  });

  it("denies on run closure without waiting for capability cleanup", async () => {
    await runOwner(async (_token, verified, close) => {
      expect(todoistTurn()).toEqual(verified);
      close();
      await Promise.resolve();
      expect(todoistTurn()).toBeUndefined();
    });
  });

  it("never derives write authority from read-origin or message-action capability", () => {
    const { context } = resolveOpenClawPluginToolInputs({
      options: {
        conversationReadOrigin: "direct-operator",
        senderIsOwner: true,
        messageActionTurnCapability: "unrelated",
      },
    });
    expect(context.todoistTurn()).toBeUndefined();
    revokeTodoistTurn(undefined);
  });
});
