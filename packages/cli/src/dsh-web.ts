#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DshWebError,
  WorktreeError,
  inspectWebWorktree,
  parseTimeout,
  prepareWebWorktree,
  resolvePrompt,
  runWebTurn,
  runWebWorktreeCommand,
} from "@dsh-agent-bridge/core";

const RESULT_FILE_SUFFIX = ".result.json";

type WebCommand = "prepare" | "run" | "inspect" | "status" | "bring-back" | "remove";

interface ParsedWebArgs {
  command: WebCommand;
  cwd?: string;
  name?: string;
  webUrl?: string;
  worktreeDirName?: string;
  state?: string;
  prompt?: string;
  promptFile?: string;
  timeoutMs?: string;
  pollIntervalMs?: string;
  message?: string;
  force: boolean;
}

function parsePositiveInteger(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new DshWebError("invalid_input", `${option} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DshWebError("invalid_input", `${option} must be a positive integer.`);
  }
  return parsed;
}

export function parseWebArgs(argv: string[]): ParsedWebArgs {
  const rawCommand = argv[0];
  if (
    rawCommand !== "prepare" &&
    rawCommand !== "run" &&
    rawCommand !== "inspect" &&
    rawCommand !== "status" &&
    rawCommand !== "bring-back" &&
    rawCommand !== "remove"
  ) {
    throw new DshWebError(
      "invalid_input",
      "Command must be prepare, run, inspect, status, bring-back, or remove.",
    );
  }
  const values: Record<string, string | undefined> = {};
  let force = false;
  const optionKeys: Record<string, string> = {
    "--cwd": "cwd",
    "--name": "name",
    "--web-url": "webUrl",
    "--worktree-dir-name": "worktreeDirName",
    "--state": "state",
    "--prompt": "prompt",
    "--prompt-file": "promptFile",
    "--timeout-ms": "timeoutMs",
    "--poll-interval-ms": "pollIntervalMs",
    "--message": "message",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--force") {
      if (force) throw new DshWebError("invalid_input", "--force was provided more than once.");
      force = true;
      continue;
    }
    const key = option === undefined ? undefined : optionKeys[option];
    if (key === undefined) {
      throw new DshWebError("invalid_input", "Unsupported or misplaced Web workflow argument.");
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new DshWebError("invalid_input", `${option} requires a non-empty value.`);
    }
    if (Object.hasOwn(values, key)) {
      throw new DshWebError("invalid_input", `${option} was provided more than once.`);
    }
    values[key] = value;
    index += 1;
  }
  const parsed: ParsedWebArgs = {
    command: rawCommand,
    force,
  };
  for (const key of Object.keys(values) as Array<keyof Omit<ParsedWebArgs, "command" | "force">>) {
    const value = values[key];
    if (value !== undefined) parsed[key] = value;
  }

  if (parsed.command === "prepare") {
    if (parsed.cwd === undefined || parsed.name === undefined) {
      throw new DshWebError("invalid_input", "prepare requires --cwd and --name.");
    }
  } else {
    if (parsed.state === undefined || !isAbsolute(parsed.state)) {
      throw new DshWebError("invalid_input", `${parsed.command} requires an absolute --state path.`);
    }
  }
  if (parsed.command === "run" && (parsed.prompt === undefined) === (parsed.promptFile === undefined)) {
    throw new DshWebError("invalid_input", "run requires exactly one of --prompt or --prompt-file.");
  }
  if (parsed.force && parsed.command !== "remove") {
    throw new DshWebError("invalid_input", "--force is valid only for remove.");
  }
  return parsed;
}

async function persistResult(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await unlink(path).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function errorShape(error: unknown): { code: string; message: string } {
  if (error instanceof DshWebError || error instanceof WorktreeError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "DSH Web workflow failed.",
  };
}

export async function executeWebCommand(
  parsed: ParsedWebArgs,
  signal?: AbortSignal,
): Promise<{ envelope: Record<string, unknown>; exitCode: number; resultFile?: string }> {
  const startedAt = performance.now();
  let resultFile: string | undefined;
  try {
    let value: unknown;
    if (parsed.command === "prepare") {
      value = await prepareWebWorktree({
        cwd: parsed.cwd as string,
        name: parsed.name as string,
        ...(parsed.webUrl === undefined ? {} : { webUrl: parsed.webUrl }),
        ...(parsed.worktreeDirName === undefined
          ? {}
          : { worktreeDirName: parsed.worktreeDirName }),
        ...(parsed.state === undefined ? {} : { statePath: parsed.state }),
        ...(signal === undefined ? {} : { signal }),
      });
    } else if (parsed.command === "run") {
      const prompt = await resolvePrompt({
        prompt: parsed.prompt,
        promptFile: parsed.promptFile,
      });
      const timeoutMs =
        parsed.timeoutMs === undefined ? undefined : parseTimeout(parsed.timeoutMs, "--timeout-ms");
      const pollIntervalMs = parsePositiveInteger(parsed.pollIntervalMs, "--poll-interval-ms");
      value = await runWebTurn({
        statePath: parsed.state as string,
        prompt,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (parsed.promptFile !== undefined && isAbsolute(parsed.promptFile)) {
        resultFile = `${parsed.promptFile}${RESULT_FILE_SUFFIX}`;
      }
    } else if (parsed.command === "inspect") {
      value = await inspectWebWorktree(parsed.state as string);
    } else {
      value = await runWebWorktreeCommand(
        parsed.state as string,
        parsed.command,
        {
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
          ...(parsed.force ? { force: true } : {}),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    }
    const succeeded =
      parsed.command !== "run" ||
      (typeof value === "object" && value !== null && "status" in value && value.status === "succeeded");
    const envelope: Record<string, unknown> = {
      protocolVersion: 1,
      runnerVersion: "0.2.0",
      transport: "web",
      command: parsed.command,
      status: succeeded ? "succeeded" : "failed",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      value,
    };
    return { envelope, exitCode: succeeded ? 0 : 1, ...(resultFile === undefined ? {} : { resultFile }) };
  } catch (error) {
    return {
      envelope: {
        protocolVersion: 1,
        runnerVersion: "0.2.0",
        transport: "web",
        command: parsed.command,
        status: "failed",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        error: errorShape(error),
      },
      exitCode: 1,
      ...(resultFile === undefined ? {} : { resultFile }),
    };
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    let parsed: ParsedWebArgs;
    try {
      parsed = parseWebArgs(argv);
    } catch (error) {
      const shape = errorShape(error);
      process.stdout.write(
        `${JSON.stringify({ protocolVersion: 1, runnerVersion: "0.2.0", transport: "web", status: "failed", error: shape })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`[dsh_web] ${parsed.command} running; wait for the final JSON envelope.\n`);
    const result = await executeWebCommand(parsed, controller.signal);
    if (result.resultFile !== undefined) {
      await persistResult(result.resultFile, result.envelope).catch(() => {
        process.stderr.write("[dsh_web] result_file_error\n");
      });
    }
    process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) void main();
