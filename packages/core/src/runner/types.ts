import type { SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";

export interface ChildProcessLike {
  pid?: number | undefined;
  stdout?: Readable | null | undefined;
  stderr?: Readable | null | undefined;
  once(event: "error", listener: (error: Error & { code?: string }) => void): this;
  once(
    event: "close",
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

type SpawnLike = (executable: string, args: string[], options: SpawnOptions) => ChildProcessLike;

export interface TreeKillerLike {
  once(event: "error", listener: (error: Error) => void): this;
}

type SpawnTreeKillerLike = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => TreeKillerLike;
type KillLike = (pid: number, signal: NodeJS.Signals) => void;

export interface PromptFileStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface PromptFileHandle {
  stat(): Promise<PromptFileStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface RunnerFs {
  access(path: string, mode?: number): Promise<void>;
  lstat(path: string): Promise<PromptFileStats>;
  open(path: string, flags: number): Promise<PromptFileHandle>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

export interface ParsedRunnerArgs {
  cwd: string;
  prompt: string | undefined;
  promptFile: string | undefined;
  dshPath: string | undefined;
  timeoutMs: string | undefined;
}

export interface RunnerConfig {
  cwd: string;
  prompt: string;
  dshPath: string;
  executable: string;
  executableArgs: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

export interface RunnerErrorShape {
  code: string;
  message: string;
}

export interface RunnerEnvelope {
  protocolVersion: number;
  runnerVersion: string;
  status: "succeeded" | "failed" | "timed_out" | "spawn_error";
  cwd: string | null;
  dshPath: string | null;
  executable: string | null;
  profile: "headless";
  sessionMode: "fresh_persisted";
  outputFormat: "text";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  dshOutput: { format: "text"; raw: string };
  retryable: boolean;
  recovery: { strategy: "continue_in_existing_worktree" } | null;
  error: RunnerErrorShape | undefined;
}

export interface RunnerExecution {
  envelope: RunnerEnvelope;
  exitCode: number;
}

export interface RunnerDependencies {
  spawnProcess?: SpawnLike;
  spawnTreeKiller?: SpawnTreeKillerLike;
  killProcess?: KillLike;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  captureLimitBytes?: number;
  hardOutputLimitBytes?: number;
  terminationGraceMs?: number;
}

export class RunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}
