// Isolated Git worktree lifecycle service. CLI concerns live in packages/cli.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runGit } from "./git-client";
import { assertInside, requireAbsolute } from "./paths";
import { copyUntrackedFile, listUntrackedFiles, resolveRepository } from "./repository";
import { readSession, sessionFileExists, writeSession } from "./session-store";
import {
  PATCH_FILE_NAME,
  SESSION_PREFIX,
  STATE_FILE_NAME,
  WORKTREE_SESSION_VERSION,
  WorktreeError,
  type WorktreeSession,
} from "./types";

/**
 * Read the predecessor sessions from newest to oldest, validating that every
 * session belongs to the source repository. A missing predecessor has
 * already been cleaned and is therefore not an error.
 *
 * @param {string | null} retryOf
 * @param {string} sourceRoot
 * @returns {Promise<WorktreeSession[]>}
 */
async function readRetryChain(
  retryOf: string | null,
  sourceRoot: string,
): Promise<WorktreeSession[]> {
  const sessions: WorktreeSession[] = [];
  const seen = new Set<string>();
  let statePath: string | null = retryOf;
  while (statePath !== null) {
    requireAbsolute(statePath, "retryOf");
    if (seen.has(statePath)) {
      throw new WorktreeError("invalid_state", "The retry session chain contains a cycle.");
    }
    seen.add(statePath);
    if (!(await sessionFileExists(statePath))) {
      break;
    }
    const session = await readSession(statePath);
    if (resolve(session.sourceRoot) !== resolve(sourceRoot)) {
      throw new WorktreeError(
        "invalid_state",
        "The retry session chain contains a session from another source worktree.",
      );
    }
    sessions.push(session);
    statePath = session.retryOf;
  }
  return sessions;
}

/**
 * @param {WorktreeSession} session
 * @param {boolean} discard
 */
async function disposeSession(session: WorktreeSession, discard: boolean): Promise<void> {
  if (session.phase !== "applied" && !discard) {
    throw new WorktreeError(
      "confirmation_required",
      "Pass --discard to remove a session whose reviewed changes were not applied.",
    );
  }
  await runGit(session.sourceRoot, ["worktree", "remove", "--force", session.worktreeRoot]);
  await rm(session.sessionRoot, { recursive: true, force: true });
}

/**
 * Dispose predecessor sessions from oldest to newest. The current session is
 * intentionally not included so it remains available if predecessor cleanup
 * fails and the caller needs to retry the operation.
 *
 * @param {string | null} retryOf
 * @param {string} sourceRoot
 */
async function disposeRetryChain(retryOf: string | null, sourceRoot: string): Promise<void> {
  const sessions = await readRetryChain(retryOf, sourceRoot);
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (session === undefined) {
      continue;
    }
    await disposeSession(session, session.phase !== "applied");
  }
}

/**
 * Create an isolated worktree that starts with a staged copy of the source
 * worktree state. Its index is the pre-Qoder baseline.
 *
 * @param {string} cwd
 * @param {string | undefined} retryOf
 * @returns {Promise<WorktreeSession>}
 */
export async function prepareWorktree(
  cwd: string,
  retryOf: string | undefined = undefined,
): Promise<WorktreeSession> {
  const repository = await resolveRepository(cwd);
  let retrySession = null;
  if (retryOf !== undefined) {
    retrySession = await readSession(retryOf);
    if (resolve(retrySession.sourceRoot) !== resolve(repository.sourceRoot)) {
      throw new WorktreeError(
        "invalid_input",
        "--retry-of must refer to a session from the same source worktree.",
      );
    }
  }
  const sessionRoot = await mkdtemp(join(tmpdir(), SESSION_PREFIX));
  const worktreeRoot = join(sessionRoot, "worktree");
  const statePath = join(sessionRoot, STATE_FILE_NAME);
  const baselinePatchPath = join(sessionRoot, "source-baseline.patch");
  const reviewPatchPath = join(sessionRoot, PATCH_FILE_NAME);
  const worktreeRelativeCwd = relative(repository.sourceRoot, repository.sourceCwd);
  const worktreeCwd = resolve(worktreeRoot, worktreeRelativeCwd);
  assertInside(worktreeRoot, worktreeCwd);

  try {
    const sourcePatch = await runGit(repository.sourceRoot, ["diff", "--binary", "HEAD"]);
    await writeFile(baselinePatchPath, sourcePatch, { mode: 0o600 });
    await runGit(repository.sourceRoot, [
      "worktree",
      "add",
      "--detach",
      worktreeRoot,
      repository.baseCommit,
    ]);
    if (sourcePatch !== "") {
      await runGit(worktreeRoot, ["apply", "--binary", "--index", baselinePatchPath]);
    }
    for (const path of await listUntrackedFiles(repository.sourceRoot)) {
      await copyUntrackedFile(repository.sourceRoot, worktreeRoot, path);
    }
    await runGit(worktreeRoot, ["add", "--all"]);
    const baselineTree = (await runGit(worktreeRoot, ["write-tree"])).trim();
    const session: WorktreeSession = {
      version: WORKTREE_SESSION_VERSION,
      phase: "prepared",
      sessionRoot,
      statePath,
      sourceRoot: repository.sourceRoot,
      sourceCwd: repository.sourceCwd,
      worktreeRoot,
      worktreeCwd,
      baseCommit: repository.baseCommit,
      baselineTree,
      baselinePatchPath,
      reviewPatchPath,
      retryOf: retrySession?.statePath ?? null,
    };
    await writeSession(session);
    return session;
  } catch (error) {
    await runGit(repository.sourceRoot, ["worktree", "remove", "--force", worktreeRoot], {
      allowExitCodes: [0, 128],
    }).catch(() => undefined);
    await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Inspect candidate changes without staging files, generating a patch, or
 * advancing the session phase. This keeps an interrupted prepared worktree
 * eligible for an explicitly approved recovery continuation.
 *
 * @param {string} statePath
 * @returns {Promise<{session: WorktreeSession, hasChanges: boolean, changedFiles: string[], indexModified: boolean}>}
 */
export interface WorktreeInspection {
  session: WorktreeSession;
  hasChanges: boolean;
  changedFiles: string[];
  indexModified: boolean;
}

export async function inspectWorktree(statePath: string): Promise<WorktreeInspection> {
  const session = await readSession(statePath);
  const tracked = (
    await runGit(session.worktreeRoot, ["diff", "--name-only", "-z", session.baselineTree])
  )
    .split("\0")
    .filter((path) => path !== "");
  const staged = (
    await runGit(session.worktreeRoot, [
      "diff",
      "--name-only",
      "--cached",
      "-z",
      session.baselineTree,
    ])
  )
    .split("\0")
    .filter((path) => path !== "");
  const untracked = await listUntrackedFiles(session.worktreeRoot);
  const changedFiles = [...new Set([...tracked, ...untracked])].sort();
  return {
    session,
    hasChanges: changedFiles.length > 0,
    changedFiles,
    indexModified: staged.length > 0,
  };
}

/**
 * Stage the post-Qoder state only in the temporary worktree, then emit the
 * binary patch from the preserved baseline to that state.
 *
 * @param {string} statePath
 * @returns {Promise<{session: WorktreeSession, changedFiles: string[]}>}
 */
export interface ReviewPatch {
  session: WorktreeSession;
  changedFiles: string[];
}

export async function createReviewPatch(statePath: string): Promise<ReviewPatch> {
  const session = await readSession(statePath);
  if (session.phase !== "prepared") {
    throw new WorktreeError(
      "invalid_state",
      "A review patch can be created only once per prepared session.",
    );
  }
  const currentIndexTree = (await runGit(session.worktreeRoot, ["write-tree"])).trim();
  if (currentIndexTree !== session.baselineTree) {
    throw new WorktreeError(
      "git_index_modified",
      "Qoder changed the temporary Git index; stop rather than generating a review patch.",
    );
  }
  await runGit(session.worktreeRoot, ["add", "--all"]);
  const patch = await runGit(session.worktreeRoot, [
    "diff",
    "--binary",
    "--cached",
    session.baselineTree,
  ]);
  await writeFile(session.reviewPatchPath, patch, { mode: 0o600 });
  const changedFiles = (
    await runGit(session.worktreeRoot, ["diff", "--name-only", "--cached", session.baselineTree])
  )
    .split("\n")
    .filter((path) => path !== "");
  session.phase = "review_ready";
  await writeSession(session);
  return { session, changedFiles };
}

/**
 * Apply the reviewed Qoder-only patch to the original source worktree without
 * staging it, then dispose the temporary worktree. A failed preflight leaves
 * both the source and the review session untouched.
 *
 * @param {string} statePath
 * @returns {Promise<WorktreeSession>}
 */
export async function applyReviewPatch(statePath: string): Promise<WorktreeSession> {
  const session = await readSession(statePath);
  if (session.phase !== "review_ready") {
    throw new WorktreeError(
      "invalid_state",
      "Apply is allowed only after the review patch is ready.",
    );
  }
  try {
    await runGit(session.sourceRoot, ["apply", "--check", "--binary", session.reviewPatchPath]);
  } catch {
    throw new WorktreeError(
      "apply_conflict",
      "The reviewed Qoder patch no longer applies cleanly; the source worktree was not modified.",
    );
  }
  await runGit(session.sourceRoot, ["apply", "--binary", session.reviewPatchPath]);
  session.phase = "applied";
  await writeSession(session);
  try {
    await disposeRetryChain(session.retryOf, session.sourceRoot);
    await disposeSession(session, false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown cleanup failure.";
    throw new WorktreeError(
      "cleanup_failed",
      `The reviewed Qoder patch was applied, but the temporary worktree could not be removed: ${detail}`,
    );
  }
  return session;
}

/**
 * @param {string} statePath
 * @param {boolean} discard
 */
export async function disposeWorktree(statePath: string, discard: boolean): Promise<void> {
  const session = await readSession(statePath);
  await disposeSession(session, discard);
}

/**
 * @param {string[]} argv
 */
