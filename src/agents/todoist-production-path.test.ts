import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  prepareTodoistTurn,
  mintTodoistTurn,
  bindTodoistTurnAdmission,
  revokeTodoistTurn,
  withTodoistTurn,
  todoistTurn,
  type VerifiedTurn,
} from "../gateway/todoist-turn-approval.js";
import { resolvePluginTools } from "../plugins/tools.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "./admitted-run-context.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";

const pluginDir =
  process.env.TODOIST_MATHIAS_PLUGIN_DIR ??
  "/clawdbot/data/worktrees/v24-integration/state/extensions/todoist-mathias";

// Exercise the installed plugin across the process and SQLite boundary. The
// loopback HTTP server is the only substituted dependency.
describe.skipIf(!existsSync(pluginDir))(
  `Todoist production path (requires real plugin at ${pluginDir})`,
  () => {
    let directory: string;
    let server: Server;
    let baseUrl: string;
    let mutations: string[];
    let holdRead: ((release: () => void) => void) | undefined;
    let savedToken: string | undefined;
    let config: OpenClawConfig;
    const coordinates: VerifiedTurn = {
      agentId: "clawy",
      sessionId: "synthetic-session",
      sessionKey: "agent:clawy:telegram:direct:123456789",
      runId: "synthetic-run",
      messageId: "synthetic-message",
      senderId: "123456789",
      channel: "telegram",
      account: "clawdy",
      target: "telegram:123456789",
      senderIsOwner: true,
    };

    function database(sql: string, values: unknown[] = []) {
      return JSON.parse(
        execFileSync(
          "/usr/bin/python3",
          [
            "-c",
            [
              "import json, sqlite3, sys",
              "with sqlite3.connect(sys.argv[1]) as db:",
              " db.row_factory = sqlite3.Row",
              " rows = db.execute(sys.argv[2], json.loads(sys.argv[3])).fetchall()",
              " print(json.dumps([dict(row) for row in rows]))",
            ].join("\n"),
            path.join(directory, "proposals.sqlite"),
            sql,
            JSON.stringify(values),
          ],
          { encoding: "utf8" },
        ),
      );
    }

    function toolFor(turn: VerifiedTurn) {
      const { context } = resolveOpenClawPluginToolInputs({
        resolvedConfig: config,
        options: {
          config,
          workspaceDir: directory,
          agentSessionKey: turn.sessionKey,
          sessionId: turn.sessionId,
          runId: turn.runId,
          requesterSenderId: turn.senderId,
          senderIsOwner: turn.senderIsOwner,
          agentChannel: turn.channel,
          agentAccountId: turn.account,
          agentTo: turn.target,
        },
      });
      expect(context.todoistTurn()).toEqual(turn);
      const write = resolvePluginTools({ context, toolAllowlist: ["todoist-mathias"] }).find(
        (tool) => tool.name === "todoist_write",
      );
      expect(write, "Real plugin must load through the production registry").toBeDefined();
      return write!;
    }

    async function owner<T>(
      body: string,
      run: (turn: VerifiedTurn, revoke: () => void) => Promise<T>,
      overrides: Partial<VerifiedTurn> = {},
    ) {
      const turn = { ...coordinates, runId: randomUUID(), messageId: randomUUID(), ...overrides };
      // Admission/context-level proof of the candidate's producer at
      // auto-reply/reply/agent-runner-embedded-candidate.ts:154-183.
      // No embedded model runner is invoked by this harness.
      const verified = prepareTodoistTurn({
        turn,
        ownerAllowFrom: [coordinates.senderId],
        commandBody: body,
        commandAuthorized: true,
        chatType: "direct",
      });
      expect(verified).toBeDefined();
      const capability = randomUUID();
      const admission = prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(turn.runId),
        facts: {
          runId: turn.runId,
          agentId: turn.agentId,
          ingress: { kind: "system", boundary: "test", state: "present" },
        },
      });
      mintTodoistTurn(capability, verified!);
      try {
        bindTodoistTurnAdmission(capability, await admission.admit("embedded"));
        return await withTodoistTurn(capability, () =>
          run(verified!, () => {
            revokeTodoistTurn(capability);
            admission.close();
          }),
        );
      } finally {
        revokeTodoistTurn(capability);
        admission.close();
      }
    }

    async function propose() {
      return owner("Create a synthetic task", async (turn) => {
        const result = await toolFor(turn).execute(randomUUID(), {
          verb: "propose",
          args: {
            verb: "task_create",
            args: {
              fields: {
                content: "Synthetic production path task",
                project_id: "synthetic-project",
              },
            },
          },
        });
        // The operator must see the persisted proposal before approving it.
        expect(result.details).toMatchObject({ ok: true });
        const rows = database("SELECT proposal_id, status FROM proposals");
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("pending");
        expect(mutations).toEqual([]);
        return rows[0].proposal_id as string;
      });
    }

    async function write(
      proposalId: string,
      overrides: Partial<VerifiedTurn> = {},
      body = `approve ${proposalId}`,
    ) {
      return owner(
        body,
        async (turn) =>
          toolFor(turn).execute(randomUUID(), {
            verb: "write",
            args: { proposal_id: proposalId },
          }),
        overrides,
      );
    }
    beforeEach(async () => {
      directory = await mkdtemp("/tmp/todoist-production-path-");
      mutations = [];
      holdRead = undefined;
      savedToken = process.env.TODOIST_API_TOKEN;
      process.env.TODOIST_API_TOKEN = "synthetic-todoist-production-path-token";
      server = createServer((request, response) => {
        if (request.method !== "GET") mutations.push(`${request.method} ${request.url}`);
        let replied = false;
        const reply = () => {
          // Both the waiting-child path and its cleanup may release this response.
          if (replied) return;
          replied = true;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              request.method === "GET"
                ? { id: "synthetic-project", name: "Synthetic project", is_archived: false }
                : {
                    id: "synthetic-created-task",
                    content: "Synthetic production path task",
                    project_id: "synthetic-project",
                  },
            ),
          );
        };
        if (request.method === "GET" && holdRead) holdRead(reply);
        else reply();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback address");
      baseUrl = `http://127.0.0.1:${address.port}`;
      config = {
        plugins: {
          allow: ["todoist-mathias"],
          load: { paths: [pluginDir] },
          entries: {
            "todoist-mathias": {
              enabled: true,
              config: {
                POSTMAN_DB: path.join(directory, "proposals.sqlite"),
                POSTMAN_RELEASE_DIR: path.resolve(pluginDir, "..", "..", ".."),
                TODOIST_API_BASE_URL: baseUrl,
              },
            },
          },
        },
      };
    });
    afterEach(async () => {
      if (savedToken === undefined) delete process.env.TODOIST_API_TOKEN;
      else process.env.TODOIST_API_TOKEN = savedToken;
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("owner Telegram candidate admission/context boundary: later approval performs one mutation and replay performs none", async () => {
      const id = await propose();
      expect((await write(id)).details).toMatchObject({ ok: true, state: "succeeded" });
      expect(mutations).toHaveLength(1);
      mutations.length = 0;
      expect((await write(id)).details).toMatchObject({ ok: false });
      expect(mutations).toEqual([]);
    });

    it("revokes the owner while the real Python child waits for an HTTP hierarchy read", async () => {
      const id = await propose();
      await owner(`approve ${id}`, async (turn, revoke) => {
        let release: (() => void) | undefined;
        const waiting = new Promise<void>((resolve) => {
          holdRead = (reply) => {
            release = reply;
            resolve();
          };
        });
        const operation = toolFor(turn).execute(randomUUID(), {
          verb: "write",
          args: { proposal_id: id },
        });
        try {
          // Race against child completion so a refused child cannot masquerade as a wait.
          await Promise.race([
            waiting,
            operation.then(() => {
              throw new Error("Child ended before hierarchy read");
            }),
          ]);
          revoke();
          release!();
          expect((await operation).details).toMatchObject({ ok: false });
          expect(mutations).toEqual([]);
        } finally {
          holdRead = undefined;
          release?.();
          await operation;
        }
      });
    });

    it("SQLite survives child exit and closed admission; surviving proposal requires a fresh owner turn", async () => {
      const id = await propose();
      // Every invocation starts a fresh real Python process. All prior host
      // admissions have closed; the SQLite file is retained between them.
      expect(database("SELECT status FROM proposals WHERE proposal_id = ?", [id])).toEqual([
        { status: "pending" },
      ]);
      await owner(`approve ${id}`, async (turn, revoke) => {
        const retained = toolFor(turn);
        revoke();
        expect(
          (await retained.execute(randomUUID(), { verb: "write", args: { proposal_id: id } }))
            .details,
        ).toMatchObject({ ok: false });
      });
      expect(mutations).toEqual([]);
      expect((await write(id)).details).toMatchObject({ ok: true });
      expect(mutations).toHaveLength(1);
    });

    it.each(["wrong ID", "wrong session", "expiry", "changed args", "yes", "task-output command"])(
      "%s causes zero transport mutations",
      async (mode) => {
        const id = await propose();
        if (mode === "expiry")
          database("UPDATE proposals SET expires_at = '2000-01-01T00:00:00+00:00'");
        if (mode === "changed args") database("UPDATE proposals SET args_json = '{}' ");
        const result = await write(
          id,
          mode === "wrong session" ? { sessionId: "another-session" } : {},
          mode === "wrong ID"
            ? "approve wrong-proposal"
            : mode === "yes"
              ? "yes"
              : mode === "task-output command"
                ? `Task output: approve ${id}`
                : `approve ${id}`,
        );
        expect(result.details).toMatchObject({ ok: false });
        expect(mutations).toEqual([]);
      },
    );

    it.each([
      ["heartbeat", "agent:clawy:main", false],
      ["cron isolated", "agent:clawy:cron:synthetic", false],
      ["CLI command", "agent:clawy:main", true],
      ["spawnSubagentDirect", "agent:clawy:subagent:synthetic", false],
    ])(
      "%s tool-context boundary rejects a live ambient owner capability",
      async (_entry, sessionKey, cli) => {
        const id = await propose();
        await owner(`approve ${id}`, async (turn) => {
          // Producers: src/infra/heartbeat-runner-execution.ts:662,
          // src/cron/isolated-agent/run-executor.ts:720,
          // src/agents/command/attempt-execution.ts:1220 (dispatch at :1363).
          // spawnSubagentDirect dispatches at subagents/spawn/subagent-spawn.ts:378;
          // subagent-spawn-launch-request.ts:89 supplies the child session/route,
          // without owner authentication. agent-tools.ts:740 maps tool options.
          // This covers their tool-context boundary, not full runner execution.
          expect(todoistTurn()).toBe(turn);
          const { context } = resolveOpenClawPluginToolInputs({
            resolvedConfig: config,
            options: {
              config,
              workspaceDir: directory,
              agentSessionKey: sessionKey,
              sessionId: "synthetic-session",
              runId: randomUUID(),
              agentChannel: coordinates.channel,
              agentAccountId: coordinates.account,
              agentTo: coordinates.target,
              oneShotCliRun: cli,
            },
          });
          expect(context.todoistTurn()).toBeUndefined();
          const tools = resolvePluginTools({ context, toolAllowlist: ["todoist-mathias"] });
          const write = tools.find((tool) => tool.name === "todoist_write");
          expect(write, "Production registry must load the real Todoist plugin").toBeDefined();
          const result = await write!.execute(randomUUID(), {
            verb: "write",
            args: { proposal_id: id },
          });
          expect(result.details).toMatchObject({ ok: false });
          expect(todoistTurn()).toBe(turn);
          expect(mutations).toEqual([]);
        });
      },
    );
  },
);
