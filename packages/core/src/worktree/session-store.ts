import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { assertInside, requireAbsolute } from "./paths";
import {
  SESSION_PREFIX,
  WORKTREE_SESSION_VERSION,
  WorktreeError,
  type WorktreeSession,
} from "./types";

export async function writeSession(session: WorktreeSession): Promise<void> {
  await writeFile(session.statePath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export async function readSession(statePath: string): Promise<WorktreeSession> {
  requireAbsolute(statePath, "--state");
  let resolvedState: string;
  try {
    resolvedState = await realpath(statePath);
  } catch {
    throw new WorktreeError("invalid_input", "--state must point to an existing session file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedState, "utf8"));
  } catch {
    throw new WorktreeError("invalid_input", "--state is not a readable DSH worktree session.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WorktreeError("invalid_input", "--state is not a valid DSH worktree session.");
  }
  const session = parsed as Partial<WorktreeSession>;
  const hasIncludedArtifactState = Object.prototype.hasOwnProperty.call(
    session,
    "includedIgnoredArtifacts",
  );
  const requiredStrings = [
    session.sessionRoot,
    session.sourceRoot,
    session.sourceCwd,
    session.worktreeRoot,
    session.worktreeCwd,
    session.baseCommit,
    session.baselineTree,
    session.baselinePatchPath,
    session.reviewPatchPath,
  ];
  if (
    (session.version !== 1 && session.version !== WORKTREE_SESSION_VERSION) ||
    (session.version === WORKTREE_SESSION_VERSION && !hasIncludedArtifactState) ||
    !["prepared", "review_ready", "applied"].includes(session.phase ?? "") ||
    requiredStrings.some((value) => typeof value !== "string") ||
    (session.reviewAttempt !== undefined &&
      (!Number.isInteger(session.reviewAttempt) || session.reviewAttempt < 0)) ||
    (session.retryOf !== undefined &&
      session.retryOf !== null &&
      typeof session.retryOf !== "string")
  ) {
    throw new WorktreeError("invalid_input", "--state is not a valid DSH worktree session.");
  }
  if (typeof session.retryOf === "string") requireAbsolute(session.retryOf, "retryOf");

  const validSession = session as WorktreeSession;
  const storedSessionRoot = resolve(validSession.sessionRoot);
  let sessionRoot: string;
  try {
    sessionRoot = await realpath(storedSessionRoot);
  } catch {
    throw new WorktreeError(
      "invalid_input",
      "--state is outside an existing DSH worktree session.",
    );
  }
  const normalizeSessionPath = (path: string): string => {
    assertInside(storedSessionRoot, path);
    return resolve(sessionRoot, relative(storedSessionRoot, path));
  };
  const worktreeRoot = normalizeSessionPath(validSession.worktreeRoot);
  const worktreeCwd = normalizeSessionPath(validSession.worktreeCwd);
  const baselinePatchPath = normalizeSessionPath(validSession.baselinePatchPath);
  const reviewPatchPath = normalizeSessionPath(validSession.reviewPatchPath);
  const includedIgnoredArtifacts = validSession.includedIgnoredArtifacts ?? null;
  if (includedIgnoredArtifacts !== null) {
    if (
      typeof includedIgnoredArtifacts.configPath !== "string" ||
      typeof includedIgnoredArtifacts.manifestPath !== "string" ||
      (validSession.version === WORKTREE_SESSION_VERSION &&
        (typeof includedIgnoredArtifacts.manifestSha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(includedIgnoredArtifacts.manifestSha256))) ||
      (validSession.version === 1 &&
        includedIgnoredArtifacts.manifestSha256 !== undefined &&
        includedIgnoredArtifacts.manifestSha256 !== null &&
        (typeof includedIgnoredArtifacts.manifestSha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(includedIgnoredArtifacts.manifestSha256))) ||
      !Array.isArray(includedIgnoredArtifacts.rules) ||
      includedIgnoredArtifacts.rules.some((rule) => typeof rule !== "string") ||
      !Number.isInteger(includedIgnoredArtifacts.fileCount) ||
      includedIgnoredArtifacts.fileCount < 0 ||
      !Number.isInteger(includedIgnoredArtifacts.totalBytes) ||
      includedIgnoredArtifacts.totalBytes < 0
    ) {
      throw new WorktreeError("invalid_input", "--state is not a valid DSH worktree session.");
    }
    if (
      resolve(includedIgnoredArtifacts.configPath) !==
      resolve(validSession.sourceRoot, ".dshinclude")
    ) {
      throw new WorktreeError("invalid_input", "--state is not a valid DSH worktree session.");
    }
    const normalizedManifestPath = normalizeSessionPath(includedIgnoredArtifacts.manifestPath);
    if (normalizedManifestPath !== join(sessionRoot, "included-ignored-artifacts.json")) {
      throw new WorktreeError("invalid_input", "--state is not a valid DSH worktree session.");
    }
  }
  if (!basename(sessionRoot).startsWith(SESSION_PREFIX)) {
    throw new WorktreeError("invalid_input", "--state is outside a DSH worktree session.");
  }
  assertInside(sessionRoot, resolvedState);
  assertInside(sessionRoot, worktreeRoot);
  assertInside(sessionRoot, baselinePatchPath);
  assertInside(sessionRoot, reviewPatchPath);
  assertInside(worktreeRoot, worktreeCwd);
  return {
    ...validSession,
    reviewAttempt: validSession.reviewAttempt ?? (validSession.phase === "review_ready" ? 1 : 0),
    retryOf: validSession.retryOf ?? null,
    includedIgnoredArtifacts:
      includedIgnoredArtifacts === null
        ? null
        : {
            ...includedIgnoredArtifacts,
            manifestSha256: includedIgnoredArtifacts.manifestSha256 ?? null,
          },
    statePath: resolvedState,
  };
}

export async function sessionFileExists(statePath: string): Promise<boolean> {
  try {
    await lstat(statePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
