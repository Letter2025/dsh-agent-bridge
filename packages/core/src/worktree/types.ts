export const WORKTREE_SESSION_VERSION = 2;
export const SESSION_PREFIX = "dsh-agent-worktree-";
export const PATCH_FILE_NAME = "dsh-only.patch";
export const STATE_FILE_NAME = "session.json";
export const INCLUDED_ARTIFACT_MANIFEST_FILE_NAME = "included-ignored-artifacts.json";
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_INCLUDED_ARTIFACT_FILES = 20_000;
export const MAX_INCLUDED_ARTIFACT_BYTES = 256 * 1024 * 1024;

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
  reviewAttempt: number;
  retryOf: string | null;
  includedIgnoredArtifacts: IncludedIgnoredArtifacts | null;
}

export interface IncludedIgnoredArtifacts {
  configPath: string;
  manifestPath: string;
  manifestSha256: string | null;
  rules: string[];
  fileCount: number;
  totalBytes: number;
}

export interface IncludedArtifactManifestEntry {
  path: string;
  type: "file" | "symlink";
  mode: number;
  size: number;
  sha256: string;
}

export interface IncludedArtifactManifest {
  version: 1;
  entries: IncludedArtifactManifestEntry[];
}
