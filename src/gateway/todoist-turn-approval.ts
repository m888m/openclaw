import { AsyncLocalStorage } from "node:async_hooks";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";

export type VerifiedTurn = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  messageId: string;
  senderId: string;
  channel: string;
  account: string;
  target: string;
  senderIsOwner: true;
  approvedProposalId?: string;
}>;

type TurnOwner = {
  turn: VerifiedTurn;
  isLive?: () => void;
  signal?: AbortSignal;
};
const admitted = new WeakMap<VerifiedTurn, TurnOwner>();
const capabilities = new Map<string, TurnOwner>();
const current = new AsyncLocalStorage<{ capability: string; owner: TurnOwner } | undefined>();
const coordinates = [
  "agentId",
  "sessionId",
  "sessionKey",
  "runId",
  "messageId",
  "senderId",
  "channel",
  "account",
  "target",
  "senderIsOwner",
  "approvedProposalId",
] as const;

export function mintTodoistTurn(capability: string, hostTurn: VerifiedTurn): void {
  const owner = admitted.get(hostTurn);
  if (!capability || capabilities.has(capability) || !owner || owner.signal?.aborted) {
    throw new Error("Todoist turn requires live authenticated owner admission");
  }
  admitted.delete(hostTurn);
  capabilities.set(capability, owner);
}

function live(owner: TurnOwner): boolean {
  try {
    if (!owner.isLive || owner.signal?.aborted) {
      return false;
    }
    owner.isLive();
    return true;
  } catch {
    return false;
  }
}

export function revokeTodoistTurn(capability: string | undefined): void {
  if (capability !== undefined) {
    capabilities.delete(capability);
  }
}

export function resolveTodoistTurn(
  capability: string,
  expected: VerifiedTurn,
): VerifiedTurn | undefined {
  try {
    const owner = capabilities.get(capability);
    // A copied token is correlation only: the executing async scope must own it.
    if (
      !owner ||
      current.getStore()?.owner !== owner ||
      !live(owner) ||
      !coordinates.every((key) => owner.turn[key] === expected[key])
    ) {
      return undefined;
    }
    return owner.turn;
  } catch {
    return undefined;
  }
}

export function todoistTurn(): VerifiedTurn | undefined {
  const scope = current.getStore();
  return scope ? resolveTodoistTurn(scope.capability, scope.owner.turn) : undefined;
}

/** Host-only preparation; read results and tool arguments cannot mint these objects. */
export function prepareTodoistTurn(params: {
  turn: VerifiedTurn;
  ownerAllowFrom: readonly (string | number)[];
  commandBody?: string;
  commandAuthorized?: boolean;
  chatType?: string;
  isHeartbeat?: boolean;
  inputProvenance?: InputProvenance;
  ingressProvenance?: InputProvenance;
  trustedInternalHandoff?: unknown;
  lane?: string;
  oneShotCliRun?: boolean;
  signal?: AbortSignal;
}): VerifiedTurn | undefined {
  const turn = params.turn;
  const external = (value: InputProvenance | undefined) =>
    value === undefined ||
    (value.kind === "external_user" &&
      !value.sourceTool &&
      !value.sourceSessionKey &&
      !value.originSessionId);
  // These account/agent restrictions are the Postman host contract, not ambient read policy.
  if (
    !["clawy", "turing", "cordy"].includes(turn.agentId) ||
    turn.channel !== "telegram" ||
    turn.account !== "clawdy" ||
    turn.senderIsOwner !== true ||
    params.commandAuthorized !== true ||
    params.chatType !== "direct" ||
    params.isHeartbeat ||
    params.oneShotCliRun ||
    params.trustedInternalHandoff ||
    !external(params.inputProvenance) ||
    !external(params.ingressProvenance) ||
    params.signal?.aborted ||
    ["cron", "subagent"].includes(params.lane ?? "") ||
    /:(cron|subagent):/i.test(turn.sessionKey) ||
    typeof params.commandBody !== "string" ||
    coordinates.slice(0, 9).some((key) => typeof turn[key] !== "string" || !turn[key]) ||
    turn.approvedProposalId !== undefined
  ) {
    return undefined;
  }
  const ownerIds = params.ownerAllowFrom
    .map(String)
    .map((id) => id.replace(/^(telegram|tg):/i, ""));
  const target = turn.target.replace(/^(telegram|tg):/i, "");
  if (
    !/^\d+$/.test(turn.senderId) ||
    target !== turn.senderId ||
    !ownerIds.includes(turn.senderId)
  ) {
    return undefined;
  }
  // Approval syntax is authenticated here; proposal existence/expiry remain the proposal owner's check.
  const approvedProposalId = /^\/?approve ([^\s]+)$(?![\s\S])/i.exec(params.commandBody)?.[1];
  const verified = Object.freeze({
    ...turn,
    ...(approvedProposalId ? { approvedProposalId } : {}),
  });
  admitted.set(verified, { turn: verified, signal: params.signal });
  return verified;
}

/** Called by the existing runtime admission, never creates another run or claim. */
export function bindTodoistTurnAdmission(capability: string, context: AdmittedRunContext): void {
  const owner = capabilities.get(capability);
  if (!owner || owner.turn.runId !== context.operationalRunInstance.runId) {
    return;
  }
  owner.isLive ??= resolveAdmittedRunActiveAssertion(context, owner.signal);
}

export function withTodoistTurn<T>(capability: string | undefined, fn: () => T): T {
  const owner = capability ? capabilities.get(capability) : undefined;
  // An ineligible nested candidate clears inherited ambient authority.
  return current.run(owner && capability ? { capability, owner } : undefined, fn);
}
