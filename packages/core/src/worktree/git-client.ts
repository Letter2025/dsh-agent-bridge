import { spawn } from "node:child_process";
import { MAX_GIT_OUTPUT_BYTES, WorktreeError } from "./types";

export interface GitOptions {
  allowExitCodes?: number[];
  maxBytes?: number;
}

export async function runGit(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  const allowed = new Set(options.allowExitCodes ?? [0]);
  const maxBytes = options.maxBytes ?? MAX_GIT_OUTPUT_BYTES;
  return await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let overflowed = false;

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => collect(stderr, Buffer.from(chunk)));
    child.on("error", () => {
      rejectOutput(new WorktreeError("git_unavailable", "Git could not be started."));
    });
    child.on("close", (code) => {
      if (overflowed) {
        rejectOutput(new WorktreeError("output_limit", "Git output exceeded the 64 MiB limit."));
        return;
      }
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (!allowed.has(code ?? 1)) {
        rejectOutput(
          new WorktreeError(
            "git_failed",
            diagnostic === "" ? "Git command failed." : `Git command failed: ${diagnostic}`,
          ),
        );
        return;
      }
      resolveOutput(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
