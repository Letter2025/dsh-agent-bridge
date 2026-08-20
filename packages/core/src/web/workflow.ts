import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FIXED_SAFETY_POLICY } from "../runner/constants";
import { redactSecrets } from "../runner/output";
import { runGit } from "../worktree/git-client";
import { assertInside } from "../worktree/paths";
import { resolveRepository } from "../worktree/repository";
import { DshWebClient, normalizeDshWebUrl } from "./api-client";
import { DshWebError } from "./types";
import type {
  DshSessionEvent,
  DshWebClientLike,
  DshWebCommandResult,
  DshWebTurnResult,
  DshWebWorkflowState,
} from "./types";

const STATE_VERSION = 1;
const DEFAULT_WORKTREE_DIR_NAME = ".dsh-worktrees";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const MAX_STATE_BYTES = 64 * 1024;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validWorktreeName(name: string): boolean {
  if (name.length === 0 || name.length > 100 || name.includes("..") || name.includes("\\")) {
    return false;
  }
  if (name.startsWith("/") || name.endsWith("/")) return false;
  return name.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment));
}

function validateDirName(value: string): string {
  if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new DshWebError(
      "invalid_input",
      "worktreeDirName must be one hidden repository-relative directory name.",
    );
  }
  return value;
}

function stateFileFor(repoRoot: string, worktreeDirName: string, name: string): string {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 24);
  return join(repoRoot, worktreeDirName, "codex-bridge", `${digest}.json`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function persistState(state: DshWebWorkflowState): Promise<void> {
  const target = resolve(state.statePath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function requireStateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DshWebError("state_invalid", `Web workflow state has an invalid ${field}.`);
  }
  return value;
}

export async function loadWebWorkflowState(statePath: string): Promise<DshWebWorkflowState> {
  if (!isAbsolute(statePath)) {
    throw new DshWebError("invalid_input", "--state must be an absolute path.");
  }
  const pathInformation = await lstat(statePath).catch(() => null);
  if (pathInformation === null || !pathInformation.isFile() || pathInformation.isSymbolicLink()) {
    throw new DshWebError("state_invalid", "Web workflow state must be a regular file.");
  }
  if (pathInformation.size > MAX_STATE_BYTES) {
    throw new DshWebError("state_invalid", "Web workflow state exceeds its size limit.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    throw new DshWebError("state_invalid", "Web workflow state is not valid JSON.");
  }
  const value = objectRecord(decoded);
  if (value === null || value.version !== STATE_VERSION) {
    throw new DshWebError("state_invalid", "Web workflow state version is unsupported.");
  }
  const phase = value.phase;
  if (phase !== "prepared" && phase !== "brought_back" && phase !== "removed") {
    throw new DshWebError("state_invalid", "Web workflow state has an invalid phase.");
  }
  const promptCount = value.promptCount;
  const lastTurnSeq = value.lastTurnSeq;
  if (!Number.isSafeInteger(promptCount) || (lastTurnSeq !== null && !Number.isSafeInteger(lastTurnSeq))) {
    throw new DshWebError("state_invalid", "Web workflow state has invalid counters.");
  }
  const resolvedStatePath = await realpath(statePath);
  const recordedStatePath = requireStateString(value.statePath, "statePath");
  if (resolve(recordedStatePath) !== resolve(resolvedStatePath)) {
    throw new DshWebError("state_invalid", "Web workflow state path identity does not match.");
  }
  const state: DshWebWorkflowState = {
    version: 1,
    phase,
    statePath: resolvedStatePath,
    webUrl: normalizeDshWebUrl(requireStateString(value.webUrl, "webUrl")),
    repoRoot: requireStateString(value.repoRoot, "repoRoot"),
    hostCwd: requireStateString(value.hostCwd, "hostCwd"),
    worktreeDirName: validateDirName(requireStateString(value.worktreeDirName, "worktreeDirName")),
    worktreeName: requireStateString(value.worktreeName, "worktreeName"),
    worktreePath: requireStateString(value.worktreePath, "worktreePath"),
    workerCwd: requireStateString(value.workerCwd, "workerCwd"),
    branch: requireStateString(value.branch, "branch"),
    baseCommit: requireStateString(value.baseCommit, "baseCommit"),
    controllerSessionId: requireStateString(value.controllerSessionId, "controllerSessionId"),
    workerSessionId: requireStateString(value.workerSessionId, "workerSessionId"),
    promptCount: promptCount as number,
    lastTurnSeq: lastTurnSeq as number | null,
    createdAt: requireStateString(value.createdAt, "createdAt"),
  };
  if (!validWorktreeName(state.worktreeName)) {
    throw new DshWebError("state_invalid", "Web workflow state has an invalid worktree name.");
  }
  return state;
}

function parseWorktreeList(output: string): Array<{ path: string; branch?: string; head?: string }> {
  return output
    .trim()
    .split(/\r?\n\r?\n/u)
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const result: { path: string; branch?: string; head?: string } = { path: "" };
      for (const line of block.split(/\r?\n/u)) {
        if (line.startsWith("worktree ")) result.path = line.slice("worktree ".length);
        if (line.startsWith("branch refs/heads/")) result.branch = line.slice("branch refs/heads/".length);
        if (line.startsWith("HEAD ")) result.head = line.slice("HEAD ".length);
      }
      return result;
    })
    .filter((entry) => entry.path !== "");
}

async function requireWorktreeExists(state: DshWebWorkflowState): Promise<void> {
  if (state.phase === "removed") {
    throw new DshWebError("invalid_phase", "Web workflow worktree was already removed.");
  }
  const root = await realpath(state.worktreePath).catch(() => null);
  if (root === null || resolve(root) !== resolve(state.worktreePath)) {
    throw new DshWebError("worktree_missing", "Managed DSH worktree no longer exists.");
  }
  const actualRoot = (await runGit(root, ["rev-parse", "--show-toplevel"])).trim();
  if (resolve(actualRoot) !== resolve(root)) {
    throw new DshWebError("worktree_invalid", "Managed DSH worktree root does not match Git.");
  }
}

async function requirePreparedWorktree(state: DshWebWorkflowState): Promise<void> {
  if (state.phase !== "prepared") {
    throw new DshWebError("invalid_phase", `Web workflow is already ${state.phase}.`);
  }
  await requireWorktreeExists(state);
}

async function runSlashCommand(
  client: DshWebClientLike,
  sessionId: string,
  command: string,
  signal?: AbortSignal,
): Promise<DshWebCommandResult> {
  const response = await client.command(sessionId, command, signal);
  if (!response.matched || typeof response.text !== "string" || response.text.trim() === "") {
    throw new DshWebError(
      "command_result_missing",
      `DSH did not return a command result for ${command.split(/\s+/u)[0] ?? "command"}.`,
    );
  }
  return { command, text: response.text };
}

export interface PrepareWebWorktreeOptions {
  cwd: string;
  name: string;
  webUrl?: string;
  worktreeDirName?: string;
  statePath?: string;
  signal?: AbortSignal;
}

export interface WebWorkflowDependencies {
  client?: DshWebClientLike;
  mintId?: () => string;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export async function prepareWebWorktree(
  options: PrepareWebWorktreeOptions,
  dependencies: WebWorkflowDependencies = {},
): Promise<DshWebWorkflowState> {
  if (!validWorktreeName(options.name)) {
    throw new DshWebError(
      "invalid_input",
      "Worktree name must be a safe Git ref path made of letters, digits, dot, underscore, dash, and slash.",
    );
  }
  const webUrl = normalizeDshWebUrl(options.webUrl ?? process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080");
  const worktreeDirName = validateDirName(options.worktreeDirName ?? DEFAULT_WORKTREE_DIR_NAME);
  const repository = await resolveRepository(options.cwd);
  const repoRoot = await realpath(repository.sourceRoot);
  const hostCwd = await realpath(repository.sourceCwd);
  if (
    (await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length !==
    0
  ) {
    throw new DshWebError(
      "source_dirty",
      "DSH Web worktree preparation requires a clean source worktree so the plugin checkout matches the reviewed HEAD.",
    );
  }
  const namespaceRoot = resolve(repoRoot, worktreeDirName);
  const expectedWorktreePath = resolve(
    namespaceRoot,
    "worktree",
    ...options.name.split("/"),
  );
  assertInside(namespaceRoot, expectedWorktreePath);
  const statePath = resolve(options.statePath ?? stateFileFor(repoRoot, worktreeDirName, options.name));
  assertInside(namespaceRoot, statePath);
  if (await pathExists(statePath)) {
    throw new DshWebError("state_exists", `A bridge state already exists for ${options.name}.`);
  }

  const client = dependencies.client ?? new DshWebClient(webUrl);
  await client.describe(options.signal);
  const mintId = dependencies.mintId ?? randomUUID;
  const controllerSessionId = `codex-bridge-controller-${mintId()}`;
  const workerSessionId = `codex-bridge-worker-${mintId()}`;
  await client.createSession(repoRoot, controllerSessionId, options.signal);
  const commandResult = await runSlashCommand(
    client,
    controllerSessionId,
    `/worktree create ${options.name}`,
    options.signal,
  );
  if (!commandResult.text.includes("Created task worktree")) {
    throw new DshWebError(
      "worktree_create_failed",
      `DSH worktree command did not confirm creation: ${commandResult.text}`,
    );
  }

  const worktreePath = await realpath(expectedWorktreePath).catch(() => null);
  if (worktreePath === null) {
    throw new DshWebError(
      "worktree_create_failed",
      "DSH reported success but the expected dsh-task-worktree checkout does not exist.",
    );
  }
  assertInside(await realpath(namespaceRoot), worktreePath);
  const actualRoot = (await runGit(worktreePath, ["rev-parse", "--show-toplevel"])).trim();
  if (resolve(actualRoot) !== resolve(worktreePath)) {
    throw new DshWebError("worktree_invalid", "Created checkout is not a Git worktree root.");
  }
  const worktrees = parseWorktreeList(await runGit(repoRoot, ["worktree", "list", "--porcelain"]));
  const registered = worktrees.find((entry) => resolve(entry.path) === resolve(worktreePath));
  if (registered === undefined) {
    throw new DshWebError("worktree_invalid", "Created checkout is absent from git worktree list.");
  }
  const branch = (await runGit(worktreePath, ["branch", "--show-current"])).trim();
  const baseCommit = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
  if (branch !== options.name || registered.branch !== branch || baseCommit !== repository.baseCommit) {
    throw new DshWebError(
      "worktree_invalid",
      "Created checkout branch or base commit does not match the requested DSH worktree.",
    );
  }
  if ((await runGit(worktreePath, ["status", "--porcelain=v1", "-z"])).length !== 0) {
    throw new DshWebError("worktree_invalid", "New DSH worktree must start clean.");
  }
  const hostRelative = relative(repoRoot, hostCwd);
  const workerCwd = resolve(worktreePath, hostRelative);
  assertInside(worktreePath, workerCwd);
  const workerInformation = await stat(workerCwd).catch(() => null);
  if (workerInformation === null || !workerInformation.isDirectory()) {
    throw new DshWebError(
      "worktree_invalid",
      "The Codex host subdirectory does not exist in the created DSH worktree.",
    );
  }
  await client.createSession(workerCwd, workerSessionId, options.signal);

  const state: DshWebWorkflowState = {
    version: 1,
    phase: "prepared",
    statePath,
    webUrl,
    repoRoot,
    hostCwd,
    worktreeDirName,
    worktreeName: options.name,
    worktreePath,
    workerCwd,
    branch,
    baseCommit,
    controllerSessionId,
    workerSessionId,
    promptCount: 0,
    lastTurnSeq: null,
    createdAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
  };
  await persistState(state);
  return state;
}

function maxHistorySeq(events: DshSessionEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.seq), -1);
}

function assistantText(events: DshSessionEvent[], baselineSeq: number): string {
  const texts: string[] = [];
  for (const event of events) {
    if (event.seq <= baselineSeq || event.type !== "assistant/message") continue;
    const data = objectRecord(event.data);
    const message = objectRecord(data?.message);
    if (!Array.isArray(message?.content)) continue;
    const text = message.content
      .map((block) => objectRecord(block))
      .filter((block): block is Record<string, unknown> => block !== null)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text !== "") texts.push(text);
  }
  return texts.at(-1) ?? "";
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(new DshWebError("interrupted", "DSH Web workflow was interrupted."));
      return;
    }
    const timer = setTimeout(resolveSleep, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectSleep(new DshWebError("interrupted", "DSH Web workflow was interrupted."));
      },
      { once: true },
    );
  });
}

function composeDelegatedTask(prompt: string): string {
  return [
    "# DSH Delegated Coding Task",
    "",
    "## Fixed Safety Policy",
    "",
    FIXED_SAFETY_POLICY,
    "",
    "## Delegation Brief",
    "",
    prompt,
  ].join("\n");
}

export interface RunWebTurnOptions {
  statePath: string;
  prompt: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export async function runWebTurn(
  options: RunWebTurnOptions,
  dependencies: WebWorkflowDependencies = {},
): Promise<DshWebTurnResult> {
  const state = await loadWebWorkflowState(options.statePath);
  await requirePreparedWorktree(state);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new DshWebError("invalid_input", `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 10_000) {
    throw new DshWebError("invalid_input", "pollIntervalMs must be between 100 and 10000.");
  }
  const client = dependencies.client ?? new DshWebClient(state.webUrl);
  const priorHistory = await client.history(state.workerSessionId, 8, options.signal);
  const baselineSeq = Math.max(state.lastTurnSeq ?? -1, maxHistorySeq(priorHistory.events.map((entry) => entry.event)));
  const delegatedTask = composeDelegatedTask(options.prompt);
  const startedAt = dependencies.now?.() ?? Date.now();
  await client.prompt(state.workerSessionId, delegatedTask, options.signal);
  const sleep = dependencies.sleep ?? defaultSleep;

  while (true) {
    if (options.signal?.aborted) {
      throw new DshWebError("interrupted", "DSH Web workflow was interrupted.");
    }
    const now = dependencies.now?.() ?? Date.now();
    if (now - startedAt >= timeoutMs) {
      await client.cancel(state.workerSessionId, options.signal).catch(() => undefined);
      return {
        status: "timed_out",
        sessionId: state.workerSessionId,
        baselineSeq,
        turnEndSeq: null,
        durationMs: Math.max(0, now - startedAt),
        text: "",
        reason: null,
        error: { code: "timed_out", message: "DSH Web turn exceeded the configured timeout." },
      };
    }
    const history = await client.history(state.workerSessionId, 12, options.signal);
    const events = history.events.map((entry) => entry.event);
    const turnEnd = events
      .filter((event) => event.seq > baselineSeq && event.type === "turn/end")
      .sort((left, right) => right.seq - left.seq)[0];
    if (turnEnd !== undefined) {
      const reason = objectRecord(turnEnd.data)?.reason;
      const reasonRecord = objectRecord(reason) ?? { kind: "unknown" };
      const succeeded = reasonRecord.kind === "completed";
      state.promptCount += 1;
      state.lastTurnSeq = turnEnd.seq;
      await persistState(state);
      const rawText = assistantText(events, baselineSeq);
      const text = redactSecrets(rawText, options.prompt);
      const result: DshWebTurnResult = {
        status: succeeded ? "succeeded" : "failed",
        sessionId: state.workerSessionId,
        baselineSeq,
        turnEndSeq: turnEnd.seq,
        durationMs: Math.max(0, (dependencies.now?.() ?? Date.now()) - startedAt),
        text,
        reason: reasonRecord,
      };
      if (!succeeded) {
        result.error = {
          code: typeof reasonRecord.kind === "string" ? `turn_${reasonRecord.kind}` : "turn_failed",
          message: "DSH Web turn did not complete successfully.",
        };
      }
      return result;
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - (now - startedAt)), options.signal);
  }
}

export async function inspectWebWorktree(statePath: string): Promise<Record<string, unknown>> {
  const state = await loadWebWorkflowState(statePath);
  if (state.phase === "removed") return { state, exists: false };
  await requireWorktreeExists(state);
  return {
    state,
    exists: true,
    head: (await runGit(state.worktreePath, ["rev-parse", "HEAD"])).trim(),
    branch: (await runGit(state.worktreePath, ["branch", "--show-current"])).trim(),
    status: await runGit(state.worktreePath, ["status", "--short"]),
    diffStat: await runGit(state.worktreePath, ["diff", "--stat", state.baseCommit]),
  };
}

export async function runWebWorktreeCommand(
  statePath: string,
  action: "status" | "bring-back" | "remove",
  options: { message?: string; force?: boolean; signal?: AbortSignal } = {},
  dependencies: WebWorkflowDependencies = {},
): Promise<DshWebCommandResult> {
  const state = await loadWebWorkflowState(statePath);
  if (action === "bring-back") await requirePreparedWorktree(state);
  if (action === "remove") await requireWorktreeExists(state);
  const client = dependencies.client ?? new DshWebClient(state.webUrl);
  let command: string;
  if (action === "status") {
    command = `/worktree status ${state.worktreeName}`;
  } else if (action === "bring-back") {
    command = `/worktree bring-back ${state.worktreeName}`;
    if (options.message !== undefined && options.message.trim() !== "") {
      command += ` ${options.message.trim().replace(/\s+/gu, " ")}`;
    }
  } else {
    command = `/worktree remove ${state.worktreeName}${options.force === true ? " --force" : ""}`;
  }
  const result = await runSlashCommand(client, state.controllerSessionId, command, options.signal);
  if (action === "bring-back") {
    state.phase = "brought_back";
    await persistState(state);
  } else if (action === "remove") {
    state.phase = "removed";
    await persistState(state);
  }
  return result;
}
