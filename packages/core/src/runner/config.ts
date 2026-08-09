import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import {
  DEFAULT_MAX_MODEL_REQUEST_RETRIES,
  DEFAULT_TIMEOUT_MS,
  FIXED_SAFETY_POLICY,
  MAX_MODEL_REQUEST_RETRIES,
  MAX_TIMEOUT_MS,
} from "./constants";
import { RunnerError, type ParsedRunnerArgs, type RunnerConfig, type RunnerFs } from "./types";

const DEFAULT_FS = { access, realpath, stat };

export function parseTimeout(rawValue: string | undefined, source = "timeout"): number {
  if (rawValue === undefined || rawValue.trim() === "" || !/^\d+$/.test(rawValue)) {
    throw new RunnerError("invalid_input", `${source} must be a positive integer in milliseconds.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RunnerError(
      "invalid_input",
      `${source} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

export function parseModelRequestRetries(
  rawValue: string | undefined,
  source = "model request retries",
): number {
  if (rawValue === undefined || rawValue.trim() === "" || !/^\d+$/.test(rawValue)) {
    throw new RunnerError("invalid_input", `${source} must be an integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MODEL_REQUEST_RETRIES) {
    throw new RunnerError(
      "invalid_input",
      `${source} must be between 0 and ${MAX_MODEL_REQUEST_RETRIES}.`,
    );
  }
  return value;
}

export async function normalizeCwd(cwd: string, fsApi: RunnerFs = DEFAULT_FS): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new RunnerError("invalid_input", "--cwd must be an absolute path.");
  }
  let information;
  try {
    information = await fsApi.stat(cwd);
  } catch {
    throw new RunnerError("invalid_input", "--cwd must point to an existing directory.");
  }
  if (!information.isDirectory()) {
    throw new RunnerError("invalid_input", "--cwd must point to an existing directory.");
  }
  try {
    return await fsApi.realpath(cwd);
  } catch {
    throw new RunnerError("invalid_input", "--cwd could not be normalized.");
  }
}

async function resolveExecutableFile(candidate: string, fsApi: RunnerFs): Promise<string | null> {
  if (!isAbsolute(candidate)) return null;
  try {
    const information = await fsApi.stat(candidate);
    if (!information.isFile()) return null;
    await fsApi.access(candidate, fsConstants.X_OK);
    return await fsApi.realpath(candidate);
  } catch {
    return null;
  }
}

function executableCandidates(
  candidate: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform !== "win32" || extname(candidate) !== "") return [candidate];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.CMD;.BAT")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension !== "");
  return [candidate, ...extensions.map((extension) => `${candidate}${extension}`)];
}

function isWindowsCommandShim(candidate: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && [".cmd", ".bat"].includes(extname(candidate).toLowerCase());
}

export async function resolveExecutable(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fsApi: RunnerFs = DEFAULT_FS,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const configuredPath = explicitPath ?? env.QODERCLI_PATH;
  if (configuredPath !== undefined && configuredPath.trim() !== "") {
    for (const candidate of executableCandidates(configuredPath, platform, env)) {
      const resolved = await resolveExecutableFile(candidate, fsApi);
      if (resolved !== null && !isWindowsCommandShim(resolved, platform)) return resolved;
    }
    throw new RunnerError(
      "executable_not_found",
      "The configured Qoder executable is unavailable or is a Windows command shim; configure the native qodercli executable.",
    );
  }

  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory.trim() === "") continue;
    for (const candidate of executableCandidates(join(directory, "qodercli"), platform, env)) {
      const resolved = await resolveExecutableFile(candidate, fsApi);
      if (resolved !== null && !isWindowsCommandShim(resolved, platform)) return resolved;
    }
  }
  throw new RunnerError(
    "executable_not_found",
    "Qoder CLI was not found in PATH. Add qodercli to PATH or configure QODERCLI_PATH or --qodercli-path.",
  );
}

export async function resolveConfig(
  parsed: ParsedRunnerArgs,
  env: NodeJS.ProcessEnv = process.env,
  fsApi: RunnerFs = DEFAULT_FS,
): Promise<RunnerConfig> {
  const cwd = await normalizeCwd(parsed.cwd, fsApi);
  const executable = await resolveExecutable(parsed.qodercliPath, env, fsApi);
  const configuredTimeout = parsed.timeoutMs ?? env.QODER_TIMEOUT_MS;
  const configuredRetries = parsed.maxModelRequestRetries ?? env.QODER_MAX_MODEL_REQUEST_RETRIES;
  return {
    cwd,
    prompt: parsed.prompt,
    executable,
    env,
    model: (parsed.model ?? env.QODER_MODEL)?.trim() || undefined,
    timeoutMs:
      configuredTimeout === undefined
        ? DEFAULT_TIMEOUT_MS
        : parseTimeout(
            configuredTimeout,
            parsed.timeoutMs === undefined ? "QODER_TIMEOUT_MS" : "--timeout-ms",
          ),
    maxModelRequestRetries:
      configuredRetries === undefined
        ? DEFAULT_MAX_MODEL_REQUEST_RETRIES
        : parseModelRequestRetries(
            configuredRetries,
            parsed.maxModelRequestRetries === undefined
              ? "QODER_MAX_MODEL_REQUEST_RETRIES"
              : "--max-model-request-retries",
          ),
    signal: undefined,
  };
}

export function buildQoderArgs(
  config: Pick<RunnerConfig, "cwd" | "prompt" | "model" | "maxModelRequestRetries">,
): string[] {
  const args = [
    "--print",
    "--cwd",
    config.cwd,
    "--permission-mode",
    "auto",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--max-model-request-retries",
    String(config.maxModelRequestRetries),
  ];
  if (config.model !== undefined) args.push("--model", config.model);
  args.push("--append-system-prompt", FIXED_SAFETY_POLICY, "--", config.prompt);
  return args;
}
