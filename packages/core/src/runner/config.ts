import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import {
  DEFAULT_MAX_MODEL_REQUEST_RETRIES,
  DEFAULT_TIMEOUT_MS,
  FIXED_SAFETY_POLICY,
  MAX_MODEL_REQUEST_RETRIES,
  MAX_TIMEOUT_MS,
  PROMPT_LIMIT_BYTES,
  WINDOWS_COMMAND_LINE_LIMIT_UTF16,
} from "./constants";
import {
  RunnerError,
  type ParsedRunnerArgs,
  type PromptFileHandle,
  type PromptFileStats,
  type RunnerConfig,
  type RunnerFs,
} from "./types";

const DEFAULT_FS: RunnerFs = {
  access,
  lstat: (path) => lstat(path, { bigint: true }) as Promise<PromptFileStats>,
  open: async (path, flags) => {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }) as Promise<PromptFileStats>,
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
  realpath,
  stat,
};

function validatePrompt(prompt: string): string {
  if (prompt.trim() === "") {
    throw new RunnerError("invalid_input", "The prompt must be non-empty.");
  }
  if (prompt.includes("\0")) {
    throw new RunnerError("invalid_input", "The prompt must not contain NUL bytes.");
  }
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_LIMIT_BYTES) {
    throw new RunnerError("invalid_input", "The prompt exceeds the 64 KiB limit.");
  }
  return prompt;
}

export async function resolvePrompt(
  parsed: Pick<ParsedRunnerArgs, "prompt" | "promptFile">,
  fsApi: RunnerFs = DEFAULT_FS,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if ((parsed.prompt === undefined) === (parsed.promptFile === undefined)) {
    throw new RunnerError("invalid_input", "Exactly one of --prompt or --prompt-file is required.");
  }
  if (parsed.prompt !== undefined) {
    return validatePrompt(parsed.prompt);
  }
  const promptFile = parsed.promptFile;
  if (promptFile === undefined || !isAbsolute(promptFile)) {
    throw new RunnerError("invalid_input", "--prompt-file must be an absolute path.");
  }

  let pathInformation: PromptFileStats;
  try {
    pathInformation = await fsApi.lstat(promptFile);
  } catch {
    throw new RunnerError("invalid_input", "--prompt-file must point to a readable regular file.");
  }
  if (!pathInformation.isFile() || pathInformation.isSymbolicLink()) {
    throw new RunnerError(
      "invalid_input",
      "--prompt-file must point to a non-symbolic-link regular file.",
    );
  }

  let handle: PromptFileHandle | undefined;
  let resolvedPrompt: string | undefined;
  let operationError: RunnerError | undefined;
  try {
    const noFollow = platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    handle = await fsApi.open(promptFile, fsConstants.O_RDONLY | noFollow);
    const handleInformation = await handle.stat();
    if (
      !handleInformation.isFile() ||
      handleInformation.dev !== pathInformation.dev ||
      handleInformation.ino !== pathInformation.ino
    ) {
      throw new RunnerError(
        "invalid_input",
        "--prompt-file changed identity while it was being opened.",
      );
    }
    if (handleInformation.size > BigInt(PROMPT_LIMIT_BYTES)) {
      throw new RunnerError("invalid_input", "The prompt exceeds the 64 KiB limit.");
    }

    const buffer = Buffer.allocUnsafe(PROMPT_LIMIT_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > PROMPT_LIMIT_BYTES) {
      throw new RunnerError("invalid_input", "The prompt exceeds the 64 KiB limit.");
    }

    let prompt: string;
    try {
      prompt = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, totalBytesRead));
    } catch {
      throw new RunnerError("invalid_input", "--prompt-file must contain valid UTF-8 text.");
    }
    resolvedPrompt = validatePrompt(prompt);
  } catch (error) {
    operationError =
      error instanceof RunnerError
        ? error
        : new RunnerError("invalid_input", "--prompt-file must point to a readable regular file.");
  }

  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      operationError ??= new RunnerError("internal_error", "The prompt file could not be closed.");
    }
  }

  if (operationError !== undefined) throw operationError;
  if (resolvedPrompt === undefined) {
    throw new RunnerError("internal_error", "The prompt file did not produce a prompt.");
  }
  return resolvedPrompt;
}

function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[ \t"]/u.test(argument)) return argument;

  let quoted = '"';
  let backslashes = 0;
  for (let index = 0; index < argument.length; index += 1) {
    const character = argument[index];
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

export function windowsCommandLineLength(executable: string, args: string[]): number {
  return [executable, ...args].map(quoteWindowsArgument).join(" ").length + 1;
}

export function validateWindowsCommandLine(executable: string, args: string[]): void {
  if (windowsCommandLineLength(executable, args) > WINDOWS_COMMAND_LINE_LIMIT_UTF16) {
    throw new RunnerError(
      "invalid_input",
      "The Qoder command line exceeds the Windows CreateProcessW limit; shorten the brief, path, or model.",
    );
  }
}

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
  const prompt = await resolvePrompt(parsed, fsApi);
  const executable = await resolveExecutable(parsed.qodercliPath, env, fsApi);
  const configuredTimeout = parsed.timeoutMs ?? env.QODER_TIMEOUT_MS;
  const configuredRetries = parsed.maxModelRequestRetries ?? env.QODER_MAX_MODEL_REQUEST_RETRIES;
  return {
    cwd,
    prompt,
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
