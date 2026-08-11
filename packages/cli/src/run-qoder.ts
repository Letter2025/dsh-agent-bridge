#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_LIMIT_BYTES,
  RunnerError,
  createPreflightFailure,
  executeRunner,
  type ParsedRunnerArgs,
  type RunnerExecution,
} from "@qoder-agent-bridge/core";

export const RESULT_FILE_SUFFIX = ".result.json";

export function resultFileForPrompt(promptFile: string): string {
  return `${promptFile}${RESULT_FILE_SUFFIX}`;
}

async function removeStaleResult(resultFile: string): Promise<void> {
  try {
    await unlink(resultFile);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function persistResult(resultFile: string, result: RunnerExecution): Promise<void> {
  const temporaryFile = `${resultFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(result.envelope)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryFile, resultFile);
  } finally {
    await unlink(temporaryFile).catch(() => undefined);
  }
}

export function parseRunnerArgs(argv: string[]): ParsedRunnerArgs {
  const values: Record<string, string | undefined> = {};
  const options = new Set([
    "--cwd",
    "--prompt",
    "--prompt-file",
    "--qodercli-path",
    "--model",
    "--timeout-ms",
    "--max-model-request-retries",
  ]);
  const optionKeys: Record<string, string> = {
    "--cwd": "cwd",
    "--prompt": "prompt",
    "--prompt-file": "promptFile",
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
  const promptFile = values.promptFile;
  if (cwd === undefined || cwd.trim() === "") {
    throw new RunnerError("invalid_input", "--cwd is required and must be non-empty.");
  }
  if ((prompt === undefined) === (promptFile === undefined)) {
    throw new RunnerError("invalid_input", "Exactly one of --prompt or --prompt-file is required.");
  }
  if (prompt !== undefined && prompt.trim() === "") {
    throw new RunnerError("invalid_input", "--prompt must be non-empty when supplied.");
  }
  if (prompt !== undefined && Buffer.byteLength(prompt, "utf8") > PROMPT_LIMIT_BYTES) {
    throw new RunnerError("invalid_input", "--prompt exceeds the 64 KiB limit.");
  }
  for (const [key, option] of [
    ["promptFile", "--prompt-file"],
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
    promptFile,
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
    let resultFile: string | undefined;
    try {
      const parsed = parseRunnerArgs(argv);
      if (parsed.promptFile !== undefined && isAbsolute(parsed.promptFile)) {
        resultFile = resultFileForPrompt(parsed.promptFile);
        await removeStaleResult(resultFile);
      }
      process.stderr.write(
        "[run_qoder] running; wait for an explicit exit code and the final JSON envelope on stdout.\n",
      );
      result = await executeRunner(parsed, process.env, controller.signal);
    } catch (error) {
      result = createPreflightFailure(startedAt, null, null, error);
    }
    if (resultFile !== undefined) {
      try {
        await persistResult(resultFile, result);
      } catch {
        process.stderr.write("[run_qoder] result_file_error\n");
      }
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
