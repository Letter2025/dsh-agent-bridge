import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DshWebClient,
  loadWebWorkflowState,
  normalizeDshWebUrl,
  prepareWebWorktree,
  runWebTurn,
  runWebWorktreeCommand,
  type DshPromptResponse,
  type DshSessionEvent,
  type DshSessionHistory,
  type DshWebClientLike,
} from "@dsh-agent-bridge/core";
import { parseWebArgs } from "../packages/cli/src/dsh-web";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-web-bridge-test-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "core.eol", "lf"]);
  git(root, ["config", "user.name", "DSH Web Test"]);
  git(root, ["config", "user.email", "dsh-web-test@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), ".dsh-worktrees/\n");
  git(root, ["add", "tracked.txt", ".gitignore"]);
  git(root, ["commit", "-m", "baseline"]);
  return root;
}

class FakeDshWebClient implements DshWebClientLike {
  readonly sessions = new Map<string, string>();
  readonly events = new Map<string, DshSessionEvent[]>();
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  readonly commands: Array<{ sessionId: string; line: string }> = [];

  async describe(): Promise<Record<string, unknown>> {
    return { version: "test" };
  }

  async createSession(
    cwd: string,
    sessionId = `session-${this.sessions.size}`,
  ): Promise<{ sessionId: string }> {
    this.sessions.set(sessionId, cwd);
    this.events.set(sessionId, this.events.get(sessionId) ?? []);
    return { sessionId };
  }

  async history(sessionId: string): Promise<DshSessionHistory> {
    return {
      events: (this.events.get(sessionId) ?? []).map((event) => ({ event })),
      hasMore: false,
    };
  }

  async prompt(sessionId: string, text: string): Promise<DshPromptResponse> {
    this.prompts.push({ sessionId, text });
    const cwd = this.sessions.get(sessionId);
    if (cwd === undefined) throw new Error("unknown fake session");
    const existing = this.events.get(sessionId) ?? [];
    const start = existing.length === 0 ? 0 : Math.max(...existing.map((event) => event.seq)) + 1;
    const turn = Math.floor(start / 4) + 1;
    existing.push(
      { type: "turn/start", seq: start, time: Date.now(), data: { turn } },
      {
        type: "user/message",
        seq: start + 1,
        time: Date.now(),
        data: { role: "user", content: [{ type: "text", text }] },
      },
      {
        type: "assistant/message",
        seq: start + 2,
        time: Date.now(),
        data: {
          turn,
          step: 1,
          message: { role: "assistant", content: [{ type: "text", text: `completed-${turn}` }] },
        },
      },
      {
        type: "turn/end",
        seq: start + 3,
        time: Date.now(),
        data: { turn, reason: { kind: "completed" } },
      },
    );
    this.events.set(sessionId, existing);
    return { accepted: true };
  }

  async command(sessionId: string, line: string): Promise<{ matched: boolean; text?: string }> {
    this.commands.push({ sessionId, line });
    const cwd = this.sessions.get(sessionId);
    if (cwd === undefined) throw new Error("unknown fake session");
    if (line.startsWith("/worktree create ")) {
      const name = line.slice("/worktree create ".length);
      const worktreePath = join(cwd, ".dsh-worktrees", "worktree", ...name.split("/"));
      git(cwd, ["worktree", "add", "-b", name, worktreePath, "HEAD"]);
      return {
        matched: true,
        text: `Created task worktree "${name}".\n  path: ${worktreePath}\n  branch: ${name}`,
      };
    }
    if (line.startsWith("/worktree status ")) {
      return { matched: true, text: "worktree status: prepared" };
    }
    if (line.startsWith("/worktree bring-back ")) {
      return { matched: true, text: "Brought back worktree." };
    }
    if (line.startsWith("/worktree remove ")) {
      return { matched: true, text: "Removed worktree." };
    }
    return { matched: false };
  }

  async cancel(): Promise<void> {}
}

describe("DSH Web API client", () => {
  it("accepts only loopback HTTP origins", () => {
    expect(normalizeDshWebUrl("http://127.0.0.1:3080")).toBe("http://127.0.0.1:3080");
    expect(normalizeDshWebUrl("http://localhost:3080/")).toBe("http://localhost:3080");
    expect(() => normalizeDshWebUrl("https://127.0.0.1:3080")).toThrow(/http/);
    expect(() => normalizeDshWebUrl("http://192.168.1.20:3080")).toThrow(/loopback|127/);
    expect(() => normalizeDshWebUrl("http://user:secret@127.0.0.1:3080")).toThrow(/credentials/);
  });

  it("uses the DSH RPC envelope and validates response identity", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchApi = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init: init ?? {} });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: request.rpcId,
          result: { ok: true, value: { version: "0.0.1" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new DshWebClient("http://127.0.0.1:3080", {
      fetchApi,
      mintRpcId: () => "fixed",
    });

    await expect(client.describe()).resolves.toEqual({ version: "0.0.1" });
    expect(calls[0]?.input).toBe("http://127.0.0.1:3080/api/host.describe");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      type: "client-request",
      rpcId: "codex-bridge-fixed",
      method: "host.describe",
      payload: {},
    });
  });

  it("preserves DSH RPC error codes", async () => {
    const fetchApi = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: { code: "unknown-command", message: "missing plugin", details: {} },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new DshWebClient("http://127.0.0.1:3080", { fetchApi });
    await expect(client.prompt("session", "/worktree list")).rejects.toMatchObject({
      code: "unknown-command",
      message: "missing plugin",
    });
  });
});

describe("DSH Web worktree workflow", () => {
  it("requires the plugin directory to be committed in .gitignore", async () => {
    const root = await createRepository();
    await writeFile(join(root, ".gitignore"), "");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "remove ignore rule"]);
    await expect(
      prepareWebWorktree(
        { cwd: root, name: "codex/missing-ignore" },
        { client: new FakeDshWebClient() },
      ),
    ).rejects.toMatchObject({ code: "worktree_ignore_missing" });
  });

  it("refuses a dirty source because plugin worktrees start from committed HEAD", async () => {
    const root = await createRepository();
    await writeFile(join(root, "tracked.txt"), "dirty\n");
    await expect(
      prepareWebWorktree({ cwd: root, name: "codex/dirty" }, { client: new FakeDshWebClient() }),
    ).rejects.toMatchObject({ code: "source_dirty" });
  });

  it("orders DSH to create the plugin worktree and opens a persistent worker session", async () => {
    const root = await createRepository();
    const client = new FakeDshWebClient();
    let nextId = 0;
    const state = await prepareWebWorktree(
      { cwd: root, name: "codex/feature", webUrl: "http://127.0.0.1:3080" },
      { client, mintId: () => String(++nextId), now: () => 1_700_000_000_000 },
    );

    expect(state).toMatchObject({
      phase: "prepared",
      worktreeName: "codex/feature",
      branch: "codex/feature",
      controllerSessionId: "codex-bridge-controller-1",
      workerSessionId: "codex-bridge-worker-2",
      promptCount: 0,
    });
    expect(client.commands[0]).toEqual({
      sessionId: state.controllerSessionId,
      line: "/worktree create codex/feature",
    });
    expect(client.sessions.get(state.workerSessionId)).toBe(state.workerCwd);
    expect(git(root, ["worktree", "list", "--porcelain"])).toContain(
      state.worktreePath.replaceAll("\\", "/"),
    );
    expect(await loadWebWorkflowState(state.statePath)).toEqual(state);
  });

  it("reuses the same DSH worker session for implementation and correction", async () => {
    const root = await createRepository();
    const client = new FakeDshWebClient();
    let nextId = 0;
    const state = await prepareWebWorktree(
      { cwd: root, name: "codex/session" },
      { client, mintId: () => String(++nextId) },
    );
    const instantSleep = async () => undefined;

    const first = await runWebTurn(
      { statePath: state.statePath, prompt: "implement the task", pollIntervalMs: 100 },
      { client, sleep: instantSleep },
    );
    const second = await runWebTurn(
      { statePath: state.statePath, prompt: "fix the review issue", pollIntervalMs: 100 },
      { client, sleep: instantSleep },
    );

    expect(first).toMatchObject({
      status: "succeeded",
      sessionId: state.workerSessionId,
      text: "completed-1",
    });
    expect(second).toMatchObject({
      status: "succeeded",
      sessionId: state.workerSessionId,
      text: "completed-2",
    });
    const codingPrompts = client.prompts;
    expect(codingPrompts).toHaveLength(2);
    expect(new Set(codingPrompts.map((entry) => entry.sessionId))).toEqual(
      new Set([state.workerSessionId]),
    );
    expect(codingPrompts[0]?.text).toContain("Fixed Safety Policy");
    expect((await loadWebWorkflowState(state.statePath)).promptCount).toBe(2);
  });

  it("routes status and approved bring-back through the DSH controller session", async () => {
    const root = await createRepository();
    const client = new FakeDshWebClient();
    let nextId = 0;
    const state = await prepareWebWorktree(
      { cwd: root, name: "codex/bring-back" },
      { client, mintId: () => String(++nextId) },
    );

    await runWebWorktreeCommand(state.statePath, "status", {}, { client });
    await runWebWorktreeCommand(state.statePath, "bring-back", {}, { client });

    expect(client.commands.at(-2)).toEqual({
      sessionId: state.controllerSessionId,
      line: "/worktree status codex/bring-back",
    });
    expect(client.commands.at(-1)).toEqual({
      sessionId: state.controllerSessionId,
      line: "/worktree bring-back codex/bring-back",
    });
    expect((await loadWebWorkflowState(state.statePath)).phase).toBe("brought_back");
  });

  it.runIf(process.env.DSH_WEB_E2E === "1")(
    "creates and removes a real plugin worktree through DSH Web",
    async () => {
      const root = await createRepository();
      const name = `codex/e2e-${process.pid}-${Date.now()}`;
      const state = await prepareWebWorktree({ cwd: root, name });

      expect(state.workerSessionId).not.toBe(state.controllerSessionId);
      expect(git(root, ["worktree", "list", "--porcelain"])).toContain(name);
      await expect(runWebWorktreeCommand(state.statePath, "status")).resolves.toMatchObject({
        command: `/worktree status ${name}`,
      });
      await expect(runWebWorktreeCommand(state.statePath, "remove")).resolves.toMatchObject({
        command: `/worktree remove ${name}`,
      });
      expect((await loadWebWorkflowState(state.statePath)).phase).toBe("removed");
    },
  );
});

describe("DSH Web CLI arguments", () => {
  it("keeps prepare, run, and destructive commands narrowly scoped", () => {
    const repoPath = resolve("repo");
    const statePath = resolve("state.json");
    const promptPath = resolve("brief.md");
    expect(parseWebArgs(["prepare", "--cwd", repoPath, "--name", "codex/task"])).toMatchObject({
      command: "prepare",
      cwd: repoPath,
      name: "codex/task",
    });
    expect(parseWebArgs(["run", "--state", statePath, "--prompt-file", promptPath])).toMatchObject({
      command: "run",
      promptFile: promptPath,
    });
    expect(() => parseWebArgs(["bring-back", "--state", "relative.json"])).toThrow(/absolute/);
    expect(() => parseWebArgs(["status", "--state", statePath, "--force"])).toThrow(
      /only for remove/,
    );
  });
});
