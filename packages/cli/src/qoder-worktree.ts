#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorktreeError,
  applyReviewPatch,
  createReviewPatch,
  disposeWorktree,
  inspectWorktree,
  prepareWorktree,
  reopenReviewWorktree,
} from "@qoder-agent-bridge/core";

export type WorktreeCommand = "prepare" | "inspect" | "diff" | "reopen" | "apply" | "dispose";

export type ParsedWorktreeArgs =
  | { command: "prepare"; cwd: string; retryOf: string | undefined; discard: false }
  | { command: "inspect" | "diff" | "reopen" | "apply"; state: string; discard: false }
  | { command: "dispose"; state: string; discard: boolean };

interface WorktreeArgValues {
  cwd?: string;
  state?: string;
  retryOf?: string;
  discard: boolean;
}

const WORKTREE_COMMANDS: readonly WorktreeCommand[] = [
  "prepare",
  "inspect",
  "diff",
  "reopen",
  "apply",
  "dispose",
];

function isWorktreeCommand(value: string | undefined): value is WorktreeCommand {
  return value !== undefined && WORKTREE_COMMANDS.includes(value as WorktreeCommand);
}

export function parseWorktreeArgs(argv: string[]): ParsedWorktreeArgs {
  const command = argv[0];
  if (!isWorktreeCommand(command)) {
    throw new WorktreeError(
      "invalid_input",
      "Use prepare, inspect, diff, reopen, apply, or dispose.",
    );
  }

  const values: WorktreeArgValues = { discard: false };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--discard") {
      if (values.discard) {
        throw new WorktreeError("invalid_input", "--discard was provided more than once.");
      }
      values.discard = true;
      continue;
    }
    if (option !== "--cwd" && option !== "--state" && option !== "--retry-of") {
      throw new WorktreeError("invalid_input", "Unsupported worktree coordinator argument.");
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new WorktreeError(
        "invalid_input",
        "Worktree coordinator argument is missing its value.",
      );
    }
    if (option === "--cwd") {
      if (values.cwd !== undefined) {
        throw new WorktreeError("invalid_input", "--cwd was provided more than once.");
      }
      values.cwd = value;
    } else if (option === "--state") {
      if (values.state !== undefined) {
        throw new WorktreeError("invalid_input", "--state was provided more than once.");
      }
      values.state = value;
    } else if (option === "--retry-of") {
      if (values.retryOf !== undefined) {
        throw new WorktreeError("invalid_input", "--retry-of was provided more than once.");
      }
      values.retryOf = value;
    }
    index += 1;
  }

  if (command === "prepare") {
    if (values.cwd === undefined || values.state !== undefined || values.discard) {
      throw new WorktreeError(
        "invalid_input",
        "prepare requires --cwd <absolute-path> and optionally --retry-of <state-path>.",
      );
    }
    return { command, cwd: values.cwd, retryOf: values.retryOf, discard: false };
  }

  if (
    values.state === undefined ||
    values.cwd !== undefined ||
    values.retryOf !== undefined ||
    (command !== "dispose" && values.discard)
  ) {
    throw new WorktreeError("invalid_input", `${command} requires only --state <absolute-path>.`);
  }

  if (command === "dispose") {
    return {
      command,
      state: values.state,
      discard: values.discard,
    };
  }
  return { command, state: values.state, discard: false };
}

export async function executeWorktreeCommand(argv: string[]): Promise<Record<string, unknown>> {
  const parsed = parseWorktreeArgs(argv);
  if (parsed.command === "prepare") {
    const session = await prepareWorktree(parsed.cwd, parsed.retryOf);
    return {
      status: "succeeded",
      operation: "prepare",
      statePath: session.statePath,
      worktreeRoot: session.worktreeRoot,
      qoderCwd: session.worktreeCwd,
      retryOf: session.retryOf,
      includedIgnoredArtifacts: session.includedIgnoredArtifacts,
    };
  }
  if (parsed.command === "inspect") {
    const result = await inspectWorktree(parsed.state);
    return {
      status: "succeeded",
      operation: "inspect",
      phase: result.session.phase,
      statePath: result.session.statePath,
      qoderCwd: result.session.worktreeCwd,
      hasChanges: result.hasChanges,
      changedFiles: result.changedFiles,
      indexModified: result.indexModified,
      reviewAttempt: result.session.reviewAttempt,
    };
  }
  if (parsed.command === "diff") {
    const result = await createReviewPatch(parsed.state);
    return {
      status: "succeeded",
      operation: "diff",
      statePath: result.session.statePath,
      worktreeRoot: result.session.worktreeRoot,
      patchPath: result.session.reviewPatchPath,
      baselineTree: result.session.baselineTree,
      changedFiles: result.changedFiles,
      reviewAttempt: result.session.reviewAttempt,
    };
  }
  if (parsed.command === "reopen") {
    const result = await reopenReviewWorktree(parsed.state);
    return {
      status: "succeeded",
      operation: "reopen",
      phase: result.session.phase,
      statePath: result.session.statePath,
      qoderCwd: result.session.worktreeCwd,
      archivedPatchPath: result.archivedPatchPath,
      changedFiles: result.changedFiles,
      indexModified: false,
      reviewAttempt: result.session.reviewAttempt,
    };
  }
  if (parsed.command === "apply") {
    const session = await applyReviewPatch(parsed.state);
    return { status: "succeeded", operation: "apply", statePath: session.statePath, cleaned: true };
  }
  await disposeWorktree(parsed.state, parsed.discard);
  return { status: "succeeded", operation: "dispose" };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const result = await executeWorktreeCommand(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof WorktreeError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : "Worktree coordinator failed.";
    process.stdout.write(`${JSON.stringify({ status: "failed", error: { code, message } })}\n`);
    process.exitCode = 1;
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
