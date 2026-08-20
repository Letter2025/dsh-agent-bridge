import { PROTOCOL_VERSION, RUNNER_VERSION } from "./constants";
import {
  RunnerError,
  type RunnerEnvelope,
  type RunnerErrorShape,
  type RunnerExecution,
} from "./types";

export function createEnvelope(
  values: Partial<RunnerEnvelope> & { durationMs: number },
): RunnerEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runnerVersion: RUNNER_VERSION,
    status: values.status ?? "failed",
    cwd: values.cwd ?? null,
    dshPath: values.dshPath ?? null,
    executable: values.executable ?? null,
    profile: "headless",
    sessionMode: "fresh_persisted",
    outputFormat: "text",
    exitCode: values.exitCode ?? null,
    signal: values.signal ?? null,
    durationMs: Math.max(0, Math.round(values.durationMs)),
    timedOut: values.timedOut ?? false,
    stdout: values.stdout ?? "",
    stderr: values.stderr ?? "",
    stdoutTruncated: values.stdoutTruncated ?? false,
    stderrTruncated: values.stderrTruncated ?? false,
    dshOutput: values.dshOutput ?? { format: "text", raw: values.stdout ?? "" },
    retryable: values.retryable ?? false,
    recovery: values.recovery ?? null,
    error: values.error,
  };
}

function errorShape(error: unknown): RunnerErrorShape {
  if (error instanceof RunnerError) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal_error", message: "Runner failed before DSH execution completed." };
}

export function createPreflightFailure(
  startedAt: number,
  cwd: string | null,
  executable: string | null,
  error: unknown,
): RunnerExecution {
  const shape = errorShape(error);
  const status =
    shape.code === "executable_not_found" || shape.code === "spawn_error"
      ? "spawn_error"
      : "failed";
  return {
    envelope: createEnvelope({
      status,
      cwd,
      executable,
      durationMs: performance.now() - startedAt,
      error: shape,
    }),
    exitCode: 1,
  };
}
