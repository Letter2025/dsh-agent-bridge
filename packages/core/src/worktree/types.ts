export const WORKTREE_SESSION_VERSION = 1;
export const SESSION_PREFIX = "qoder-agent-worktree-";
export const PATCH_FILE_NAME = "qoder-only.patch";
export const STATE_FILE_NAME = "session.json";
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export class WorktreeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

export interface WorktreeSession {
  version: number;
  phase: "prepared" | "review_ready" | "applied";
  sessionRoot: string;
  statePath: string;
  sourceRoot: string;
  sourceCwd: string;
  worktreeRoot: string;
  worktreeCwd: string;
  baseCommit: string;
  baselineTree: string;
  baselinePatchPath: string;
  reviewPatchPath: string;
  retryOf: string | null;
}
