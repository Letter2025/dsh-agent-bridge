#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_LIMIT_BYTES,
  RunnerError,
  createPreflightFailure,
  executeRunner,
  type ParsedRunnerArgs,
  type RunnerExecution,
} from "@qoder-agent-bridge/core";

export function parseRunnerArgs(argv: string[]): ParsedRunnerArgs {
  const values: Record<string, string | undefined> = {};
  const options = new Set([
    "--cwd",
    "--prompt",
    "--qodercli-path",
    "--model",
    "--timeout-ms",
    "--max-model-request-retries",
  ]);
  const optionKeys: Record<string, string> = {
    "--cwd": "cwd",
    "--prompt": "prompt",
    "--qodercli-path": "qodercliPath",
    "--model": "model",
    "--timeout-ms": "timeoutMs",
    "--max-model-request-retries": "maxModelRequestRetries",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined || !options.has(option)) {
      throw new RunnerError("invalid_input", "Unsupported or misplaced Runner argument.");
    }
    if (index + 1 >= argv.length) {
      throw new RunnerError("invalid_input", "Runner argument is missing its value.");
    }
    const key = optionKeys[option];
    if (key === undefined) {
      throw new RunnerError("invalid_input", "Unsupported or misplaced Runner argument.");
    }
    if (Object.hasOwn(values, key)) {
      throw new RunnerError("invalid_input", "Runner argument was provided more than once.");
    }
    values[key] = argv[index + 1];
    index += 1;
  }

  const cwd = values.cwd;
  const prompt = values.prompt;
  if (cwd === undefined || cwd.trim() === "") {
    throw new RunnerError("invalid_input", "--cwd is required and must be non-empty.");
  }
  if (prompt === undefined || prompt.trim() === "") {
    throw new RunnerError("invalid_input", "--prompt is required and must be non-empty.");
  }
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_LIMIT_BYTES) {
    throw new RunnerError("invalid_input", "--prompt exceeds the 64 KiB limit.");
  }
  for (const [key, option] of [
    ["qodercliPath", "--qodercli-path"],
    ["model", "--model"],
    ["timeoutMs", "--timeout-ms"],
    ["maxModelRequestRetries", "--max-model-request-retries"],
  ] as const) {
    const value = values[key];
    if (value !== undefined && value.trim() === "") {
      throw new RunnerError("invalid_input", `${option} must be non-empty when supplied.`);
    }
  }

  return {
    cwd,
    prompt,
    qodercliPath: values.qodercliPath,
    model: values.model,
    timeoutMs: values.timeoutMs,
    maxModelRequestRetries: values.maxModelRequestRetries,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const onSigint = () => controller.abort("SIGINT");
  const onSigterm = () => controller.abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    let result: RunnerExecution;
    try {
      result = await executeRunner(parseRunnerArgs(argv), process.env, controller.signal);
    } catch (error) {
      result = createPreflightFailure(startedAt, null, null, error);
    }
    process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
    if (result.exitCode !== 0) {
      process.stderr.write(`[run_qoder] ${result.envelope.error?.code ?? "failed"}\n`);
    }
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
