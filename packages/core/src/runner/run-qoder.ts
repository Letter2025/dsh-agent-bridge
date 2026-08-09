// Qoder one-shot execution service. CLI concerns live in packages/cli.

import { spawn } from "node:child_process";
import {
  DEFAULT_CAPTURE_LIMIT_BYTES,
  HARD_OUTPUT_LIMIT_BYTES,
  TERMINATION_GRACE_MS,
} from "./constants";
import { buildQoderArgs, resolveConfig } from "./config";
import { OutputCollector, isModelQueueExhausted, redactSecrets } from "./output";
import { createEnvelope, createPreflightFailure } from "./protocol";
import {
  type ChildProcessLike,
  type ParsedRunnerArgs,
  type RunnerConfig,
  type RunnerDependencies,
  type RunnerEnvelope,
  type RunnerErrorShape,
  type RunnerExecution,
} from "./types";

/**
 * @param {RunnerConfig} config
 * @param {RunnerDependencies} dependencies
 * @returns {Promise<RunnerExecution>}
 */
export function runQoder(
  config: RunnerConfig,
  dependencies: RunnerDependencies = {},
): Promise<RunnerExecution> {
  const spawnProcess: NonNullable<RunnerDependencies["spawnProcess"]> =
    dependencies.spawnProcess ?? spawn;
  const spawnTreeKiller: NonNullable<RunnerDependencies["spawnTreeKiller"]> =
    dependencies.spawnTreeKiller ?? spawn;
  const killProcess = dependencies.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const platform = dependencies.platform ?? process.platform;
  const now = dependencies.now ?? (() => performance.now());
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const captureLimitBytes = dependencies.captureLimitBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
  const hardOutputLimitBytes = dependencies.hardOutputLimitBytes ?? HARD_OUTPUT_LIMIT_BYTES;
  const terminationGraceMs = dependencies.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const startedAt = now();
  const stdout = new OutputCollector(captureLimitBytes, hardOutputLimitBytes);
  const stderr = new OutputCollector(captureLimitBytes, hardOutputLimitBytes);
  const args = buildQoderArgs(config);

  return new Promise((resolvePromise) => {
    let child: ChildProcessLike | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let graceHandle: NodeJS.Timeout | undefined;
    let settled = false;
    let terminationReason: "timed_out" | "output_limit" | "interrupted" | undefined;

    const clearTimers = () => {
      if (timeoutHandle !== undefined) {
        clearTimer(timeoutHandle);
      }
      if (graceHandle !== undefined) {
        clearTimer(graceHandle);
      }
    };

    const terminateTree = (signal: NodeJS.Signals) => {
      if (child?.pid === undefined || child.pid === null) {
        return;
      }
      try {
        if (platform === "win32") {
          const taskkillArgs = ["/pid", String(child.pid), "/t"];
          if (signal === "SIGKILL") {
            taskkillArgs.push("/f");
          }
          const killer = spawnTreeKiller("taskkill.exe", taskkillArgs, {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => undefined);
        } else {
          killProcess(-child.pid, signal);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          // The child close event remains authoritative. Avoid leaking OS errors.
        }
      }
    };

    /** @param {"timed_out" | "output_limit" | "interrupted"} reason */
    const requestTermination = (reason: "timed_out" | "output_limit" | "interrupted") => {
      if (terminationReason !== undefined || settled) {
        return;
      }
      terminationReason = reason;
      terminateTree("SIGTERM");
      graceHandle = setTimer(() => terminateTree("SIGKILL"), terminationGraceMs);
    };

    /**
     * @param {number | null} exitCode
     * @param {NodeJS.Signals | null} signal
     * @param {RunnerErrorShape | undefined} spawnError
     */
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError: RunnerErrorShape | undefined,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (config.signal !== undefined) {
        config.signal.removeEventListener("abort", onAbort);
      }

      const stdoutText = redactSecrets(stdout.toString(), config.prompt);
      const stderrText = redactSecrets(stderr.toString(), config.prompt);
      let status: RunnerEnvelope["status"] = "failed";
      let error: RunnerErrorShape | undefined;
      let retryable = false;
      let recovery: RunnerEnvelope["recovery"] = null;
      if (terminationReason === "timed_out") {
        status = "timed_out";
        error = { code: "timed_out", message: "Qoder execution exceeded the configured timeout." };
      } else if (terminationReason === "output_limit") {
        error = {
          code: "output_limit",
          message: "Qoder output exceeded the hard per-stream limit.",
        };
      } else if (terminationReason === "interrupted") {
        error = {
          code: "interrupted",
          message: "Qoder execution was interrupted by the parent process.",
        };
      } else if (spawnError !== undefined) {
        status = "spawn_error";
        error = spawnError;
      } else if (exitCode === 0 && signal === null) {
        status = "succeeded";
      } else if (isModelQueueExhausted(stdoutText, stderrText)) {
        retryable = true;
        recovery = { strategy: "continue_in_existing_worktree" };
        error = {
          code: "model_queue_exhausted",
          message: "Qoder exhausted its model queue recovery attempts.",
        };
      } else {
        error = {
          code: "qoder_exit_nonzero",
          message: "Qoder exited without a successful status.",
        };
      }

      const envelope = createEnvelope({
        status,
        cwd: config.cwd,
        executable: config.executable,
        exitCode,
        signal,
        durationMs: now() - startedAt,
        timedOut: terminationReason === "timed_out",
        stdout: stdoutText,
        stderr: stderrText,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        qoderOutput: { format: "json", raw: stdoutText },
        retryable,
        recovery,
        error,
      });
      resolvePromise({ envelope, exitCode: status === "succeeded" ? 0 : 1 });
    };

    const onAbort = () => {
      requestTermination("interrupted");
    };

    if (config.signal?.aborted) {
      terminationReason = "interrupted";
      finish(null, null, undefined);
      return;
    }
    config.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child = spawnProcess(config.executable, args, {
        cwd: config.cwd,
        env: process.env,
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(null, null, { code: "spawn_error", message: "Qoder could not be started." });
      return;
    }

    if (child?.stdout == null || child.stderr == null) {
      finish(null, null, {
        code: "spawn_error",
        message: "Qoder did not provide standard output streams.",
      });
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (stdout.exceededHardLimit || stderr.exceededHardLimit) {
        requestTermination("output_limit");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (stdout.exceededHardLimit || stderr.exceededHardLimit) {
        requestTermination("output_limit");
      }
    });
    child.once("error", (childError: Error & { code?: string }) => {
      const code = childError.code;
      finish(null, null, {
        code: code === "ENOENT" ? "executable_not_found" : "spawn_error",
        message:
          code === "ENOENT"
            ? "The Qoder executable could not be started."
            : "Qoder could not be started.",
      });
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal, undefined);
    });
    timeoutHandle = setTimer(() => requestTermination("timed_out"), config.timeoutMs);
  });
}

/** Execute one Runner request without owning process I/O or signal handlers. */
export async function executeRunner(
  parsed: ParsedRunnerArgs,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<RunnerExecution> {
  const startedAt = performance.now();
  let failureCwd: string | null = null;
  let failureExecutable: string | null = null;
  try {
    failureCwd = parsed.cwd;
    const config = await resolveConfig(parsed, env);
    failureCwd = config.cwd;
    failureExecutable = config.executable;
    config.signal = signal;
    return await runQoder(config);
  } catch (error) {
    return createPreflightFailure(startedAt, failureCwd, failureExecutable, error);
  }
}
